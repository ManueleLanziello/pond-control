import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildTemperatureChartModel,
  buildTemperatureSeriesPath,
  TEMPERATURE_CHART_RANGE,
  temperatureMarkerStride,
} from '../public/temperature-chart.js';

test('temperature chart has mandatory fixed daily and Celsius ranges', () => {
  assert.deepEqual(TEMPERATURE_CHART_RANGE, {
    xMinMinutes: 0, xMaxMinutes: 1440, yMin: -5, yMax: 35,
    xTicks: Array.from({ length: 25 }, (_, hour) => hour * 60),
    yTicks: Array.from({ length: 9 }, (_, index) => -5 + index * 5),
  });
});

test('chart keeps Acqua, Terreno and server-provided Ambiente series without inventing samples', () => {
  const history = {
    date: '2026-08-27',
    samples: [
      { timestamp: '2026-08-27T06:00:00.000Z', pond: 24.7, ambient: 27.8 },
      { timestamp: '2026-08-27T12:00:00.000Z', pond: 28.5, ambient: 29.4 },
      { timestamp: '2026-08-27T14:30:00.000Z', pond: 27.2, ambient: 28.9 },
    ],
  };
  const model = buildTemperatureChartModel(history, {
    externalProbeTemperature: { value: 27.2 }, ambientTemperature: { value: 28.9 },
  }, { available: true, stale: false, samples: [{ timestamp: '2026-08-27T06:00', minute: 360, temperature: 18.1 }, { timestamp: '2026-08-27T12:00', minute: 720, temperature: 25.3 }] });
  assert.equal(model.samples.length, history.samples.length);
  assert.deepEqual(model.samples.map(({ pond, ambient }) => ({ pond, ambient })), history.samples.map(({ pond, ambient }) => ({ pond, ambient })));
  assert.deepEqual(model.pond, { min: 24.7, max: 28.5 });
  assert.deepEqual(model.terrain, { min: 27.8, max: 29.4 });
  assert.deepEqual(model.outdoor, { min: 18.1, max: 25.3 });
  assert.deepEqual(model.current, { pond: 27.2, terrain: 28.9, outdoor: 25.3 });
});

test('significant acquisition gaps break the SVG path instead of interpolating them', () => {
  const samples = [
    { timestamp: '2026-08-27T08:00:00.000Z', minute: 600, pond: 25 },
    { timestamp: '2026-08-27T08:10:00.000Z', minute: 610, pond: 25.1 },
    { timestamp: '2026-08-27T09:00:00.000Z', minute: 660, pond: 25.4 },
  ];
  const path = buildTemperatureSeriesPath(samples, 'pond');
  assert.equal((path.match(/\bM\b/g) || []).length, 2);
  assert.equal((path.match(/\bL\b/g) || []).length, 1);
});

test('marker density stays clean at the 144-sample daily baseline', () => {
  assert.equal(temperatureMarkerStride(12), 1);
  assert.equal(temperatureMarkerStride(144), 6);
});

test('responsive insights layout aligns two desktop columns and stacks on mobile', async () => {
  const [html, css, chartSource] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/style.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/temperature-chart.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /class="insights-grid"/);
  assert.match(css, /\.insights-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,1fr\)\)/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.insights-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(chartSource, /chart-line-pond/);
  assert.match(chartSource, /chart-line-ambient/);
  assert.match(chartSource, /chart-line-outdoor/);
  assert.match(chartSource, /chart-glow-pond/);
  assert.doesNotMatch(chartSource, /chart-glow-ambient/);
  assert.match(chartSource, /feGaussianBlur/);
  assert.match(chartSource, /Temperature Oggi/);
  assert.match(chartSource, /sensorSubtitle/);
  assert.match(chartSource, /\/icons\/history\.svg/);
  assert.match(chartSource, /temperature-day-night/);
  assert.match(chartSource, /temperature-chart-legend/);
  assert.match(chartSource, /:00/);
  assert.match(css, /\.chart-glow\s*\{[^}]*stroke-width:\s*8/);
  assert.match(css, /filter:\s*url\(#pond-neon-blur\)/);
  assert.match(css, /\.chart-line-ambient\s*\{[^}]*stroke:\s*#ff9b3f/);
  assert.match(css, /\.chart-line-outdoor\s*\{[^}]*stroke:\s*#b893ff/);
  assert.match(chartSource, /pointermove/);
  assert.match(chartSource, /pointerdown/);
});

test('thermostat is a visual placeholder with no controls or automation logic', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const placeholder = app.slice(app.indexOf('function thermostatCard'), app.indexOf('function renderDevices'));
  assert.match(placeholder, /Termostato/);
  assert.match(placeholder, /Controllo clima/);
  assert.match(placeholder, /Automazione non configurata/);
  assert.match(placeholder, /\/icons\/termotime\.svg/);
  assert.doesNotMatch(placeholder, /button|input|setpoint|isteresi|P100M/i);
});
