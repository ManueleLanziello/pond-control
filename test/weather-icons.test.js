import assert from 'node:assert/strict';
import test from 'node:test';
import { weatherIconForCode } from '../public/weather-icons.js';

test('WMO weather codes map centrally to all required local icon categories', () => {
  const groups = [
    { codes: [0, 1], key: 'sun', src: '/icons/sun.svg' },
    { codes: [2, 3, 45, 48], key: 'cloud', src: '/icons/cloud.svg' },
    { codes: [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], key: 'rain', src: '/icons/rain.svg' },
    { codes: [71, 73, 75, 77, 85, 86], key: 'snow', src: '/icons/snow.svg' },
    { codes: [95, 96, 99], key: 'storm', src: '/icons/storm.svg' },
  ];
  for (const { codes, key, src } of groups) {
    for (const code of codes) assert.deepEqual(weatherIconForCode(code), { key, src });
  }
});

test('unknown WMO codes fall back to cloud.svg', () => {
  assert.deepEqual(weatherIconForCode(999), { key: 'cloud', src: '/icons/cloud.svg' });
});

test('callers can preserve their existing generic icon as fallback', () => {
  const fallback = { key: 'weather', src: '/icons/weather.svg' };
  assert.deepEqual(weatherIconForCode(999, fallback), fallback);
});
