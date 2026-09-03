import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildDashboardFunctions, dashboardDevicesFromPayload, dashboardRefreshHealth, dashboardSnapshotPayload,
  dashboardStateFromPayload, readDashboardSnapshot, writeDashboardSnapshot, plugDashboardLabel,
  POND_FUNCTIONS, sensorDashboardLabel, DASHBOARD_SNAPSHOT_STORAGE_KEY,
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

test('failed refresh preserves rendered cards and a later valid refresh resumes updates', () => {
  const first = [{ id: 'first' }]; const second = [{ id: 'second' }];
  let rendered = dashboardDevicesFromPayload([], { devices: first });
  assert.equal(rendered, first);
  assert.throws(() => dashboardDevicesFromPayload(rendered, { error: 'temporaneo' }), /Risposta API non valida/);
  assert.equal(rendered, first);
  rendered = dashboardDevicesFromPayload(rendered, { devices: second });
  assert.equal(rendered, second);
});

test('global dashboard health degrades only after three consecutive main refresh failures and resets on success', () => {
  let health = dashboardRefreshHealth(0, true);
  assert.deepEqual(health, { failures: 0, degraded: false });
  health = dashboardRefreshHealth(health.failures, false);
  assert.deepEqual(health, { failures: 1, degraded: false });
  health = dashboardRefreshHealth(health.failures, false);
  assert.deepEqual(health, { failures: 2, degraded: false });
  health = dashboardRefreshHealth(health.failures, false);
  assert.deepEqual(health, { failures: 3, degraded: true });
  assert.deepEqual(dashboardRefreshHealth(health.failures, true), { failures: 0, degraded: false });
});

test('dashboard snapshot restores card data across navigation and stores only display-safe device fields', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const payload = { devices: [{ id: 'p1', name: 'Pompa', model: 'P105', state: 'ON', online: true, role: 'pump', ip: '192.168.1.5', protocol: 'tpap', password: 'never-store' }] };
  writeDashboardSnapshot(storage, payload);
  assert.deepEqual(readDashboardSnapshot(storage).devices, [{ id: 'p1', name: 'Pompa', model: 'P105', state: 'ON', online: true, role: 'pump' }]);
  assert.doesNotMatch(values.get(DASHBOARD_SNAPSHOT_STORAGE_KEY), /192\.168|tpap|password|never-store/);
  assert.deepEqual(dashboardSnapshotPayload({ devices: [p105] }).devices, [{ id: p105.id, name: p105.name, model: p105.model, role: p105.role }]);
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
  assert.match(cardSource, /plugDashboardLabel\(device\)/);
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
  assert.match(appSource, /DASHBOARD_RETRY_DELAYS_MS = \[1000, 2000, 5000\]/);
  assert.match(appSource, /scheduleRefresh\(succeeded \? DASHBOARD_REFRESH_INTERVAL_MS : retryDelay\)/);
  assert.match(appSource, /if \(refreshInProgress\) return false;/);
  assert.match(appSource, /finally \{\s*refreshInProgress = false;/);
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
  assert.match(appSource, /fetch\('\/api\/weather\/hourly'[\s\S]*?\.catch\(\(\) => null\)/);
  assert.match(appSource, /fetch\('\/api\/weather', \{ cache: 'no-store' \}\)[\s\S]*?\.catch\(\(\) => null\)/);
  assert.match(appSource, /initCameraCard\(cameraCardElement, fetch, latestDashboard\.camera\)/);
  assert.match(appSource, /readDashboardSnapshot\(sessionStorage\)/);
  assert.match(appSource, /renderDevices\(latestDevices\);\s*scheduleRefresh\(0\);/);
  const refreshSource = appSource.slice(appSource.indexOf('async function refresh'), appSource.indexOf('refresh();'));
  assert.ok(refreshSource.indexOf('renderDevices(latestDevices)') < refreshSource.indexOf('renderTemperatureChart('));
  assert.match(refreshSource, /renderDevices\(latestDevices\);[\s\S]*?try \{\s*renderTemperatureChart/);
  assert.doesNotMatch(refreshSource.slice(refreshSource.lastIndexOf('} catch {')), /renderDevices|replaceChildren/);
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
  assert.match(appSource, /latestDewin = latestDashboard\.sensor/);
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

const goodDashboard = () => ({
  dashboardVersion: 2,
  complete: true,
  devices: [
    { ...p105, configuredName: 'Pompa Pond', online: true, state: 'ON' },
    { ...p100m, configuredName: 'Riscaldatore Pond', online: true, state: 'OFF' },
  ],
  sensor: {
    assigned: true, hardwareId: 'dewin-pond', alias: 'Dewin Pond', model: 'T & H Sensor with external probe',
    runtimeActive: true, available: true, online: true, stale: false, updatedAt: '2026-09-03T08:00:00.000Z',
    externalProbeTemperature: { value: 22.5, unit: '°C' }, ambientTemperature: { value: 21.2, unit: '°C' },
  },
  camera: {
    assigned: true, deviceId: 'tapo-c410-pond', alias: 'C410 Pond', model: 'C410', runtimeActive: true,
    configured: true, live: false, status: 'READY', imageAvailable: true, imageVersion: 1,
  },
});

test('assigned sensor remains identified through repeated Tuya timeouts and recovers without reload', () => {
  let state = dashboardStateFromPayload({}, goodDashboard());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    state = dashboardStateFromPayload(state, {
      ...goodDashboard(),
      sensor: { ...state.sensor, online: false, stale: true },
    });
    assert.equal(state.sensor.assigned, true);
    assert.equal(state.sensor.alias, 'Dewin Pond');
    assert.equal(state.sensor.externalProbeTemperature.value, 22.5);
    assert.equal(sensorDashboardLabel('pond_temperature', state.sensor), 'Dewin Pond · T & H Sensor with external probe');
  }
  state = dashboardStateFromPayload(state, {
    ...goodDashboard(), sensor: { ...goodDashboard().sensor, externalProbeTemperature: { value: 22.8, unit: '°C' } },
  });
  assert.equal(state.sensor.online, true);
  assert.equal(state.sensor.stale, false);
  assert.equal(state.sensor.externalProbeTemperature.value, 22.8);
});

test('camera timeout preserves assignment, identity and last image then recovers automatically', () => {
  let state = dashboardStateFromPayload({}, goodDashboard());
  state = dashboardStateFromPayload(state, {
    ...goodDashboard(),
    camera: { ...state.camera, live: false, status: 'ERROR', errorCode: 'TIMEOUT' },
  });
  assert.deepEqual(
    { assigned: state.camera.assigned, alias: state.camera.alias, model: state.camera.model, imageAvailable: state.camera.imageAvailable },
    { assigned: true, alias: 'C410 Pond', model: 'C410', imageAvailable: true },
  );
  state = dashboardStateFromPayload(state, goodDashboard());
  assert.equal(state.camera.status, 'READY');
  assert.equal(state.camera.assigned, true);
});

test('partial HTTP 200 and session navigation never replace complete sensor/camera identity', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  writeDashboardSnapshot(storage, {
    ...goodDashboard(),
    sensorHistory: { date: '2026-09-03', samples: [{ timestamp: '2026-09-03T08:00:00.000Z', pond: 22.5, ambient: 21.2 }] },
  });
  writeDashboardSnapshot(storage, { devices: [{ ...p105, online: false }], sensor: null, camera: null });
  const restored = readDashboardSnapshot(storage);
  assert.equal(restored.devices.length, 2);
  assert.equal(restored.sensor.hardwareId, 'dewin-pond');
  assert.equal(restored.sensor.alias, 'Dewin Pond');
  assert.equal(restored.camera.deviceId, 'tapo-c410-pond');
  assert.equal(restored.camera.alias, 'C410 Pond');
  assert.equal(restored.sensorHistory.samples.length, 1);
  assert.throws(() => dashboardStateFromPayload(restored, {
    dashboardVersion: 2, complete: true, devices: restored.devices, sensor: null, camera: null,
  }), /Risposta API Dashboard non valida/);
});

test('Open-Meteo failure is isolated from Dewin identity and cached readings', () => {
  const before = dashboardStateFromPayload({}, goodDashboard());
  const after = dashboardStateFromPayload(before, { outdoorTemperatures: null });
  assert.equal(after.sensor.hardwareId, 'dewin-pond');
  assert.equal(after.sensor.externalProbeTemperature.value, 22.5);
});

test('only an explicit authoritative unassignment produces unassigned sensor/camera state', () => {
  let state = dashboardStateFromPayload({}, goodDashboard());
  state = dashboardStateFromPayload(state, {
    ...goodDashboard(),
    sensor: { assigned: false, hardwareId: null, alias: null, model: null, runtimeActive: false },
    camera: { assigned: false, deviceId: null, alias: null, model: null, runtimeActive: false },
  });
  assert.equal(sensorDashboardLabel('pond_temperature', state.sensor), 'Nessun sensore assegnato');
  assert.equal(state.camera.assigned, false);
});

test('logical stress sequence preserves card count, roles and identities after every transition', () => {
  const good = goodDashboard();
  const transitions = [
    good, good,
    { ...good, sensor: { ...good.sensor, online: false, stale: true } },
    good,
    { ...good, camera: { ...good.camera, status: 'ERROR', errorCode: 'TIMEOUT' } },
    { ...good, sensor: { ...good.sensor, online: false, stale: true } },
    { devices: [good.devices[0]], sensor: null, camera: null },
    good, good,
  ];
  let state = {};
  for (const transition of transitions) {
    state = dashboardStateFromPayload(state, transition);
    assert.equal(buildDashboardFunctions(state.devices).length, 2);
    assert.deepEqual(buildDashboardFunctions(state.devices).map(({ role, device }) => [role, device?.id]), [
      ['pump', 'tapo-p105-pond'], ['heater', 'tapo-p100m-pond'],
    ]);
    assert.equal(state.sensor.hardwareId, 'dewin-pond');
    assert.equal(state.sensor.alias, 'Dewin Pond');
    assert.equal(state.camera.deviceId, 'tapo-c410-pond');
    assert.equal(state.camera.alias, 'C410 Pond');
  }
  assert.equal(state.sensor.online, true);
  assert.equal(state.camera.status, 'READY');
});
