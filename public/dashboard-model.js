export const POND_FUNCTIONS = Object.freeze([
  Object.freeze({ role: 'pump', title: 'Pompa Filtro Pond' }),
  Object.freeze({ role: 'heater', title: 'Riscaldatore Pond' }),
]);
export const DASHBOARD_REFRESH_FAILURE_THRESHOLD = 3;

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
