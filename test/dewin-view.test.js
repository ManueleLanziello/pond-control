import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dewinCardView } from '../public/dewin-view.js';

const datapoint = (value, unit, raw = value, scale = 0) => ({ value, unit, raw, scale });

test('Pond card view uses external probe as primary and keeps secondary Dewin readings', () => {
  const view = dewinCardView({
    available: true, online: true, stale: false, updatedAt: '2026-08-27T14:00:00.000Z',
    externalProbeTemperature: datapoint(24.7, '°C', 247, 1),
    ambientTemperature: datapoint(28.9, '°C', 289, 1),
    ambientHumidity: datapoint(56, '%', 56, 0),
    batteryState: datapoint('high', null, 'high', null),
    temperatureCalibration: datapoint(-0.3, '°C', -3, 1),
  });
  assert.equal(view.pondTemperature, '24.7 °C');
  assert.equal(view.ambientTemperature, '28.9 °C');
  assert.equal(view.ambientHumidity, '56 %');
  assert.equal(view.battery, 'Alta');
  assert.equal(view.optional.length, 1);
});

test('Pond card view exposes cached Dewin online and offline connection state', () => {
  assert.equal(dewinCardView({ available: true, online: true }).online, true);
  assert.equal(dewinCardView({ available: true, online: false }).online, false);
  assert.equal(dewinCardView(null).online, false);
});

test('Pond card source reads the atomic dashboard sensor state and never calls Tuya or a write endpoint', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const card = source.slice(source.indexOf('function pondTemperatureCard'), source.indexOf('function functionCard'));
  assert.match(source, /latestDewin = latestDashboard\.sensor/);
  assert.match(card, /dewinCardView\(dewin\)/);
  assert.match(card, /sensorDashboardLabel\('pond_temperature', dewin/);
  assert.doesNotMatch(card, /cardMainHeader\('Temperatura Acqua', 'Sonda DEWIN'/);
  assert.match(card, /view\.pondTemperature/);
  assert.match(card, /Ambiente/);
  assert.match(card, /Umidità/);
  assert.match(card, /Batteria/);
  assert.doesNotMatch(source, /openapi\.tuya|\/commands|method:\s*['"](?:POST|PUT|DELETE)['"]/);
});
