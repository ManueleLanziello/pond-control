export function pumpControlView(pondFunction, pending = false) {
  if (pondFunction.role !== 'pump') return { visible: false };
  const { device } = pondFunction;
  const readable = Boolean(device?.online && ['ON', 'OFF'].includes(device.state));
  const currentState = readable ? device.state : null;
  return {
    visible: true,
    disabled: pending || !readable,
    currentState,
    requestedState: currentState === 'ON' ? 'OFF' : currentState === 'OFF' ? 'ON' : null,
    actionLabel: pending
      ? currentState === 'ON' ? 'Spegnimento sicuro in corso…' : 'Operazione in corso…'
      : currentState === 'ON'
        ? 'Spegni pompa'
        : currentState === 'OFF'
          ? 'Accendi pompa'
          : 'Controllo non disponibile',
  };
}

export async function requestPumpState(fetchImpl, state) {
  const response = await fetchImpl('/api/functions/pump/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true || !['ON', 'OFF'].includes(payload.state)) {
    throw new Error(payload?.message || payload?.error || 'Comando pompa non riuscito');
  }
  return payload;
}
