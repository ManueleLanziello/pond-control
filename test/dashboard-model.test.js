import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildDashboardFunctions, plugDashboardLabel, POND_FUNCTIONS, sensorDashboardLabel,
} from '../public/dashboard-model.js';

const p105 = {
  id: 'tapo-p105-pond', role: 'pump', name: 'Presa Tapo P105', model: 'P105',
};
const p100m = {
  id: 'tapo-p100m-pond', role: 'heater', name: 'Presa Tapo P100M', model: 'P100M',
};

test('dashboard always exposes the two fixed Pond functions', () => {
  assert.deepEqual(POND_FUNCTIONS, [
    { role: 'pump', title: 'Pompa Filtro Pond' },
    { role: 'heater', title: 'Riscaldatore Pond' },
  ]);
});

test('pump and heater functions use the devices assigned by role', () => {
  const result = buildDashboardFunctions([p105, p100m]);
  assert.equal(result[0].title, 'Pompa Filtro Pond');
  assert.equal(result[0].device.id, 'tapo-p105-pond');
  assert.equal(result[0].device.name, 'Presa Tapo P105');
  assert.equal(result[1].title, 'Riscaldatore Pond');
  assert.equal(result[1].device.id, 'tapo-p100m-pond');
  assert.equal(result[1].device.name, 'Presa Tapo P100M');
});

test('swapping roles swaps physical device data without changing function titles or ids', () => {
  const swappedP105 = { ...p105, role: 'heater' };
  const swappedP100m = { ...p100m, role: 'pump' };
  const result = buildDashboardFunctions([swappedP105, swappedP100m]);
  assert.deepEqual(result.map(({ title, device }) => ({ title, id: device.id, model: device.model })), [
    { title: 'Pompa Filtro Pond', id: 'tapo-p100m-pond', model: 'P100M' },
    { title: 'Riscaldatore Pond', id: 'tapo-p105-pond', model: 'P105' },
  ]);
});

test('none devices generate no dashboard card and unassigned roles remain visible', () => {
  const result = buildDashboardFunctions([
    { ...p105, role: 'none' },
    { ...p100m, role: 'none' },
  ]);
  assert.equal(result.length, 2);
  assert.ok(result.every((item) => item.device === null));
});

test('changing a Tapo nickname never changes function or physical device identity', () => {
  const renamed = { ...p105, name: 'Presa Esterno 1' };
  const [pump] = buildDashboardFunctions([renamed, p100m]);
  assert.equal(pump.title, 'Pompa Filtro Pond');
  assert.equal(pump.device.name, 'Presa Esterno 1');
  assert.equal(pump.device.id, 'tapo-p105-pond');
});

test('dashboard labels assigned plugs through the administrative registry without technical connection details', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const cardSource = source.slice(source.indexOf('function functionCard'), source.indexOf('function renderDevices'));
  assert.match(cardSource, /plugDashboardLabel\(device, latestHardware\)/);
  assert.doesNotMatch(cardSource, /device\.(?:ip|protocol|rssi)|Protocollo|Indirizzo IP|Qualità segnale/);
});

test('dashboard subtitles use configurable hardware aliases and update when aliases change', () => {
  const hardware = {
    plugs: [
      { id: p105.id, alias: 'Presa Tapo P105', model: 'P105' },
      { id: p100m.id, alias: 'Presa Tapo P100M', model: 'P100M' },
    ],
    sensors: [{ id: 'dewin-pond', alias: 'Dewin Pond', model: '', role: 'pond_temperature' }],
  };
  assert.equal(plugDashboardLabel(p105, hardware), 'Presa Tapo P105 · P105');
  assert.equal(plugDashboardLabel(p100m, hardware), 'Presa Tapo P100M · P100M');
  assert.equal(sensorDashboardLabel('pond_temperature', hardware, 'fallback'), 'Dewin Pond');
  hardware.plugs[0].alias = 'Pompa laghetto';
  hardware.sensors[0].alias = 'Sonda acqua principale';
  assert.equal(plugDashboardLabel(p105, hardware), 'Pompa laghetto · P105');
  assert.equal(sensorDashboardLabel('pond_temperature', hardware, 'fallback'), 'Sonda acqua principale');
});

test('dashboard subtitle helpers preserve safe fallbacks and omit empty model separators', () => {
  assert.equal(plugDashboardLabel(p105, null), 'Presa Tapo P105 · P105');
  assert.equal(plugDashboardLabel(null, null), 'Nessuna presa assegnata');
  assert.equal(sensorDashboardLabel('pond_temperature', null, 'Sonda DEWIN'), 'Sonda DEWIN');
  assert.equal(sensorDashboardLabel('pond_temperature', {
    sensors: [{ role: 'pond_temperature', alias: 'Dewin Pond', model: 'TS-1' }],
  }, 'fallback'), 'Dewin Pond · TS-1');
});

test('dashboard polling remains five seconds and role is the only assignment key', async () => {
  const [appSource, modelSource] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/dashboard-model.js', import.meta.url), 'utf8'),
  ]);
  assert.match(appSource, /setInterval\(refresh, 5000\)/);
  assert.match(modelSource, /device\.role === pondFunction\.role/);
  assert.doesNotMatch(modelSource, /device\.(?:id|name|model|ip)\s*===/);
});

test('dashboard renders the five compact cards in the required order', async () => {
  const [appSource, styleSource] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/style.css', import.meta.url), 'utf8'),
  ]);
  const temperatureSource = appSource.slice(
    appSource.indexOf('function pondTemperatureCard'),
    appSource.indexOf('function functionCard'),
  );
  assert.match(appSource, /fetch\('\/api\/weather'/);
  assert.match(appSource, /weatherCard\(latestWeather\),\s*pondTemperatureCard\(latestDewin\),\s*\.\.\.functions\.map[\s\S]*?thermostatCard\(\)/);
  assert.match(appSource, /weatherIconForCode\(weather\?\.weatherCode, \{ key: 'weather', src: '\/icons\/weather\.svg' \}\)/);
  assert.match(appSource, /iconImage\(currentIcon\.src, 'function-icon'\)/);
  assert.doesNotMatch(appSource, /current-weather-icon/);
  assert.match(appSource, /valueRow\('\/icons\/termos\.svg', 'Temperature'/);
  assert.match(appSource, /valueRow\('\/icons\/rain\.svg', 'Pioggia'/);
  assert.match(appSource, /valueRow\('\/icons\/wind\.svg', 'Vento'/);
  assert.match(appSource, /forecastIconData = weatherIconForCode\(day\.weatherCode\)/);
  assert.doesNotMatch(appSource, /https?:\/\//);
  assert.match(temperatureSource, /\/icons\/thermometer\.svg/);
  assert.match(temperatureSource, /valueRow\('\/icons\/wifi\.svg', 'Connessione', view\.online \? 'ONLINE' : 'OFFLINE'/);
  assert.match(temperatureSource, /valueRow\('\/icons\/termos\.svg', 'Ambiente'/);
  assert.match(temperatureSource, /valueRow\('\/icons\/umidity\.svg', 'Umidità'/);
  assert.match(temperatureSource, /valueRow\('\/icons\/battery\.svg', 'Batteria'/);
  assert.match(temperatureSource, /valueRow\('\/icons\/update\.svg', 'Aggiornato'/);
  assert.ok(temperatureSource.indexOf("'Connessione'") < temperatureSource.indexOf("'Ambiente'"));
  assert.ok(temperatureSource.indexOf("'Ambiente'") < temperatureSource.indexOf("'Umidità'"));
  assert.ok(temperatureSource.indexOf("'Umidità'") < temperatureSource.indexOf("'Batteria'"));
  assert.ok(temperatureSource.indexOf("'Batteria'") < temperatureSource.indexOf("'Aggiornato'"));
  assert.match(temperatureSource, /view\.pondTemperature/);
  assert.match(appSource, /fetch\('\/api\/dewin'/);
  assert.match(appSource, /fetch\('\/api\/hardware'/);
  assert.doesNotMatch(temperatureSource, /weather\.temperature/);
  assert.match(styleSource, /grid-template-columns:\s*repeat\(5,\s*minmax\(0,1fr\)\)/);
  assert.match(styleSource, /\.card-heading\s*\{[^}]*grid-template-rows:\s*32px 24px 112px/);
  assert.match(styleSource, /\.card-main-row\s*\{[^}]*grid-template-columns:\s*repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styleSource, /\.card-main-title\s*\{[^}]*text-align:\s*center;[^}]*white-space:\s*nowrap/);
  assert.match(appSource, /controlView\.requestedState === 'ON'[\s\S]*?'\/icons\/poweron\.svg'[\s\S]*?controlView\.requestedState === 'OFF'[\s\S]*?'\/icons\/poweroff\.svg'/);
  assert.match(appSource, /if \(controlIconSource\) button\.append\(iconImage\(controlIconSource, 'control-icon'\)\)/);
  assert.doesNotMatch(appSource, /button\.append\([^\n]*createTextNode/);
  assert.match(styleSource, /@media \(max-width: 1599px\)[\s\S]*?\.device-grid\s*\{\s*grid-template-columns:\s*repeat\(3,/);
  assert.match(styleSource, /@media \(max-width: 1199px\)[\s\S]*?\.device-grid\s*\{\s*grid-template-columns:\s*repeat\(2,/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.device-grid\s*\{\s*grid-template-columns:\s*1fr/);
});
