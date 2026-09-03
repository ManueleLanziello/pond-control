import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CameraManager, CAMERA_SAFETY_TIMEOUT_MS, defaultCameraPython } from '../src/camera-manager.js';

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {
    setImmediate(() => this.emit('exit', 0));
    return true;
  }
}

test('camera Python selection prefers environment, then project venv, then compatible fallback', () => {
  const root = path.join('C:', 'pond-control');
  assert.equal(defaultCameraPython(root, {
    env: { TAPO_CAMERA_PYTHON: 'C:\\Python\\python.exe' }, platform: 'win32', pathExists: () => true,
  }), 'C:\\Python\\python.exe');
  const local = defaultCameraPython(root, { env: {}, platform: 'win32', pathExists: () => true });
  assert.equal(local, path.join(root, '.venv-camera', 'Scripts', 'python.exe'));
  assert.equal(defaultCameraPython(root, { env: {}, platform: 'win32', pathExists: () => false }), 'python');
});

test('camera manager opens only one worker and stops it through the stop signal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-camera-manager-'));
  let spawnCount = 0;
  let worker;
  const manager = new CameraManager({
    ip: '192.0.2.8',
    pythonPath: 'python-test',
    workerPath: path.join(directory, 'worker.py'),
    outputDirectory: directory,
    startTimeoutMs: 1000,
    stopTimeoutMs: 100,
    spawnProcess: () => {
      spawnCount += 1;
      worker = new FakeWorker();
      setImmediate(() => worker.stdout.write('{"event":"ready"}\n'));
      return worker;
    },
  });
  try {
    const [first, second] = await Promise.all([manager.start(), manager.start()]);
    assert.equal(spawnCount, 1);
    assert.equal(first.live, true);
    assert.equal(second.live, true);
    const stopPromise = manager.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await readFile(path.join(directory, 'stop.signal'), 'utf8'), 'stop\n');
    worker.emit('exit', 0);
    const stopped = await stopPromise;
    assert.equal(stopped.live, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('successful media worker exposes the live JPEG as an available snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-camera-success-'));
  let worker;
  const manager = new CameraManager({
    ip: '192.0.2.11', pythonPath: 'python-test', workerPath: path.join(directory, 'worker.py'),
    outputDirectory: directory, startTimeoutMs: 1000,
    spawnProcess: () => {
      worker = new FakeWorker();
      setImmediate(() => void writeFile(path.join(directory, 'live-frame.jpg'), Buffer.alloc(2048, 1))
        .then(() => worker.stdout.write('{"event":"ready"}\n')));
      return worker;
    },
  });
  try {
    const status = await manager.start();
    assert.equal(status.live, true);
    assert.equal(status.imageAvailable, true);
    assert.equal(await manager.imagePath(), path.join(directory, 'live-frame.jpg'));
    worker.emit('exit', 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('worker exit without a JPEG reports FILE_NOT_CREATED', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-camera-empty-'));
  const manager = new CameraManager({
    ip: '192.0.2.11', pythonPath: 'python-test', workerPath: path.join(directory, 'worker.py'),
    outputDirectory: directory, startTimeoutMs: 1000,
    spawnProcess: () => {
      const worker = new FakeWorker();
      setImmediate(() => {
        worker.stdout.write('{"event":"stopped","frames":0}\n');
        worker.emit('exit', 0);
      });
      return worker;
    },
  });
  try {
    await assert.rejects(manager.start(), (error) => error.code === 'FILE_NOT_CREATED');
    assert.equal((await manager.snapshot()).errorCode, 'FILE_NOT_CREATED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing FFmpeg dependency is classified and stderr is redacted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-camera-dependency-'));
  const env = { TAPO_USERNAME: 'private-user', TAPO_PASSWORD: 'private-password' };
  const manager = new CameraManager({
    ip: '192.0.2.11', pythonPath: 'python-test', workerPath: path.join(directory, 'worker.py'),
    outputDirectory: directory, startTimeoutMs: 1000, env,
    spawnProcess: () => {
      const worker = new FakeWorker();
      setImmediate(() => {
        worker.stderr.write("ModuleNotFoundError: No module named 'imageio_ffmpeg' private-user private-password");
        worker.emit('exit', 1);
      });
      return worker;
    },
  });
  try {
    await assert.rejects(manager.start(), (error) => {
      assert.equal(error.code, 'FFMPEG_NOT_FOUND');
      assert.doesNotMatch(error.message, /private-user|private-password/);
      return true;
    });
    const status = await manager.snapshot();
    assert.equal(status.errorCode, 'FFMPEG_NOT_FOUND');
    assert.doesNotMatch(status.error, /private-user|private-password/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('camera worker and UI remain on-demand and enforce the safety timeout', async () => {
  const [worker, manager, ui, html, css] = await Promise.all([
    readFile(new URL('../camera/c410_worker.py', import.meta.url), 'utf8'),
    readFile(new URL('../src/camera-manager.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/camera-view.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/style.css', import.meta.url), 'utf8'),
  ]);
  assert.equal(CAMERA_SAFETY_TIMEOUT_MS, 30 * 60 * 1000);
  assert.match(worker, /StreamType\.Stream/);
  assert.match(worker, /fps=4/);
  assert.match(worker, /atomic_write\(args\.output_dir \/ "last-frame\.jpg"/);
  assert.match(worker, /code=classify_error\(error\)/);
  assert.doesNotMatch(worker, /setPrivacyMode|set[A-Z].*Config|RTSP|ONVIF/);
  assert.match(manager, /if \(this\.child\) return this\.snapshot\(\)/);
  assert.match(ui, /JSON\.stringify\(\{ active: !live \}\)/);
  assert.match(ui, /camera\.errorCode/);
  assert.match(ui, /if \(currentCamera\) applyState\(currentCamera\)/);
  assert.match(ui, /typeof camera\.assigned === 'boolean' \? camera/);
  assert.match(ui, /camera\.assigned === false \? 'Nessuna telecamera assegnata'/);
  const refreshFailure = ui.slice(ui.indexOf('async function refreshStatus'), ui.indexOf('async function toggleLive'));
  assert.doesNotMatch(refreshFailure.slice(refreshFailure.indexOf('catch')), /identity\.textContent|image\.removeAttribute/);
  assert.match(ui, /pagehide[\s\S]*?active: false/);
  assert.match(html, /id="camera-identity"[^>]*>Caricamento configurazione…</);
  assert.match(html, /id="camera-card"[\s\S]*?webcam\.svg[\s\S]*?Telecamera[\s\S]*?LIVESTREAM/);
  assert.match(css, /\.camera-media\s*\{[^}]*aspect-ratio:\s*16 \/ 9/);
});
