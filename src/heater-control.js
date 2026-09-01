import { DEVICE_FRESHNESS_MS } from './device-manager.js';

export class HeaterControlError extends Error {
  constructor(message, status = 502, code = 'HEATER_CONTROL_FAILED') {
    super(message);
    this.name = 'HeaterControlError';
    this.status = status;
    this.code = code;
  }
}

function roleDevice(deviceManager, assignments, role) {
  const deviceId = Object.keys(assignments).find((id) => assignments[id] === role);
  return deviceId ? { id: deviceId, runtimeActive: deviceManager.hasDevice(deviceId) } : null;
}

export function createHeaterController({ deviceList, roleStore, deviceManager, log = () => {} }) {
  return async function controlHeater(requestedState) {
    if (!['ON', 'OFF'].includes(requestedState)) {
      throw new HeaterControlError('Stato non valido: usare ON oppure OFF.', 400, 'INVALID_STATE');
    }
    const assignments = await roleStore.read();
    const heater = roleDevice(deviceManager, assignments, 'heater');
    if (!heater) {
      throw new HeaterControlError('Nessuna presa assegnata al riscaldatore.', 409, 'HEATER_NOT_ASSIGNED');
    }
    if (!heater.runtimeActive) {
      throw new HeaterControlError('Runtime del riscaldatore non attivo.', 409, 'HEATER_RUNTIME_INACTIVE');
    }
    const pump = requestedState === 'ON' ? roleDevice(deviceManager, assignments, 'pump') : null;
    const involved = [heater.id, pump?.id].filter(Boolean);

    return deviceManager.withDevices(involved, async (managed) => {
      if (requestedState === 'ON') {
        if (!pump) {
          throw new HeaterControlError(
            'Accensione riscaldatore bloccata: pompa non attiva.', 409, 'PUMP_NOT_RUNNING',
          );
        }
        if (!pump.runtimeActive) {
          throw new HeaterControlError(
            'Accensione riscaldatore bloccata: runtime pompa non attivo.', 409, 'PUMP_RUNTIME_INACTIVE',
          );
        }
        try { await managed.read(pump.id); } catch { /* valutato in modo fail-safe sotto */ }
        if (managed.snapshot(pump.id).state !== 'ON'
          || !managed.isFreshAndReliable(pump.id, DEVICE_FRESHNESS_MS)) {
          throw new HeaterControlError(
            'Accensione riscaldatore bloccata: pompa non attiva.', 409, 'PUMP_NOT_RUNNING',
          );
        }
      }

      try { await managed.read(heater.id); } catch {
        throw new HeaterControlError('La presa del riscaldatore è offline.', 503, 'HEATER_OFFLINE');
      }
      log(`[Riscaldatore Pond] comando manuale: ${requestedState}`);
      let verified;
      try { verified = await managed.setDeviceOn(heater.id, requestedState === 'ON'); } catch {
        throw new HeaterControlError('Comando riscaldatore non riuscito.', 502, 'WRITE_FAILED');
      }
      if (verified.state !== requestedState) {
        throw new HeaterControlError('Lo stato reale non corrisponde al comando richiesto.', 502, 'STATE_MISMATCH');
      }
      log(`[Riscaldatore Pond] stato verificato: ${verified.state}`);
      return { ok: true, role: 'heater', deviceId: heater.id, state: verified.state };
    });
  };
}
