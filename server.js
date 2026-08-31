import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { devices as defaultDevices } from './devices.js';
import { WEATHER_CONFIG } from './config/weather.js';
import { CameraControlError, CameraManager, defaultCameraPython } from './src/camera-manager.js';
import { DeviceManager } from './src/device-manager.js';
import { DeviceRoleStore, VALID_DEVICE_ROLES } from './src/device-roles.js';
import { createDewinServiceFromEnvironment } from './src/dewin-service.js';
import { DewinHistoryStore } from './src/dewin-history-store.js';
import { createHeaterController, HeaterControlError } from './src/heater-control.js';
import {
  CAMERA_ROLES, defaultHardwareRegistry, HardwareRegistryError, HardwareRegistryStore, SENSOR_ROLES,
} from './src/hardware-registry.js';
import { verifyTapoCamera, verifyTapoPlug } from './src/hardware-verifier.js';
import { KlapV2Client } from './src/klap/client.js';
import { error, info } from './src/logger.js';
import { createPumpController, PumpControlError } from './src/pump-control.js';
import { createSafetyMonitor } from './src/safety-monitor.js';
import { TpapClient } from './src/tpap/client.js';
import { WeatherService } from './src/weather-service.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(ROOT, '.env'));
const PUBLIC_ROOT = path.join(ROOT, 'public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/camera-view.js', ['camera-view.js', 'text/javascript; charset=utf-8']],
  ['/pwa.js', ['pwa.js', 'text/javascript; charset=utf-8']],
  ['/service-worker.js', ['service-worker.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/dashboard-model.js', ['dashboard-model.js', 'text/javascript; charset=utf-8']],
  ['/dewin-view.js', ['dewin-view.js', 'text/javascript; charset=utf-8']],
  ['/temperature-chart.js', ['temperature-chart.js', 'text/javascript; charset=utf-8']],
  ['/heater-control.js', ['heater-control.js', 'text/javascript; charset=utf-8']],
  ['/pump-control.js', ['pump-control.js', 'text/javascript; charset=utf-8']],
  ['/weather-icons.js', ['weather-icons.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/settings', ['settings.html', 'text/html; charset=utf-8']],
  ['/settings.html', ['settings.html', 'text/html; charset=utf-8']],
  ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
  ['/icons/heater.svg', ['icons/heater.svg', 'image/svg+xml']],
  ['/icons/history.svg', ['icons/history.svg', 'image/svg+xml']],
  ['/icons/battery.svg', ['icons/battery.svg', 'image/svg+xml']],
  ['/icons/cloud.svg', ['icons/cloud.svg', 'image/svg+xml']],
  ['/icons/network.svg', ['icons/network.svg', 'image/svg+xml']],
  ['/icons/p100m.svg', ['icons/p100m.svg', 'image/svg+xml']],
  ['/icons/p105.svg', ['icons/p105.svg', 'image/svg+xml']],
  ['/icons/pond.svg', ['icons/pond.svg', 'image/svg+xml']],
  ['/icons/pond-192.png', ['icons/pond-192.png', 'image/png']],
  ['/icons/pond-512.png', ['icons/pond-512.png', 'image/png']],
  ['/icons/power.svg', ['icons/power.svg', 'image/svg+xml']],
  ['/icons/poweroff.svg', ['icons/poweroff.svg', 'image/svg+xml']],
  ['/icons/poweron.svg', ['icons/poweron.svg', 'image/svg+xml']],
  ['/icons/pump.svg', ['icons/pump.svg', 'image/svg+xml']],
  ['/icons/rain.svg', ['icons/rain.svg', 'image/svg+xml']],
  ['/icons/settings.svg', ['icons/settings.svg', 'image/svg+xml']],
  ['/icons/shield.svg', ['icons/shield.svg', 'image/svg+xml']],
  ['/icons/snow.svg', ['icons/snow.svg', 'image/svg+xml']],
  ['/icons/storm.svg', ['icons/storm.svg', 'image/svg+xml']],
  ['/icons/sun.svg', ['icons/sun.svg', 'image/svg+xml']],
  ['/icons/thermometer.svg', ['icons/thermometer.svg', 'image/svg+xml']],
  ['/icons/termos.svg', ['icons/termos.svg', 'image/svg+xml']],
  ['/icons/termotime.svg', ['icons/termotime.svg', 'image/svg+xml']],
  ['/icons/umidity.svg', ['icons/umidity.svg', 'image/svg+xml']],
  ['/icons/update.svg', ['icons/update.svg', 'image/svg+xml']],
  ['/icons/weather.svg', ['icons/weather.svg', 'image/svg+xml']],
  ['/icons/wind.svg', ['icons/wind.svg', 'image/svg+xml']],
  ['/icons/wifi.svg', ['icons/wifi.svg', 'image/svg+xml']],
]);
const DEFAULT_ROLE_FILE = path.join(ROOT, 'config', 'device-roles.json');
const DEFAULT_HARDWARE_FILE = path.join(ROOT, 'data', 'config', 'hardware.json');
const UNAVAILABLE_DEWIN_SERVICE = Object.freeze({
  snapshot: () => ({ available: false, online: false, stale: true, datapoints: [] }),
  history: async (date) => ({ date: date ?? null, samples: [] }),
  start: async () => {},
  stop: () => {},
});
const UNAVAILABLE_CAMERA_MANAGER = Object.freeze({
  snapshot: async () => ({
    configured: false, live: false, starting: false, status: 'NOT_CONFIGURED',
    updatedAt: null, imageAvailable: false, imageVersion: null, error: null,
    safetyTimeoutSeconds: 1800,
  }),
  imagePath: async () => null,
  start: async () => { throw new CameraControlError('Telecamera non configurata.'); },
  stop: async () => ({ configured: false, live: false, status: 'NOT_CONFIGURED' }),
});

function credentialsFromEnvironment() {
  const username = process.env.TAPO_USERNAME?.trim();
  const password = process.env.TAPO_PASSWORD;
  if (!username || !password) throw new Error('Credenziali Tapo non disponibili nel processo server.');
  return { username, password };
}

export function createConfiguredClient(device) {
  const credentials = credentialsFromEnvironment();
  const options = {
    ip: device.ip,
    ...credentials,
    timeout: Number(process.env.TAPO_DEVICE_TIMEOUT_MS || 5000),
  };
  const client = device.protocol === 'tpap'
    ? new TpapClient(options)
    : device.protocol === 'klap'
      ? new KlapV2Client(options)
      : null;
  if (!client) throw new Error(`Protocollo non supportato: ${device.protocol}`);
  return client;
}

async function readJsonRequest(request, maxBytes = 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Payload troppo grande.');
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Payload non valido.');
  return payload;
}

export function createDeviceStatusLogger(log = info) {
  const previousStates = new Map();
  return (deviceResults) => {
    for (const device of deviceResults) {
      const state = device.online ? 'ONLINE' : 'OFFLINE';
      const previous = previousStates.get(device.id);
      if (previous === undefined) log(`[${device.model}] ${device.name} - ${state}`);
      else if (previous !== state) log(`[${device.model}] ${state}`);
      previousStates.set(device.id, state);
    }
  };
}

function sendJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  response.end(data);
}

async function serveStatic(request, response, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return true;
  }
  const [filename, contentType] = entry;
  const content = await readFile(path.join(PUBLIC_ROOT, filename));
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : content);
  return true;
}

async function sendCameraImage(response, filename) {
  if (!filename) {
    sendJson(response, 404, { error: 'Nessuna immagine camera disponibile.' });
    return;
  }
  const content = await readFile(filename);
  response.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': content.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(content);
}

export function createPondServer({
  deviceList = defaultDevices,
  roleStore = new DeviceRoleStore({ filePath: DEFAULT_ROLE_FILE, deviceList }),
  deviceManager = new DeviceManager({ deviceList, createClient: createConfiguredClient, log: info }),
  controlHeaterState,
  controlPumpState,
  weatherService = new WeatherService({ config: WEATHER_CONFIG, log: info, logError: error }),
  dewinService = UNAVAILABLE_DEWIN_SERVICE,
  cameraManager = UNAVAILABLE_CAMERA_MANAGER,
  hardwareStore = new HardwareRegistryStore({
    filePath: DEFAULT_HARDWARE_FILE,
    defaults: defaultHardwareRegistry({ deviceList, cameraIp: process.env.TAPO_CAMERA_IP }),
  }),
  verifyPlug = (candidate) => verifyTapoPlug(candidate, {
    ...credentialsFromEnvironment(), timeout: Number(process.env.TAPO_DEVICE_TIMEOUT_MS || 5000),
  }),
  verifyCamera = (candidate) => verifyTapoCamera(candidate, {
    pythonPath: defaultCameraPython(ROOT), probePath: path.join(ROOT, 'tools', 'c410_probe.py'),
  }),
} = {}) {
  const runtimeDeviceIds = new Set(deviceList.map((device) => device.id));
  const controlHeater = controlHeaterState || createHeaterController({
    deviceList,
    roleStore,
    deviceManager,
    log: info,
  });
  const controlPump = controlPumpState || createPumpController({
    deviceList,
    roleStore,
    deviceManager,
    log: info,
  });
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname === '/api/camera/status') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end();
          return;
        }
        sendJson(response, 200, await cameraManager.snapshot());
        return;
      }
      if (url.pathname === '/api/camera/image') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end();
          return;
        }
        await sendCameraImage(response, await cameraManager.imagePath());
        return;
      }
      if (url.pathname === '/api/camera/live') {
        if (request.method !== 'PUT') {
          response.writeHead(405, { Allow: 'PUT' });
          response.end();
          return;
        }
        try {
          const payload = await readJsonRequest(request);
          if (Object.keys(payload).length !== 1 || typeof payload.active !== 'boolean') {
            throw new CameraControlError('Specificare active=true oppure active=false.', 400, 'INVALID_CAMERA_STATE');
          }
          sendJson(response, 200, payload.active ? await cameraManager.start() : await cameraManager.stop());
        } catch (cameraError) {
          sendJson(response, cameraError instanceof CameraControlError ? cameraError.status : 500, {
            ok: false,
            code: cameraError instanceof CameraControlError ? cameraError.code : 'CAMERA_ERROR',
            error: cameraError instanceof CameraControlError ? cameraError.message : 'Comando telecamera non riuscito.',
          });
        }
        return;
      }
      if (url.pathname === '/api/devices') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end();
          return;
        }
        const roleAssignments = await roleStore.read();
        const result = deviceManager.snapshots().map((device) => ({
          ...device,
          role: roleAssignments[device.id] || 'none',
        }));
        sendJson(response, 200, { devices: result });
        return;
      }
      if (url.pathname === '/api/weather') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end();
          return;
        }
        sendJson(response, 200, weatherService.snapshot());
        return;
      }
      if (url.pathname === '/api/dewin') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end();
          return;
        }
        sendJson(response, 200, dewinService.snapshot());
        return;
      }
      if (url.pathname === '/api/dewin/history') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end();
          return;
        }
        try {
          sendJson(response, 200, await dewinService.history(url.searchParams.get('date') || undefined));
        } catch (historyError) {
          const status = historyError instanceof RangeError ? 400 : 500;
          sendJson(response, status, { error: status === 400 ? historyError.message : 'Storico Dewin non disponibile' });
        }
        return;
      }
      if (url.pathname === '/api/device-roles') {
        if (request.method === 'GET') {
          sendJson(response, 200, {
            validRoles: VALID_DEVICE_ROLES,
            assignments: await roleStore.read(),
          });
          return;
        }
        sendJson(response, 405, { error: 'Metodo non consentito' });
        return;
      }
      if (url.pathname === '/api/hardware') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'Metodo non consentito' });
          return;
        }
        const [registry, assignments] = await Promise.all([hardwareStore.read(), roleStore.read()]);
        const livePlugs = new Map(deviceManager.snapshots().map((device) => [device.id, device]));
        sendJson(response, 200, {
          plugs: registry.plugs.map((plug) => ({
            ...plug,
            role: assignments[plug.id] || 'none',
            runtimeSupported: runtimeDeviceIds.has(plug.id),
            online: livePlugs.get(plug.id)?.online || false,
            rssi: livePlugs.get(plug.id)?.rssi ?? null,
            state: livePlugs.get(plug.id)?.state ?? null,
          })),
          sensors: registry.sensors.map((sensor) => ({ ...sensor, online: false, rssi: null })),
          cameras: registry.cameras.map((camera) => ({
            ...camera, online: camera.verificationStatus === 'verified', rssi: null,
          })),
          roles: {
            plugs: VALID_DEVICE_ROLES,
            sensors: SENSOR_ROLES,
            cameras: CAMERA_ROLES,
          },
        });
        return;
      }
      const verifyHardwareMatch = url.pathname.match(/^\/api\/hardware\/(plugs|cameras)\/verify$/);
      if (verifyHardwareMatch) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Metodo non consentito' });
          return;
        }
        try {
          const payload = await readJsonRequest(request, 4096);
          const detected = await (verifyHardwareMatch[1] === 'plugs' ? verifyPlug(payload) : verifyCamera(payload));
          sendJson(response, 200, { verified: true, detected });
        } catch (requestError) {
          sendJson(response, 400, { verified: false, code: requestError.code || 'VERIFY_FAILED', error: requestError.message });
        }
        return;
      }
      const hardwareMatch = url.pathname.match(/^\/api\/hardware\/(plugs|sensors|cameras)(?:\/([^/]+))?(?:\/(verify))?$/);
      if (hardwareMatch) {
        const [, kind, encodedId, action] = hardwareMatch;
        try {
          if (!encodedId && request.method === 'POST') {
            const payload = await readJsonRequest(request, 4096);
            if (kind === 'plugs' && payload.role && payload.role !== 'none') {
              throw new HardwareRegistryError('Le nuove prese restano senza ruolo finché non sono attivate nel runtime.', 'RUNTIME_ACTIVATION_REQUIRED');
            }
            const detected = kind === 'plugs'
              ? await verifyPlug(payload)
              : kind === 'cameras'
                ? await verifyCamera(payload)
                : null;
            const created = await hardwareStore.create(kind, payload);
            const device = detected
              ? await hardwareStore.markVerified(kind, created.id, detected)
              : created;
            sendJson(response, 201, { device, detected });
            return;
          }
          if (!encodedId) throw new HardwareRegistryError('ID dispositivo mancante.', 'MISSING_ID');
          const id = decodeURIComponent(encodedId);
          if (action === 'verify' && request.method === 'POST') {
            if (kind === 'sensors') throw new HardwareRegistryError('Verifica sensori non ancora disponibile.', 'NOT_IMPLEMENTED');
            const registry = await hardwareStore.read();
            const configured = registry[kind].find((record) => record.id === id);
            if (!configured) throw new HardwareRegistryError('Dispositivo non trovato.', 'NOT_FOUND');
            const detected = await (kind === 'plugs' ? verifyPlug(configured) : verifyCamera(configured));
            const device = await hardwareStore.markVerified(kind, id, detected);
            sendJson(response, 200, { verified: true, device, detected });
            return;
          }
          if (request.method === 'PUT') {
            const payload = await readJsonRequest(request, 4096);
            if (kind === 'plugs' && payload.role && payload.role !== 'none' && !runtimeDeviceIds.has(id)) {
              throw new HardwareRegistryError(
                'La presa è registrata ma non è ancora supportata dal runtime corrente.',
                'RUNTIME_DEVICE_UNSUPPORTED',
              );
            }
            const device = await hardwareStore.update(kind, id, payload);
            if (kind === 'plugs' && payload.role !== undefined) await roleStore.assign(id, payload.role);
            sendJson(response, 200, { device });
            return;
          }
          if (request.method === 'DELETE') {
            if (kind === 'plugs' && ((await roleStore.read())[id] || 'none') !== 'none') {
              throw new HardwareRegistryError('Liberare il ruolo prima di rimuovere la presa.', 'ROLE_ASSIGNED');
            }
            sendJson(response, 200, { removed: await hardwareStore.remove(kind, id) });
            return;
          }
          sendJson(response, 405, { error: 'Metodo non consentito' });
        } catch (requestError) {
          sendJson(response, requestError.code === 'NOT_IMPLEMENTED' ? 501 : 400, {
            code: requestError.code || 'INVALID_HARDWARE_REQUEST', error: requestError.message,
          });
        }
        return;
      }
      if (url.pathname === '/api/functions/heater/state') {
        if (request.method !== 'PUT') {
          sendJson(response, 405, { error: 'Metodo non consentito' });
          return;
        }
        try {
          const payload = await readJsonRequest(request);
          if (Object.keys(payload).length !== 1 || !['ON', 'OFF'].includes(payload.state)) {
            throw new HeaterControlError('Stato non valido: usare ON oppure OFF.', 400, 'INVALID_STATE');
          }
          sendJson(response, 200, await controlHeater(payload.state));
        } catch (requestError) {
          const status = requestError instanceof HeaterControlError ? requestError.status : 400;
          sendJson(response, status, {
            ok: false,
            code: requestError instanceof HeaterControlError ? requestError.code : 'INVALID_REQUEST',
            message: requestError instanceof HeaterControlError ? requestError.message : 'Richiesta non valida.',
            error: requestError instanceof HeaterControlError ? requestError.message : 'Richiesta non valida.',
          });
        }
        return;
      }
      if (url.pathname === '/api/functions/pump/state') {
        if (request.method !== 'PUT') {
          sendJson(response, 405, { error: 'Metodo non consentito' });
          return;
        }
        try {
          const payload = await readJsonRequest(request);
          if (Object.keys(payload).length !== 1 || !['ON', 'OFF'].includes(payload.state)) {
            throw new PumpControlError('Stato non valido: usare ON oppure OFF.', 400, 'INVALID_STATE');
          }
          sendJson(response, 200, await controlPump(payload.state));
        } catch (requestError) {
          const status = requestError instanceof PumpControlError ? requestError.status : 400;
          const message = requestError instanceof PumpControlError
            ? requestError.message
            : 'Richiesta non valida.';
          sendJson(response, status, {
            ok: false,
            code: requestError instanceof PumpControlError ? requestError.code : 'INVALID_REQUEST',
            message,
            error: message,
          });
        }
        return;
      }
      const roleMatch = url.pathname.match(/^\/api\/device-roles\/([^/]+)$/);
      if (roleMatch) {
        if (request.method !== 'PUT') {
          sendJson(response, 405, { error: 'Metodo non consentito' });
          return;
        }
        let payload;
        try {
          payload = await readJsonRequest(request);
          const assignments = await roleStore.assign(decodeURIComponent(roleMatch[1]), payload.role);
          sendJson(response, 200, { assignments });
        } catch (requestError) {
          sendJson(response, 400, { error: requestError.message });
        }
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Endpoint non trovato' });
        return;
      }
      if (await serveStatic(request, response, url.pathname)) return;
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Non trovato');
    } catch {
      sendJson(response, 500, { error: 'Errore interno del server' });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    credentialsFromEnvironment();
    const roleStore = new DeviceRoleStore({ filePath: DEFAULT_ROLE_FILE, deviceList: defaultDevices });
    const hardwareStore = new HardwareRegistryStore({
      filePath: DEFAULT_HARDWARE_FILE,
      defaults: defaultHardwareRegistry({ deviceList: defaultDevices, cameraIp: process.env.TAPO_CAMERA_IP }),
    });
    await hardwareStore.read();
    const deviceManager = new DeviceManager({
      deviceList: defaultDevices,
      createClient: createConfiguredClient,
      log: info,
    });
    const weatherService = new WeatherService({ config: WEATHER_CONFIG, log: info, logError: error });
    const cameraManager = new CameraManager({
      ip: process.env.TAPO_CAMERA_IP,
      pythonPath: defaultCameraPython(ROOT),
      workerPath: path.join(ROOT, 'camera', 'c410_worker.py'),
      outputDirectory: path.join(ROOT, 'data', 'camera'),
    });
    let dewinService = UNAVAILABLE_DEWIN_SERVICE;
    try {
      const historyStore = new DewinHistoryStore({ directory: path.join(ROOT, 'data', 'dewin-history') });
      dewinService = createDewinServiceFromEnvironment({ historyStore, log: info, logError: error });
    } catch (dewinConfigError) {
      error(`[DEWIN] servizio non configurato: ${dewinConfigError.message}`);
    }
    const server = createPondServer({ roleStore, deviceManager, weatherService, dewinService, cameraManager, hardwareStore });
    const safetyMonitor = createSafetyMonitor({
      deviceList: defaultDevices,
      roleStore,
      deviceManager,
      log: info,
      logError: error,
    });
    server.listen(3000, '0.0.0.0', () => {
      info('Pond Control disponibile su http://localhost:3000');
      void deviceManager.startPolling(() => safetyMonitor.runCycle());
      void weatherService.start();
      void dewinService.start();
    });
    server.on('close', () => {
      deviceManager.stop();
      weatherService.stop();
      dewinService.stop();
      void cameraManager.stop();
      info('Pond Control arrestato');
    });
    const shutdown = () => {
      deviceManager.stop();
      weatherService.stop();
      dewinService.stop();
      void cameraManager.stop();
      server.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (startupError) {
    error(`Pond Control startup failed: ${startupError.message}`);
    process.exitCode = 1;
  }
}
