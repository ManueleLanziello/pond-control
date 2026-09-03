import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceRoleStore } from '../src/device-roles.js';
import { HardwareRegistryStore, defaultHardwareRegistry } from '../src/hardware-registry.js';
import { RoleRuntimeManager } from '../src/role-runtime-manager.js';
import {
  SUPPORTED_CAMERA_MODELS, SUPPORTED_DEVICE_MODELS, SUPPORTED_SENSOR_MODELS,
  runtimeConfiguration, supportedCameraModel, supportedSensorModel,
} from '../src/supported-device-catalog.js';

const SENSOR_MODEL = 'T & H Sensor with external probe';
const sensor = (id, tuyaDeviceId) => ({ id, alias: id, model: SENSOR_MODEL, tuyaDeviceId, verificationStatus: 'verified', configurationStatus: 'complete' });
const camera = (id, ip, mac) => ({ id, alias: id, model: 'C410', ip, mac, verificationStatus: 'verified', configurationStatus: 'complete' });

test('supported catalog describes real Dewin/Tuya and C410/PyTapo integrations without instance identity or secrets', () => {
  const dewin = supportedSensorModel(SENSOR_MODEL); const c410 = supportedCameraModel('C410');
  assert.equal(SUPPORTED_SENSOR_MODELS.length, 1); assert.equal(SUPPORTED_CAMERA_MODELS.length, 1);
  assert.deepEqual({ category: dewin.category, connectionType: dewin.connectionType, provider: dewin.provider, adapter: dewin.adapter }, { category: 'sensor', connectionType: 'cloud', provider: 'Tuya Cloud', adapter: 'tuya-cloud' });
  for (const capability of ['external_probe_temperature', 'ambient_temperature', 'humidity', 'battery', 'timestamp']) assert.ok(dewin.capabilities.includes(capability));
  assert.deepEqual({ category: c410.category, connectionType: c410.connectionType, adapter: c410.adapter, streamAdapter: c410.streamAdapter }, { category: 'camera', connectionType: 'lan', adapter: 'pytapo-https', streamAdapter: 'pytapo-media-ffmpeg' });
  assert.ok(c410.capabilities.includes('snapshot')); assert.ok(c410.capabilities.includes('live_stream'));
  const serialized = JSON.stringify(SUPPORTED_DEVICE_MODELS);
  assert.doesNotMatch(serialized, /192\.168\.|mac|secret|password|token/i);
});

test('runtime configuration derives static fields and accepts only instance identity from hardware', () => {
  assert.deepEqual(runtimeConfiguration('sensor', sensor('s1', 'tuya-new')), {
    id: 's1', fallbackName: 's1', model: SENSOR_MODEL, manufacturer: 'Dewin', adapter: 'tuya-cloud',
    protocol: 'tuya-cloud', protocolLabel: 'Tuya Cloud HTTPS', connectionType: 'cloud',
    type: 'Sensore temperatura con sonda esterna', tuyaDeviceId: 'tuya-new',
  });
  assert.equal(runtimeConfiguration('camera', camera('c1', '192.0.2.4', 'AA:BB:CC:DD:EE:04')).ip, '192.0.2.4');
});

test('sensor replacement invalidates old runtime, clears stale snapshot and preserves alias-only runtime', async () => {
  const stopped = []; const created = [];
  const manager = new RoleRuntimeManager({ category: 'sensor', emptySnapshot: () => ({ available: false }), createRuntime: (record) => {
    created.push(record.tuyaDeviceId); return { snapshot: () => ({ available: true, source: record.tuyaDeviceId }), stop: () => stopped.push(record.tuyaDeviceId) };
  } });
  await manager.reconcile([sensor('logical', 'old')], { logical: 'pond_temperature' });
  assert.equal((await manager.snapshot('pond_temperature')).source, 'old');
  await manager.reconcile([], { logical: 'pond_temperature' });
  assert.deepEqual(await manager.snapshot('pond_temperature'), { available: false }); assert.deepEqual(stopped, ['old']);
  await manager.reconcile([sensor('logical', 'new')], { logical: 'pond_temperature' });
  assert.equal((await manager.snapshot('pond_temperature')).source, 'new');
  await manager.reconcile([{ ...sensor('logical', 'new'), alias: 'renamed' }], { logical: 'pond_temperature' });
  assert.deepEqual(created, ['old', 'new']);
});

test('camera role reassignment switches status, snapshot and live runtime without stale fallback', async () => {
  const stopped = []; const manager = new RoleRuntimeManager({ category: 'camera', emptySnapshot: () => ({ configured: false, imageAvailable: false }), createRuntime: (record) => ({
    snapshot: () => ({ configured: true, source: record.ip }), imagePath: () => `${record.ip}.jpg`, start: () => ({ source: record.ip }), stop: () => { stopped.push(record.ip); },
  }) });
  const records = [camera('a', '192.0.2.1', 'AA:BB:CC:DD:EE:01'), camera('b', '192.0.2.2', 'AA:BB:CC:DD:EE:02')];
  await manager.reconcile(records, { a: 'pond_camera', b: 'none' }); assert.equal(await manager.imagePath('pond_camera'), '192.0.2.1.jpg');
  await manager.reconcile(records, { a: 'none', b: 'pond_camera' }); assert.equal((await manager.snapshot('pond_camera')).source, '192.0.2.2'); assert.equal((await manager.start('pond_camera')).source, '192.0.2.2');
  await manager.reconcile([], { b: 'pond_camera' }); assert.deepEqual(await manager.snapshot('pond_camera'), { configured: false, imageAvailable: false }); assert.ok(stopped.includes('192.0.2.2'));
});

test('snapshot waits for reconciliation and never observes the runtime replacement gap', async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const manager = new RoleRuntimeManager({
    category: 'sensor', autoStart: true, emptySnapshot: () => ({ available: false }),
    createRuntime: (record) => ({
      start: () => record.tuyaDeviceId === 'new' ? startGate : undefined,
      snapshot: () => ({ available: true, source: record.tuyaDeviceId }),
      stop: () => {},
    }),
  });
  await manager.reconcile([sensor('logical', 'old')], { logical: 'pond_temperature' });
  const replacing = manager.reconcile([sensor('logical', 'new')], { logical: 'pond_temperature' });
  let snapshotSettled = false;
  const snapshot = manager.snapshot('pond_temperature').then((value) => { snapshotSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshotSettled, false);
  releaseStart();
  await replacing;
  assert.equal((await snapshot).source, 'new');
});

test('a failed runtime reconciliation does not poison all later reconciliations', async () => {
  let fail = true;
  const manager = new RoleRuntimeManager({
    category: 'sensor', emptySnapshot: () => ({ available: false }),
    createRuntime: (record) => {
      if (fail) throw new Error('simulated runtime construction failure');
      return { snapshot: () => ({ available: true, source: record.tuyaDeviceId }) };
    },
  });
  await assert.rejects(manager.reconcile([sensor('logical', 'one')], { logical: 'pond_temperature' }));
  assert.equal(manager.recordIdForRole('pond_temperature'), 'logical');
  fail = false;
  await manager.reconcile([sensor('logical', 'one')], { logical: 'pond_temperature' });
  assert.equal((await manager.snapshot('pond_temperature')).source, 'one');
});

test('role store atomically transfers sensor and camera roles and remains the only persisted role source', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-role-all-')); const filePath = path.join(directory, 'roles.json');
  const devices = [sensor('s1', 'one'), sensor('s2', 'two'), camera('c1', '192.0.2.1', 'AA:BB:CC:DD:EE:01'), camera('c2', '192.0.2.2', 'AA:BB:CC:DD:EE:02')];
  try {
    const store = new DeviceRoleStore({ filePath, deviceList: devices });
    await store.assign('s1', 'pond_temperature'); await store.assign('s2', 'pond_temperature');
    await store.assign('c1', 'pond_camera'); await store.assign('c2', 'pond_camera');
    assert.deepEqual(await store.read(), { s1: 'none', s2: 'pond_temperature', c1: 'none', c2: 'pond_camera' });
    await assert.rejects(store.assign('s1', 'pond_camera'), /Ruolo non valido/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('registry rejects unknown sensor/camera and never serializes credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-hardware-safe-')); const filePath = path.join(directory, 'hardware.json');
  const store = new HardwareRegistryStore({ filePath, defaults: defaultHardwareRegistry({ deviceList: [], cameraIp: '' }) });
  try {
    await assert.rejects(store.create('sensors', { alias: 'x', model: 'unknown', tuyaDeviceId: 'id' }), (error) => error.code === 'UNSUPPORTED_MODEL');
    await assert.rejects(store.create('cameras', { alias: 'x', model: 'unknown', ip: '192.0.2.1', mac: 'AA:BB:CC:DD:EE:01' }), (error) => error.code === 'UNSUPPORTED_MODEL');
    await store.create('sensors', { id: 's1', alias: 'Sonda', model: SENSOR_MODEL, tuyaDeviceId: 'public-device-id', clientSecret: 'never', password: 'never' });
    const raw = await readFile(filePath, 'utf8'); assert.match(raw, /public-device-id/); assert.doesNotMatch(raw, /clientSecret|password|never/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Settings forms expose only supported model and per-instance fields for sensors/cameras', async () => {
  const [html, script] = await Promise.all([readFile(new URL('../public/settings.html', import.meta.url), 'utf8'), readFile(new URL('../public/settings.js', import.meta.url), 'utf8')]);
  assert.match(html, /hardware-tuya-id/); assert.match(script, /supportedSensorModels/); assert.match(script, /supportedCameraModels/);
  assert.match(script, /hardware-connection-field'\)\.hidden = true/); assert.match(script, /hardware-provider-field'\)\.hidden = true/);
  assert.match(script, /hardware-ip-field'\)\.hidden = sensor/); assert.match(script, /hardware-mac-field'\)\.hidden = sensor/);
});
