import assert from 'node:assert/strict';
import test from 'node:test';
import { WeatherService, parseOpenMeteo } from '../src/weather-service.js';

const config = {
  latitude: 45.335967, longitude: 7.715512, locationName: 'Rivarolo Canavese',
  timezone: 'Europe/Rome', refreshIntervalMs: 900000, staleAfterMs: 1800000,
};

function fixture() {
  return {
    current: { temperature_2m: 27.4, weather_code: 0, wind_speed_10m: 8.4 },
    daily: {
      time: ['2026-08-26', '2026-08-27', '2026-08-28'],
      weather_code: [0, 2, 61],
      temperature_2m_min: [18.2, 19, 17],
      temperature_2m_max: [29.1, 28, 25],
      precipitation_probability_max: [10, 20, 70],
    },
  };
}

test('Open-Meteo response is parsed into the compact Pond snapshot', () => {
  const result = parseOpenMeteo(fixture(), config, '2026-08-26T12:00:00.000Z');
  assert.equal(result.location, 'Rivarolo Canavese');
  assert.equal(result.temperature, 27.4);
  assert.equal(result.condition, 'Sereno');
  assert.equal(result.min, 18.2);
  assert.equal(result.max, 29.1);
  assert.equal(result.rainProbability, 10);
  assert.equal(result.windSpeed, 8.4);
  assert.equal(result.forecast.length, 3);
  assert.equal(result.stale, false);
});

test('weather service preserves the last valid snapshot and marks it stale on failure', async () => {
  let shouldFail = false;
  let now = Date.parse('2026-08-26T12:00:00.000Z');
  const service = new WeatherService({
    config,
    now: () => now,
    fetchImpl: async () => shouldFail
      ? new Response('', { status: 503 })
      : new Response(JSON.stringify(fixture()), { status: 200 }),
  });
  await service.refresh();
  const valid = service.snapshot();
  shouldFail = true;
  now += 900000;
  await service.refresh();
  const cached = service.snapshot();
  assert.equal(cached.temperature, valid.temperature);
  assert.equal(cached.updatedAt, valid.updatedAt);
  assert.equal(cached.stale, true);
});

test('weather snapshot becomes stale by age without another network request', async () => {
  let now = Date.parse('2026-08-26T12:00:00.000Z');
  let calls = 0;
  const service = new WeatherService({
    config,
    now: () => now,
    fetchImpl: async () => { calls += 1; return new Response(JSON.stringify(fixture()), { status: 200 }); },
  });
  await service.refresh();
  now += config.staleAfterMs + 1;
  assert.equal(service.snapshot().stale, true);
  assert.equal(calls, 1);
});
