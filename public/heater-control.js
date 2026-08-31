export function heaterControlView(pondFunction, pumpFunction, pending = false) {
  if (pondFunction.role !== 'heater') return { visible: false };
  const { device } = pondFunction;
  const readable = Boolean(device?.online && ['ON', 'OFF'].includes(device.state));
  const currentState = readable ? device.state : null;
  const pumpLastRead = Date.parse(pumpFunction?.device?.lastReadAt || '');
  const pumpFresh = Number.isFinite(pumpLastRead) && Date.now() - pumpLastRead <= 5000;
  const pumpRunning = Boolean(
    pumpFunction?.device?.online
      && !pumpFunction.device.communicationDegraded
      && pumpFunction.device.consecutiveFailures === 0
      && pumpFunction.device.state === 'ON'
      && pumpFresh,
  );
  const blockedByPump = currentState === 'OFF' && !pumpRunning;
  return {
    visible: true,
    disabled: pending || !readable || blockedByPump,
    pending,
    currentState,
    blockedByPump,
    safetyMessage: blockedByPump ? 'Pompa non attiva' : '',
    requestedState: currentState === 'ON' ? 'OFF' : currentState === 'OFF' ? 'ON' : null,
    actionLabel: pending
      ? 'Operazione in corso…'
      : currentState === 'ON'
        ? 'Spegni riscaldatore'
        : currentState === 'OFF'
          ? 'Accendi riscaldatore'
          : 'Controllo non disponibile',
  };
}

export async function requestHeaterState(fetchImpl, state) {
  const response = await fetchImpl('/api/functions/heater/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true || !['ON', 'OFF'].includes(payload.state)) {
    throw new Error(payload?.error || 'Comando riscaldatore non riuscito');
  }
  return payload;
}
