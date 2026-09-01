export class PumpControlError extends Error {
  constructor(message, status = 502, code = 'PUMP_CONTROL_FAILED') {
    super(message);
    this.name = 'PumpControlError';
    this.status = status;
    this.code = code;
  }
}

function roleDevice(deviceManager, assignments, role) {
  const deviceId = Object.keys(assignments).find((id) => assignments[id] === role);
  return deviceId ? { id: deviceId, runtimeActive: deviceManager.hasDevice(deviceId) } : null;
}

export function createPumpController({ deviceList, roleStore, deviceManager, log = () => {} }) {
  return async function controlPump(requestedState) {
    if (!['ON', 'OFF'].includes(requestedState)) {
      throw new PumpControlError('Stato non valido: usare ON oppure OFF.', 400, 'INVALID_STATE');
    }
    const assignments = await roleStore.read();
    const pump = roleDevice(deviceManager, assignments, 'pump');
    if (!pump) throw new PumpControlError('Nessuna presa assegnata alla pompa.', 409, 'PUMP_NOT_ASSIGNED');
    if (!pump.runtimeActive) throw new PumpControlError('Runtime della pompa non attivo.', 409, 'PUMP_RUNTIME_INACTIVE');
    const heater = roleDevice(deviceManager, assignments, 'heater');
    if (heater && !heater.runtimeActive) {
      throw new PumpControlError('Runtime del riscaldatore non attivo.', 409, 'HEATER_RUNTIME_INACTIVE');
    }
    const involved = requestedState === 'OFF' && heater ? [pump.id, heater.id] : [pump.id];

    return deviceManager.withDevices(involved, async (managed) => {
      try { await managed.read(pump.id); } catch {
        throw new PumpControlError('La presa della pompa è offline.', 503, 'PUMP_OFFLINE');
      }
      log(`[Pompa Filtro Pond] comando manuale: ${requestedState}`);

      if (requestedState === 'OFF' && heater) {
        try { await managed.read(heater.id); } catch {
          throw new PumpControlError(
            'Spegnimento pompa bloccato: stato riscaldatore non verificabile.',
            409,
            'HEATER_STATE_UNKNOWN',
          );
        }
        if (managed.snapshot(heater.id).state === 'ON') {
          let verifiedHeater;
          try { verifiedHeater = await managed.setDeviceOn(heater.id, false); } catch {
            throw new PumpControlError(
              'Spegnimento pompa bloccato: impossibile verificare lo spegnimento del riscaldatore.',
              502,
              'HEATER_SHUTDOWN_FAILED',
            );
          }
          if (verifiedHeater.state !== 'OFF') {
            throw new PumpControlError(
              'Spegnimento pompa bloccato: impossibile verificare lo spegnimento del riscaldatore.',
              502,
              'HEATER_SHUTDOWN_FAILED',
            );
          }
          log('[Pompa Filtro Pond] spegnimento sicuro: heater OFF verificato');
        }
      }

      let verifiedPump;
      try { verifiedPump = await managed.setDeviceOn(pump.id, requestedState === 'ON'); } catch {
        throw new PumpControlError('Comando pompa non riuscito.', 502, 'WRITE_FAILED');
      }
      if (verifiedPump.state !== requestedState) {
        throw new PumpControlError('Lo stato reale della pompa non corrisponde al comando richiesto.', 502, 'STATE_MISMATCH');
      }
      log(`[Pompa Filtro Pond] stato verificato: ${verifiedPump.state}`);
      return { ok: true, role: 'pump', deviceId: pump.id, state: verifiedPump.state };
    });
  };
}
