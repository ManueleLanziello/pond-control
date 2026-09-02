export const POND_FUNCTIONS = Object.freeze([
  Object.freeze({ role: 'pump', title: 'Pompa Filtro Pond' }),
  Object.freeze({ role: 'heater', title: 'Riscaldatore Pond' }),
]);
export const DASHBOARD_REFRESH_FAILURE_THRESHOLD = 3;
export const DASHBOARD_SNAPSHOT_STORAGE_KEY = 'pond-control.dashboard-devices.v1';
const DASHBOARD_DEVICE_FIELDS = Object.freeze(['id', 'name', 'model', 'type', 'state', 'online', 'communicationDegraded', 'consecutiveFailures', 'lastReadAt', 'role', 'runtimeActive']);

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

export function dashboardSnapshotPayload(payload) {
  const devices = dashboardDevicesFromPayload([], payload).map((device) => Object.fromEntries(
    DASHBOARD_DEVICE_FIELDS.filter((field) => Object.hasOwn(device, field)).map((field) => [field, device[field]]),
  ));
  return { devices };
}

export function readDashboardSnapshot(storage) {
  try { return dashboardSnapshotPayload(JSON.parse(storage.getItem(DASHBOARD_SNAPSHOT_STORAGE_KEY) || 'null')); } catch { return null; }
}

export function writeDashboardSnapshot(storage, payload) {
  storage.setItem(DASHBOARD_SNAPSHOT_STORAGE_KEY, JSON.stringify(dashboardSnapshotPayload(payload)));
}

function identityLabel(alias, model) {
  const normalizedAlias = String(alias || '').trim();
  const normalizedModel = String(model || '').trim();
  return [normalizedAlias, normalizedModel].filter(Boolean).join(' · ');
}

export function plugDashboardLabel(device, hardware) {
  if (!device) return 'Nessuna presa assegnata';
  const configured = hardware?.plugs?.find((plug) => plug.id === device.id);
  return identityLabel(configured?.alias || device.name, configured?.model || device.model);
}

export function sensorDashboardLabel(role, hardware, fallbackAlias = '') {
  const configured = hardware?.sensors?.find((sensor) => sensor.role === role);
  if (hardware && !configured) return 'Nessun sensore assegnato';
  return identityLabel(configured?.alias || fallbackAlias, configured?.model);
}
