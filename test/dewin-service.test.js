import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDewinSnapshot,
  DewinService,
  parseTuyaDatapoints,
  TuyaCloudClient,
} from '../src/dewin-service.js';

const DEVICE_ID = 'bf0a19b9163f00415ba1o9';

function specification() {
  return {
    category: 'qxj',
    status: [
      { code: 'temp_current', type: 'Integer', name: 'Current Temperature', values: '{"unit":"℃","scale":1}' },
      { code: 'humidity_value', type: 'Integer', name: 'Humidity', values: '{"unit":"%","scale":0}' },
      { code: 'battery_state', type: 'Enum', name: 'Battery State', values: '{"range":["low","middle","high"]}' },
      { code: 'temp_current_external', type: 'Integer', name: 'External Temperature', values: '{"unit":"℃","scale":1}' },
      { code: 'temp_calibration', type: 'Integer', name: 'Temperature Calibration', values: '{"unit":"℃","scale":1}' },
      { code: 'hum_calibration', type: 'Integer', name: 'Humidity Calibration', values: '{"unit":"%","scale":0}' },
      { code: 'temp_correction', type: 'Integer', name: 'Temperature Correction', values: '{"unit":"℃","scale":1}' },
    ],
  };
}

function statuses() {
  return [
    { code: 'temp_current', value: 289 },
    { code: 'humidity_value', value: 56 },
    { code: 'battery_state', value: 'high' },
    { code: 'temp_current_external', value: 285 },
    { code: 'temp_calibration', value: -3 },
    { code: 'hum_calibration', value: 2 },
    { code: 'temp_correction', value: 4 },
    { code: 'future_status', value: true },
  ];
}

function cloudMock({ fail = () => false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers });
    if (fail(String(url))) return new Response(JSON.stringify({ success: false, code: 500, msg: 'mock failure' }), { status: 503 });
    let result;
    if (String(url).includes('/v1.0/token?')) result = { access_token: 'mock-access-token', expire_time: 7200 };
    else if (String(url).endsWith('/specification')) result = specification();
    else if (String(url).endsWith('/status')) result = statuses();
    else result = { id: DEVICE_ID, online: true, name: 'T & H Sensor with external probe', category: 'qxj' };
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  };
  return { calls, fetchImpl };
}

test('Tuya status and specification preserve every DP and convert only from real scale metadata', () => {
  const datapoints = parseTuyaDatapoints(statuses(), specification());
  assert.equal(datapoints.length, statuses().length);
  assert.deepEqual(datapoints.find(({ code }) => code === 'temp_current'), {
    code: 'temp_current', raw: 289, scale: 1, unit: '°C', value: 28.9,
    type: 'Integer', label: 'Current Temperature',
  });
  assert.equal(datapoints.find(({ code }) => code === 'humidity_value').value, 56);
  assert.equal(datapoints.find(({ code }) => code === 'battery_state').value, 'high');
  assert.equal(datapoints.find(({ code }) => code === 'temp_current_external').value, 28.5);
  assert.equal(datapoints.find(({ code }) => code === 'future_status').value, true);
  assert.equal(datapoints.find(({ code }) => code === 'future_status').scale, null);
});

test('complete snapshot exposes main, optional and full dynamic datapoints', () => {
  const snapshot = buildDewinSnapshot({
    device: { id: DEVICE_ID, online: true, name: 'T & H Sensor with external probe', category: 'qxj' },
    statuses: statuses(), specification: specification(), updatedAt: '2026-08-27T14:00:00.000Z',
  });
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.online, true);
  assert.equal(snapshot.deviceId, DEVICE_ID);
  assert.equal(snapshot.ambientTemperature.value, 28.9);
  assert.equal(snapshot.ambientHumidity.value, 56);
  assert.equal(snapshot.batteryState.value, 'high');
  assert.equal(snapshot.externalProbeTemperature.value, 28.5);
  assert.equal(snapshot.temperatureCalibration.value, -0.3);
  assert.equal(snapshot.humidityCalibration.value, 2);
  assert.equal(snapshot.temperatureCorrection.value, 0.4);
  assert.equal(snapshot.datapoints.length, 8);
  assert.equal(snapshot.stale, false);
});

test('cloud client authenticates once, reuses the token and performs GET requests only', async () => {
  let now = Date.parse('2026-08-27T14:00:00.000Z');
  const mock = cloudMock();
  const client = new TuyaCloudClient({
    clientId: 'client-id', clientSecret: 'client-secret', deviceId: DEVICE_ID,
    fetchImpl: mock.fetchImpl, now: () => now,
  });
  await client.readDevice();
  now += 60_000;
  await client.readDevice();
  assert.equal(mock.calls.filter(({ url }) => url.includes('/v1.0/token?')).length, 1);
  assert.equal(mock.calls.length, 7);
  assert.ok(mock.calls.every(({ method }) => method === 'GET'));
  assert.ok(mock.calls.slice(1).every(({ headers }) => headers.access_token === 'mock-access-token'));
});

test('cloud client requests a new token after expiry instead of authenticating every poll', async () => {
  let now = Date.parse('2026-08-27T14:00:00.000Z');
  const mock = cloudMock();
  const client = new TuyaCloudClient({
    clientId: 'client-id', clientSecret: 'client-secret', deviceId: DEVICE_ID,
    fetchImpl: mock.fetchImpl, now: () => now,
  });
  await client.readDevice();
  now += 7_200_000;
  await client.readDevice();
  assert.equal(mock.calls.filter(({ url }) => url.includes('/v1.0/token?')).length, 2);
  assert.ok(mock.calls.every(({ method }) => method === 'GET'));
});

test('Dewin service keeps last valid data, marks errors stale and recovers', async () => {
  let now = Date.parse('2026-08-27T14:00:00.000Z');
  let failing = false;
  const logs = [];
  const errors = [];
  const mock = cloudMock({ fail: (url) => failing && url.endsWith('/status') });
  const client = new TuyaCloudClient({
    clientId: 'client-id', clientSecret: 'client-secret', deviceId: DEVICE_ID,
    fetchImpl: mock.fetchImpl, now: () => now,
  });
  const service = new DewinService({
    client, now: () => now, staleAfterMs: 300_000,
    log: (message) => logs.push(message), logError: (message) => errors.push(message),
  });
  await service.refresh();
  const valid = service.snapshot();
  failing = true;
  now += 60_000;
  await service.refresh();
  const cached = service.snapshot();
  assert.equal(cached.externalProbeTemperature.value, valid.externalProbeTemperature.value);
  assert.equal(cached.updatedAt, valid.updatedAt);
  assert.equal(cached.stale, true);
  await service.refresh();
  assert.equal(errors.filter((message) => message.includes('aggiornamento non riuscito')).length, 1);
  failing = false;
  now += 60_000;
  await service.refresh();
  assert.equal(service.snapshot().stale, false);
  assert.ok(logs.some((message) => message.includes('ripristinato')));
});

test('snapshot becomes stale by age without clearing its values', async () => {
  let now = Date.parse('2026-08-27T14:00:00.000Z');
  const mock = cloudMock();
  const client = new TuyaCloudClient({
    clientId: 'client-id', clientSecret: 'client-secret', deviceId: DEVICE_ID,
    fetchImpl: mock.fetchImpl, now: () => now,
  });
  const service = new DewinService({ client, now: () => now, staleAfterMs: 300_000 });
  await service.refresh();
  now += 300_001;
  const snapshot = service.snapshot();
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.externalProbeTemperature.value, 28.5);
});

test('offline or failed Tuya reads create no samples and persistence resumes on recovery', async () => {
  let mode = 'failure';
  const appended = [];
  const historyStore = {
    appendSample: async (sample) => { appended.push(sample); return true; },
    read: async () => ({ date: '2026-08-27', samples: appended }),
  };
  const client = {
    deviceId: DEVICE_ID,
    async readDevice() {
      if (mode === 'failure') throw new Error('mock Tuya downtime');
      return {
        device: { id: DEVICE_ID, online: mode === 'online', name: 'Dewin', category: 'qxj' },
        specification: specification(), statuses: statuses(),
      };
    },
  };
  const service = new DewinService({ client, historyStore, logError: () => {} });
  await service.refresh();
  mode = 'offline';
  await service.refresh();
  assert.equal(appended.length, 0);
  mode = 'online';
  await service.refresh();
  assert.equal(appended.length, 1);
  assert.equal(appended[0].pond, 28.5);
  assert.equal(appended[0].ambient, 28.9);
});
