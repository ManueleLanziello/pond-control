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
import { RoleRuntimeManager } from './src/role-runtime-manager.js';
import {
  isRuntimeEligible, isRuntimeEligiblePlug, requireSupportedDeviceModel, requireSupportedPlugModel, runtimeConfiguration,
  runtimePlugConfiguration, supportedCameraModel, supportedPlugModel, supportedSensorModel,
  SUPPORTED_CAMERA_MODELS, SUPPORTED_PLUG_MODELS, SUPPORTED_SENSOR_MODELS,
} from './src/supported-device-catalog.js';

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

function dewinConfiguredFromEnvironment() {
  return Boolean(
    process.env.TUYA_CLIENT_ID?.trim()
    && process.env.TUYA_CLIENT_SECRET?.trim()
    && process.env.TUYA_DEVICE_ID?.trim(),
  );
}

function legacyRuntimeManager(runtime, role, emptySnapshot) {
  return {
    reconcile: async () => {}, has: () => true, recordIdForRole: () => null,
    snapshot: async () => runtime.snapshot(), history: async (_role, date) => runtime.history(date),
    imagePath: async () => runtime.imagePath(), start: async () => runtime.start(), stop: async () => runtime.stop(),
    close: async () => runtime.stop?.(), emptySnapshot,
  };
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
  sensorRuntimeManager = null,
  cameraRuntimeManager = null,
  hardwareStore = new HardwareRegistryStore({
    filePath: DEFAULT_HARDWARE_FILE,
      defaults: defaultHardwareRegistry({
      deviceList, cameraIp: process.env.TAPO_CAMERA_IP, dewinDeviceId: process.env.TUYA_DEVICE_ID?.trim() || '', dewinConfigured: dewinConfiguredFromEnvironment(),
    }),
  }),
  verifyPlug = (candidate) => verifyTapoPlug(candidate, {
    ...credentialsFromEnvironment(), timeout: Number(process.env.TAPO_DEVICE_TIMEOUT_MS || 5000),
  }),
  verifyCamera = (candidate) => verifyTapoCamera(candidate, {
    pythonPath: defaultCameraPython(ROOT), probePath: path.join(ROOT, 'tools', 'c410_probe.py'),
  }),
  verifySensor = null,
} = {}) {
  const dynamicSensors = Boolean(sensorRuntimeManager); const dynamicCameras = Boolean(cameraRuntimeManager);
  verifySensor ||= async (candidate) => {
    requireSupportedDeviceModel('sensor', candidate.model);
    if (!dynamicSensors) {
      const snapshot = dewinService.snapshot();
      if (!snapshot?.available) throw new HardwareRegistryError('Nessuno snapshot Dewin valido disponibile.', 'CLOUD_SNAPSHOT_UNAVAILABLE');
      return { model: candidate.model, provider: 'Tuya Cloud', deviceId: snapshot.deviceId || candidate.tuyaDeviceId, online: snapshot.online, snapshotUpdatedAt: snapshot.updatedAt };
    }
    const service = createDewinServiceFromEnvironment({ deviceId: candidate.tuyaDeviceId });
    try { const snapshot = await service.refresh(); if (!snapshot.available) throw new HardwareRegistryError('Sensore Tuya non disponibile.', 'CLOUD_SNAPSHOT_UNAVAILABLE'); if (snapshot.deviceId !== candidate.tuyaDeviceId) throw new HardwareRegistryError('Il Device ID Tuya letto non corrisponde alla configurazione.', 'DEVICE_ID_MISMATCH'); return { model: candidate.model, provider: 'Tuya Cloud', deviceId: snapshot.deviceId, online: snapshot.online, snapshotUpdatedAt: snapshot.updatedAt }; }
    finally { service.stop(); }
  };
  const sensors = sensorRuntimeManager || legacyRuntimeManager(dewinService, 'pond_temperature', UNAVAILABLE_DEWIN_SERVICE.snapshot);
  const cameras = cameraRuntimeManager || legacyRuntimeManager(cameraManager, 'pond_camera', UNAVAILABLE_CAMERA_MANAGER.snapshot);
  async function reconcileRuntime() {
    const registry = await hardwareStore.read();
    const runtimeDevices = registry.plugs.filter(isRuntimeEligiblePlug).map(runtimePlugConfiguration);
    if (typeof deviceManager.reconcileDevices === 'function') deviceManager.reconcileDevices(runtimeDevices);
    if (typeof roleStore.reconcileDevices === 'function') await roleStore.reconcileDevices(
      [...registry.plugs, ...registry.sensors, ...registry.cameras], hardwareStore.legacyRoleAssignments,
    );
    const storedAssignments = await roleStore.read();
    const assignments = typeof roleStore.reconcileDevices === 'function'
      ? storedAssignments : { ...hardwareStore.legacyRoleAssignments, ...storedAssignments };
    await sensors.reconcile(registry.sensors.filter((record) => isRuntimeEligible('sensor', record)).map((record) => runtimeConfiguration('sensor', record)), assignments);
    await cameras.reconcile(registry.cameras.filter((record) => isRuntimeEligible('camera', record)).map((record) => runtimeConfiguration('camera', record)), assignments);
    return { registry, assignments };
  }
  const runtimeHasDevice = (id) => typeof deviceManager.hasDevice === 'function'
    ? deviceManager.hasDevice(id)
    : deviceManager.snapshots().some((device) => device.id === id);
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
        const { registry, assignments } = await reconcileRuntime(); const deviceId = Object.keys(assignments).find((id) => assignments[id] === 'pond_camera');
        const configured = registry.cameras.find((item) => item.id === deviceId);
        const snapshot = await cameras.snapshot('pond_camera');
        sendJson(response, 200, dynamicCameras ? { ...snapshot, deviceId: deviceId || null, alias: configured?.alias || null, model: configured?.model || null } : snapshot);
        return;
      }
      if (url.pathname === '/api/camera/image') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end();
          return;
        }
        await reconcileRuntime(); await sendCameraImage(response, await cameras.imagePath('pond_camera'));
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
          await reconcileRuntime(); sendJson(response, 200, payload.active ? await cameras.start('pond_camera') : await cameras.stop('pond_camera'));
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
        const { registry, assignments: roleAssignments } = await reconcileRuntime();
        const liveDevices = new Map(deviceManager.snapshots().map((device) => [device.id, device]));
        const result = registry.plugs.map((plug) => ({
          ...(liveDevices.get(plug.id) || {
            id: plug.id, name: plug.alias, model: plug.model, ip: plug.ip,
            type: 'SMART.TAPOPLUG', state: null, rssi: null, protocol: plug.protocol,
            online: false, communicationDegraded: false, consecutiveFailures: 0, lastReadAt: null,
          }),
          role: roleAssignments[plug.id] || 'none',
          runtimeActive: liveDevices.has(plug.id),
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
        const { registry, assignments } = await reconcileRuntime(); const deviceId = Object.keys(assignments).find((id) => assignments[id] === 'pond_temperature');
        const configured = registry.sensors.find((item) => item.id === deviceId);
        const snapshot = await sensors.snapshot('pond_temperature');
        sendJson(response, 200, dynamicSensors ? { ...snapshot, hardwareId: deviceId || null, alias: configured?.alias || null, model: configured?.model || null } : snapshot);
        return;
      }
      if (url.pathname === '/api/dewin/history') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end();
          return;
        }
        try {
          await reconcileRuntime(); sendJson(response, 200, await sensors.history('pond_temperature', url.searchParams.get('date') || undefined));
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
        const { registry, assignments } = await reconcileRuntime();
        const livePlugs = new Map(deviceManager.snapshots().map((device) => [device.id, device]));
        const currentSensorId = Object.keys(assignments).find((id) => assignments[id] === 'pond_temperature');
        const currentSensorSnapshot = currentSensorId ? await sensors.snapshot('pond_temperature') : null;
        const currentCameraId = Object.keys(assignments).find((id) => assignments[id] === 'pond_camera');
        const currentCameraSnapshot = currentCameraId ? await cameras.snapshot('pond_camera') : null;
        sendJson(response, 200, {
          plugs: registry.plugs.map((plug) => ({
            ...plug,
            role: assignments[plug.id] || 'none',
            runtimeSupported: Boolean(supportedPlugModel(plug.model)),
            runtimeActive: livePlugs.has(plug.id),
            online: livePlugs.get(plug.id)?.online || false,
            rssi: livePlugs.get(plug.id)?.rssi ?? null,
            state: livePlugs.get(plug.id)?.state ?? null,
          })),
          sensors: registry.sensors.map((sensor) => ({
            ...sensor, role: assignments[sensor.id] || 'none', runtimeActive: sensors.has(sensor.id),
            online: sensor.id === currentSensorId ? Boolean(currentSensorSnapshot?.online) : false,
            rssi: null,
          })),
          cameras: registry.cameras.map((camera) => ({
            ...camera, role: assignments[camera.id] || 'none', runtimeActive: cameras.has(camera.id),
            online: camera.id === currentCameraId && Boolean(currentCameraSnapshot?.configured) && currentCameraSnapshot?.status !== 'ERROR', rssi: null,
          })),
          roles: {
            plugs: VALID_DEVICE_ROLES,
            sensors: SENSOR_ROLES,
            cameras: CAMERA_ROLES,
          },
          supportedPlugModels: SUPPORTED_PLUG_MODELS,
          supportedSensorModels: SUPPORTED_SENSOR_MODELS,
          supportedCameraModels: SUPPORTED_CAMERA_MODELS,
        });
        return;
      }
      const verifyHardwareMatch = url.pathname.match(/^\/api\/hardware\/(plugs|sensors|cameras)\/verify$/);
      if (verifyHardwareMatch) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Metodo non consentito' });
          return;
        }
        try {
          const payload = await readJsonRequest(request, 4096);
          const category = { plugs: 'plug', sensors: 'sensor', cameras: 'camera' }[verifyHardwareMatch[1]];
          requireSupportedDeviceModel(category, payload.model);
          const detected = await (verifyHardwareMatch[1] === 'plugs' ? verifyPlug(payload) : verifyHardwareMatch[1] === 'sensors' ? verifySensor(payload) : verifyCamera(payload));
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
            requireSupportedDeviceModel({ plugs: 'plug', sensors: 'sensor', cameras: 'camera' }[kind], payload.model);
            if (payload.role && payload.role !== 'none') {
              throw new HardwareRegistryError('I nuovi dispositivi restano senza ruolo finché non sono verificati.', 'RUNTIME_ACTIVATION_REQUIRED');
            }
            const detected = kind === 'sensors' ? await verifySensor(payload) : kind === 'cameras' ? await verifyCamera(payload) : null;
            const created = await hardwareStore.create(kind, payload);
            const device = detected ? await hardwareStore.markVerified(kind, created.id, detected) : created;
            await reconcileRuntime();
            sendJson(response, 201, { device: { ...device, role: 'none' }, detected });
            return;
          }
          if (!encodedId) throw new HardwareRegistryError('ID dispositivo mancante.', 'MISSING_ID');
          const id = decodeURIComponent(encodedId);
          if (action === 'verify' && request.method === 'POST') {
            const registry = await hardwareStore.read();
            const configured = registry[kind].find((record) => record.id === id);
            if (!configured) throw new HardwareRegistryError('Dispositivo non trovato.', 'NOT_FOUND');
            let detected;
            if (kind === 'sensors') {
              detected = await verifySensor(configured);
            } else {
              detected = await (kind === 'plugs' ? verifyPlug(configured) : verifyCamera(configured));
            }
            const device = await hardwareStore.markVerified(kind, id, detected);
            await reconcileRuntime();
            sendJson(response, 200, { verified: true, device, detected });
            return;
          }
          if (request.method === 'PUT') {
            const payload = await readJsonRequest(request, 4096);
            const previousRole = payload.role !== undefined
              ? (await roleStore.read())[id] || 'none'
              : null;
            const device = await hardwareStore.update(kind, id, payload);
            await reconcileRuntime();
            if (payload.role !== undefined && payload.role !== previousRole) {
                const active = kind === 'plugs' ? runtimeHasDevice(id) : kind === 'sensors' ? sensors.has(id) : cameras.has(id);
                if (payload.role !== 'none' && !active) {
                  throw new HardwareRegistryError(
                    'Verificare e attivare il dispositivo prima di assegnare un ruolo operativo.',
                    'RUNTIME_DEVICE_INACTIVE',
                  );
                }
                await roleStore.assign(id, payload.role);
            }
            await reconcileRuntime(); sendJson(response, 200, { device: { ...device, role: payload.role ?? previousRole ?? 'none' } });
            return;
          }
          if (request.method === 'DELETE') {
            if (((await roleStore.read())[id] || 'none') !== 'none') {
              throw new HardwareRegistryError('Liberare il ruolo prima di rimuovere il dispositivo.', 'ROLE_ASSIGNED');
            }
            const removed = await hardwareStore.remove(kind, id);
            await reconcileRuntime();
            sendJson(response, 200, { removed });
            return;
          }
          sendJson(response, 405, { error: 'Metodo non consentito' });
        } catch (requestError) {
          const status = requestError.code === 'NOT_IMPLEMENTED'
            ? 501
            : requestError.code === 'CLOUD_SNAPSHOT_UNAVAILABLE' ? 409 : 400;
          sendJson(response, status, {
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
          await reconcileRuntime();
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
          await reconcileRuntime();
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
          const id = decodeURIComponent(roleMatch[1]);
          await reconcileRuntime();
          if (payload.role !== 'none' && !runtimeHasDevice(id)) {
            throw new HardwareRegistryError(
              'Verificare e attivare la presa prima di assegnare un ruolo operativo.',
              'RUNTIME_DEVICE_INACTIVE',
            );
          }
          const assignments = await roleStore.assign(id, payload.role);
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
    } catch (unhandledError) {
      if (process.env.POND_DEBUG_ERRORS === '1') console.error(unhandledError);
      sendJson(response, 500, { error: 'Errore interno del server' });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    credentialsFromEnvironment();
    const hardwareStore = new HardwareRegistryStore({
      filePath: DEFAULT_HARDWARE_FILE,
      defaults: defaultHardwareRegistry({
        deviceList: defaultDevices,
        cameraIp: process.env.TAPO_CAMERA_IP,
        dewinDeviceId: process.env.TUYA_DEVICE_ID?.trim() || '',
        dewinConfigured: dewinConfiguredFromEnvironment(),
      }),
    });
    const startupRegistry = await hardwareStore.read();
    const allHardware = [...startupRegistry.plugs, ...startupRegistry.sensors, ...startupRegistry.cameras];
    const roleStore = new DeviceRoleStore({ filePath: DEFAULT_ROLE_FILE, deviceList: allHardware });
    await roleStore.reconcileDevices(allHardware, hardwareStore.legacyRoleAssignments);
    await hardwareStore.completePendingMigration(startupRegistry);
    const deviceManager = new DeviceManager({
      deviceList: startupRegistry.plugs.filter(isRuntimeEligiblePlug).map(runtimePlugConfiguration),
      createClient: createConfiguredClient,
      log: info,
    });
    const weatherService = new WeatherService({ config: WEATHER_CONFIG, log: info, logError: error });
    const sensorRuntimeManager = new RoleRuntimeManager({ category: 'sensor', autoStart: true,
      emptySnapshot: UNAVAILABLE_DEWIN_SERVICE.snapshot,
      createRuntime: (record, signature) => createDewinServiceFromEnvironment({ deviceId: record.tuyaDeviceId,
        historyStore: new DewinHistoryStore({ directory: path.join(ROOT, 'data', 'dewin-history', record.id, signature) }), log: info, logError: error }),
    });
    const cameraRuntimeManager = new RoleRuntimeManager({ category: 'camera', emptySnapshot: UNAVAILABLE_CAMERA_MANAGER.snapshot,
      createRuntime: (record, signature) => new CameraManager({ ip: record.ip, pythonPath: defaultCameraPython(ROOT),
        workerPath: path.join(ROOT, 'camera', 'c410_worker.py'), outputDirectory: path.join(ROOT, 'data', 'camera', record.id, signature) }),
    });
    const startupAssignments = await roleStore.read();
    await sensorRuntimeManager.reconcile(startupRegistry.sensors.filter((record) => isRuntimeEligible('sensor', record)).map((record) => runtimeConfiguration('sensor', record)), startupAssignments);
    await cameraRuntimeManager.reconcile(startupRegistry.cameras.filter((record) => isRuntimeEligible('camera', record)).map((record) => runtimeConfiguration('camera', record)), startupAssignments);
    const server = createPondServer({ roleStore, deviceManager, weatherService, sensorRuntimeManager, cameraRuntimeManager, hardwareStore });
    const safetyMonitor = createSafetyMonitor({
      deviceList: [],
      roleStore,
      deviceManager,
      log: info,
      logError: error,
    });
    server.listen(3000, '0.0.0.0', () => {
      info('Pond Control disponibile su http://localhost:3000');
      void deviceManager.startPolling(() => safetyMonitor.runCycle());
      void weatherService.start();
    });
    server.on('close', () => {
      deviceManager.stop();
      weatherService.stop();
      void sensorRuntimeManager.close();
      void cameraRuntimeManager.close();
      info('Pond Control arrestato');
    });
    const shutdown = () => {
      deviceManager.stop();
      weatherService.stop();
      void sensorRuntimeManager.close();
      void cameraRuntimeManager.close();
      server.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (startupError) {
    error(`Pond Control startup failed: ${startupError.message}`);
    process.exitCode = 1;
  }
}
