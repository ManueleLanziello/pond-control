import { DEVICE_FRESHNESS_MS, DEVICE_POLL_INTERVAL_MS } from './device-manager.js';

function roleDevice(deviceList, assignments, role) {
  return deviceList.find((device) => assignments[device.id] === role) || null;
}

export function createSafetyMonitor({
  deviceList, roleStore, deviceManager, log = () => {}, logError = () => {},
}) {
  let running = false;
  let lastPumpCondition = null;
  let lastError = null;
  let lastShutdownReason = null;

  function reportError(message) {
    if (message === lastError) return;
    lastError = message;
    logError(message);
  }

  function reportPump(condition) {
    if (condition === lastPumpCondition) return;
    if (condition === 'AVAILABLE' && lastPumpCondition && lastPumpCondition !== 'AVAILABLE') {
      log('[SAFETY] Pompa nuovamente disponibile');
    } else if (condition === 'OFF') log('[SAFETY] Pompa OFF - protezione attivata');
    else if (condition === 'OFFLINE') log('[SAFETY] Pompa OFFLINE - protezione attivata');
    else if (condition === 'UNASSIGNED') log('[SAFETY] Pompa non assegnata - protezione attivata');
    lastPumpCondition = condition;
  }

  async function runCycle() {
    if (running) return { skipped: true };
    running = true;
    try {
      const assignments = await roleStore.read();
      const pump = roleDevice(deviceList, assignments, 'pump');
      const heater = roleDevice(deviceList, assignments, 'heater');
      if (!heater) return { action: 'none', reason: 'HEATER_UNASSIGNED' };

      let pumpCondition = 'UNASSIGNED';
      if (pump) {
        const pumpSnapshot = deviceManager.snapshot(pump.id);
        const reliable = deviceManager.isFreshAndReliable(pump.id, DEVICE_FRESHNESS_MS);
        pumpCondition = !reliable
          ? 'OFFLINE'
          : pumpSnapshot.state === 'ON' ? 'AVAILABLE' : 'OFF';
      }
      reportPump(pumpCondition);
      if (pumpCondition === 'AVAILABLE') {
        lastError = null;
        return { action: 'none', reason: 'PUMP_RUNNING' };
      }

      const knownHeater = deviceManager.snapshot(heater.id);
      if (knownHeater.state === 'OFF'
        && deviceManager.isFreshAndReliable(heater.id, DEVICE_FRESHNESS_MS)) {
        lastError = null;
        lastShutdownReason = null;
        return { action: 'none', reason: 'HEATER_ALREADY_OFF' };
      }

      return await deviceManager.withDevices([heater.id], async (managed) => {
        try { await managed.read(heater.id); } catch {
          reportError('[SAFETY] Riscaldatore non raggiungibile durante la protezione');
          return { action: 'none', reason: 'HEATER_OFFLINE' };
        }
        if (managed.snapshot(heater.id).state !== 'ON') {
          lastError = null;
          lastShutdownReason = null;
          return { action: 'none', reason: 'HEATER_ALREADY_OFF' };
        }
        if (lastShutdownReason !== pumpCondition) {
          const label = pumpCondition === 'UNASSIGNED' ? 'NON ASSEGNATA' : pumpCondition;
          log(`[SAFETY] Pompa ${label} - spegnimento Riscaldatore Pond`);
          lastShutdownReason = pumpCondition;
        }
        try {
          const verified = await managed.setDeviceOn(heater.id, false);
          if (verified.state !== 'OFF') throw new Error('stato non verificato');
          lastError = null;
          lastShutdownReason = null;
          log('[SAFETY] Riscaldatore Pond verificato OFF');
          return { action: 'heater-off', verified: true };
        } catch {
          reportError('[SAFETY] Spegnimento riscaldatore non riuscito; nuovo tentativo al prossimo ciclo');
          return { action: 'heater-off', verified: false };
        }
      });
    } catch {
      reportError('[SAFETY] Controllo di sicurezza non riuscito; nuovo tentativo al prossimo ciclo');
      return { action: 'none', reason: 'MONITOR_ERROR' };
    } finally {
      running = false;
    }
  }

  return { runCycle, intervalMs: DEVICE_POLL_INTERVAL_MS };
}
