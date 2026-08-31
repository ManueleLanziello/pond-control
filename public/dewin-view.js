const BATTERY_LABELS = Object.freeze({ high: 'Alta', middle: 'Media', low: 'Bassa' });

export function formatDewinValue(datapoint, digits = 1) {
  if (!datapoint || datapoint.value === null || datapoint.value === undefined) return '—';
  if (typeof datapoint.value === 'number') {
    return `${datapoint.value.toFixed(digits)}${datapoint.unit ? ` ${datapoint.unit}` : ''}`;
  }
  return String(datapoint.value);
}

export function dewinCardView(snapshot) {
  const available = Boolean(snapshot?.available && snapshot.externalProbeTemperature);
  const batteryRaw = snapshot?.batteryState?.value;
  return {
    available,
    stale: Boolean(snapshot?.stale),
    online: Boolean(snapshot?.online),
    pondTemperature: available ? formatDewinValue(snapshot.externalProbeTemperature) : '--.- °C',
    ambientTemperature: formatDewinValue(snapshot?.ambientTemperature),
    ambientHumidity: formatDewinValue(snapshot?.ambientHumidity, 0),
    battery: batteryRaw ? (BATTERY_LABELS[batteryRaw] || String(batteryRaw)) : '—',
    updatedAt: snapshot?.updatedAt || null,
    optional: [
      ['Calibrazione temp.', snapshot?.temperatureCalibration],
      ['Calibrazione umidità', snapshot?.humidityCalibration],
      ['Correzione temp.', snapshot?.temperatureCorrection],
    ].filter(([, value]) => value),
  };
}
