import assert from 'node:assert/strict';
import test from 'node:test';
import { OutdoorTemperatureService, parseOutdoorTemperature } from '../src/outdoor-temperature-service.js';

const payload = { hourly: { time: ['2026-09-02T00:00', '2026-09-02T01:00'], temperature_2m: [15.2, 14.8] } };

test('Open-Meteo outdoor temperatures use Europe/Rome hourly samples and cache for one hour', async () => {
  let calls = 0;
  const service = new OutdoorTemperatureService({ latitude: '45.335987', longitude: '7.715486', now: () => 1_000, fetchImpl: async (url) => {
    calls += 1; assert.equal(url.searchParams.get('timezone'), 'Europe/Rome'); assert.equal(url.searchParams.get('hourly'), 'temperature_2m');
    return { ok: true, json: async () => payload };
  } });
  const first = await service.today(); const second = await service.today();
  assert.equal(calls, 1); assert.deepEqual(first.samples, [{ timestamp: '2026-09-02T00:00', minute: 0, temperature: 15.2 }, { timestamp: '2026-09-02T01:00', minute: 60, temperature: 14.8 }]); assert.deepEqual(second, first);
});

test('missing coordinates or Open-Meteo errors leave Ambiente unavailable without fallback values', async () => {
  const missing = new OutdoorTemperatureService({ latitude: '', longitude: '', logError: () => {} });
  assert.deepEqual(await missing.today(), { available: false, stale: true, updatedAt: null, samples: [] });
  assert.throws(() => parseOutdoorTemperature({ hourly: { time: ['2026-09-02T00:00'], temperature_2m: [null] } }));
});
