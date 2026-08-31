import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export const CAMERA_SAFETY_TIMEOUT_MS = 30 * 60 * 1000;

export class CameraControlError extends Error {
  constructor(message, status = 503, code = 'CAMERA_UNAVAILABLE') {
    super(message);
    this.name = 'CameraControlError';
    this.status = status;
    this.code = code;
  }
}

export function defaultCameraPython(root, {
  env = process.env, platform = process.platform, pathExists = existsSync,
} = {}) {
  if (env.TAPO_CAMERA_PYTHON?.trim()) return env.TAPO_CAMERA_PYTHON.trim();
  const localPython = platform === 'win32'
    ? path.join(root, '.venv-camera', 'Scripts', 'python.exe')
    : path.join(root, '.venv-camera', 'bin', 'python');
  return pathExists(localPython) ? localPython : 'python';
}

export class CameraManager {
  constructor({
    ip,
    pythonPath,
    workerPath,
    outputDirectory,
    safetyTimeoutMs = CAMERA_SAFETY_TIMEOUT_MS,
    startTimeoutMs = 25_000,
    stopTimeoutMs = 8_000,
    spawnProcess = spawn,
  }) {
    this.ip = ip?.trim() || '';
    this.pythonPath = pythonPath;
    this.workerPath = workerPath;
    this.outputDirectory = outputDirectory;
    this.stopFile = path.join(outputDirectory, 'stop.signal');
    this.safetyTimeoutMs = safetyTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.lastError = '';
  }

  async snapshot() {
    let updatedAt = null;
    let imageVersion = null;
    try {
      const metadata = JSON.parse(await readFile(path.join(this.outputDirectory, 'metadata.json'), 'utf8'));
      updatedAt = metadata.updatedAt || null;
      const imageStats = await stat(path.join(this.outputDirectory, 'last-frame.jpg'));
      imageVersion = Math.trunc(imageStats.mtimeMs);
    } catch {
      // Nessuna immagine acquisita: stato valido prima del primo live.
    }
    return {
      configured: Boolean(this.ip),
      live: Boolean(this.child && this.ready),
      starting: Boolean(this.child && !this.ready),
      status: !this.ip ? 'NOT_CONFIGURED' : this.child && this.ready ? 'LIVE' : this.child ? 'STARTING' : this.lastError ? 'ERROR' : 'READY',
      updatedAt,
      imageAvailable: imageVersion !== null,
      imageVersion,
      error: this.lastError || null,
      safetyTimeoutSeconds: Math.round(this.safetyTimeoutMs / 1000),
    };
  }

  async imagePath() {
    const livePath = path.join(this.outputDirectory, 'live-frame.jpg');
    const stillPath = path.join(this.outputDirectory, 'last-frame.jpg');
    if (this.child) {
      try {
        await stat(livePath);
        return livePath;
      } catch {
        // Durante il risveglio mostra l'ultima immagine statica.
      }
    }
    try {
      await stat(stillPath);
      return stillPath;
    } catch {
      return null;
    }
  }

  async start() {
    if (!this.ip) throw new CameraControlError('TAPO_CAMERA_IP non configurato.', 503, 'CAMERA_NOT_CONFIGURED');
    if (this.startPromise) return this.startPromise;
    if (this.child) return this.snapshot();
    this.startPromise = this.#startWorker();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startWorker() {
    await mkdir(this.outputDirectory, { recursive: true });
    await unlink(this.stopFile).catch(() => {});
    this.lastError = '';
    this.ready = false;
    const child = this.spawnProcess(this.pythonPath, [
      this.workerPath,
      '--ip', this.ip,
      '--output-dir', this.outputDirectory,
      '--stop-file', this.stopFile,
      '--timeout-seconds', String(Math.round(this.safetyTimeoutMs / 1000)),
    ], {
      cwd: path.dirname(this.workerPath),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    let ready = false;
    let errorMessage = '';
    const output = readline.createInterface({ input: child.stdout });
    output.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        if (event.event === 'ready') {
          ready = true;
          this.ready = true;
        }
        if (event.event === 'error') errorMessage = String(event.message || 'Errore worker C410.');
      } catch {
        // Il worker di produzione emette solo JSON; righe estranee vengono ignorate.
      }
    });
    child.stderr.on('data', () => {});

    const waitForReady = new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (ready) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
      child.once('error', (workerError) => {
        clearInterval(interval);
        reject(new CameraControlError(`Worker C410 non avviabile: ${workerError.message}`));
      });
      child.once('exit', (code) => {
        clearInterval(interval);
        if (!ready) reject(new CameraControlError(errorMessage || `Worker C410 terminato con codice ${code}.`));
      });
    });
    let startTimerId;
    const startTimer = new Promise((_, reject) => {
      startTimerId = setTimeout(() => reject(new CameraControlError('Timeout durante il risveglio della C410.', 504, 'CAMERA_START_TIMEOUT')), this.startTimeoutMs);
    });

    child.once('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.ready = false;
      }
      if (errorMessage) this.lastError = errorMessage;
    });

    try {
      await Promise.race([waitForReady, startTimer]);
      return this.snapshot();
    } catch (startError) {
      this.lastError = startError.message;
      await this.stop();
      throw startError;
    } finally {
      clearTimeout(startTimerId);
    }
  }

  async stop() {
    const child = this.child;
    if (!child) return this.snapshot();
    await mkdir(this.outputDirectory, { recursive: true });
    await writeFile(this.stopFile, 'stop\n', { encoding: 'utf8', flag: 'w' });
    let stopTimer;
    try {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => {
          stopTimer = setTimeout(resolve, this.stopTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(stopTimer);
    }
    if (this.child === child) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await unlink(this.stopFile).catch(() => {});
    this.child = null;
    this.ready = false;
    return this.snapshot();
  }
}
