export const POND_FUNCTIONS = Object.freeze([
  Object.freeze({ role: 'pump', title: 'Pompa Filtro Pond' }),
  Object.freeze({ role: 'heater', title: 'Riscaldatore Pond' }),
]);

export function buildDashboardFunctions(devices) {
  return POND_FUNCTIONS.map((pondFunction) => ({
    ...pondFunction,
    device: devices.find((device) => device.role === pondFunction.role) || null,
  }));
}
