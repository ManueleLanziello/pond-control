export const POND_FUNCTIONS = Object.freeze([
  Object.freeze({ role: 'pump', title: 'Pompa Filtro Pond' }),
  Object.freeze({ role: 'heater', title: 'Riscaldatore Pond' }),
]);
export const DASHBOARD_REFRESH_FAILURE_THRESHOLD = 3;
export const DASHBOARD_SNAPSHOT_STORAGE_KEY = 'pond-control.dashboard-state.v2';
const DASHBOARD_DEVICE_FIELDS = Object.freeze(['id', 'name', 'configuredName', 'model', 'type', 'state', 'online', 'communicationDegraded', 'consecutiveFailures', 'lastReadAt', 'role', 'runtimeActive']);
const SENSOR_FIELDS = Object.freeze([
  'assigned', 'availability', 'hardwareId', 'alias', 'model', 'runtimeActive', 'available', 'online', 'stale', 'updatedAt',
  'externalProbeTemperature', 'ambientTemperature', 'ambientHumidity', 'batteryState',
  'temperatureCalibration', 'humidityCalibration', 'temperatureCorrection',
]);
const CAMERA_FIELDS = Object.freeze([
  'assigned', 'availability', 'deviceId', 'alias', 'model', 'runtimeActive', 'configured', 'live', 'starting', 'status',
  'updatedAt', 'imageAvailable', 'imageVersion', 'error', 'errorCode', 'safetyTimeoutSeconds',
]);

function pickFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]));
}

function mergeEntity(previous, incoming, complete) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return previous || null;
  if (complete || incoming.assigned === false) return incoming;
  return { ...(previous || {}), ...incoming };
}

function mergeDevices(previous, incoming, complete) {
  if (!Array.isArray(incoming)) {
    if (complete) throw new Error('Risposta API Dashboard non valida');
    return previous || [];
  }
  if (complete) return incoming;
  const merged = new Map((previous || []).map((device) => [device.id, device]));
  for (const device of incoming) if (device?.id) merged.set(device.id, { ...(merged.get(device.id) || {}), ...device });
  return [...merged.values()];
}

export function dashboardRefreshHealth(previousFailures, refreshSucceeded) {
  const failures = refreshSucceeded ? 0 : previousFailures + 1;
  return { failures, degraded: failures >= DASHBOARD_REFRESH_FAILURE_THRESHOLD };
}

export function buildDashboardFunctions(devices) {
  return POND_FUNCTIONS.map((pondFunction) => ({
    ...pondFunction,
    device: devices.find((device) => device.role === pondFunction.role) || null,
  }));
}

export function dashboardDevicesFromPayload(previousDevices, payload) {
  if (!Array.isArray(payload?.devices)) throw new Error('Risposta API non valida');
  return payload.devices;
}

export function dashboardStateFromPayload(previousState = {}, payload = {}) {
  const complete = payload.dashboardVersion === 2 && payload.complete === true;
  const validEntity = (value) => value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.assigned === 'boolean';
  if (complete && (!validEntity(payload.sensor) || !validEntity(payload.camera))) {
    throw new Error('Risposta API Dashboard non valida');
  }
  return {
    devices: mergeDevices(previousState.devices, payload.devices, complete),
    sensor: mergeEntity(previousState.sensor, payload.sensor, complete),
    camera: mergeEntity(previousState.camera, payload.camera, complete),
    sensorHistory: payload.sensorHistory || previousState.sensorHistory || null,
    outdoorTemperatures: payload.outdoorTemperatures || previousState.outdoorTemperatures || null,
  };
}

export function dashboardSnapshotPayload(payload, previousState = {}) {
  const state = dashboardStateFromPayload(previousState, payload);
  return {
    cacheVersion: 2,
    devices: state.devices.map((device) => pickFields(device, DASHBOARD_DEVICE_FIELDS)),
    sensor: pickFields(state.sensor, SENSOR_FIELDS),
    camera: pickFields(state.camera, CAMERA_FIELDS),
    sensorHistory: state.sensorHistory,
    outdoorTemperatures: state.outdoorTemperatures,
  };
}

export function readDashboardSnapshot(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(DASHBOARD_SNAPSHOT_STORAGE_KEY) || 'null');
    if (parsed?.cacheVersion !== 2 || !Array.isArray(parsed.devices)) return null;
    return dashboardSnapshotPayload(parsed);
  } catch {
    return null;
  }
}

export function writeDashboardSnapshot(storage, payload) {
  const previous = readDashboardSnapshot(storage) || {};
  storage.setItem(DASHBOARD_SNAPSHOT_STORAGE_KEY, JSON.stringify(dashboardSnapshotPayload(payload, previous)));
}

function identityLabel(alias, model) {
  const normalizedAlias = String(alias || '').trim();
  const normalizedModel = String(model || '').trim();
  return [normalizedAlias, normalizedModel].filter(Boolean).join(' · ');
}

export function plugDashboardLabel(device, hardware) {
  if (!device) return 'Nessuna presa assegnata';
  const configured = hardware?.plugs?.find((plug) => plug.id === device.id);
  return identityLabel(configured?.alias || device.configuredName || device.name, configured?.model || device.model);
}

export function sensorDashboardLabel(role, source, fallbackAlias = '') {
  const configured = source?.sensors
    ? source.sensors.find((sensor) => sensor.role === role)
    : source?.assigned === true ? source : null;
  const explicitlyUnassigned = source?.assigned === false || (source?.sensors && !configured);
  if (explicitlyUnassigned) return 'Nessun sensore assegnato';
  return identityLabel(configured?.alias || fallbackAlias, configured?.model);
}
