import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { devices } from '../devices.js';
import { defaultHardwareRegistry, HardwareRegistryStore, normalizeMac, validateHardwareRegistry, validateIpv4 } from '../src/hardware-registry.js';

const DEWIN = 'T & H Sensor with external probe';
async function withStore(callback, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-hardware-')); const filePath = path.join(directory, 'hardware.json');
  const store = new HardwareRegistryStore({ filePath, defaults: defaultHardwareRegistry({ deviceList: devices, cameraIp: '192.168.1.11', ...options }), idFactory: () => 'generated-id' });
  try { await callback({ store, filePath }); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('registry bootstraps plugs and C410 without persisting logical roles', async () => withStore(async ({ store, filePath }) => {
  const registry = await store.read(); assert.equal(registry.version, 4); assert.equal(registry.plugs.length, 2); assert.equal(registry.cameras[0].model, 'C410');
  assert.ok([...registry.plugs, ...registry.cameras].every((record) => !Object.hasOwn(record, 'role')));
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), registry);
}));

test('Dewin bootstrap migrates non-secret Device ID but no Tuya credentials', () => {
  const registry = defaultHardwareRegistry({ deviceList: devices, dewinDeviceId: 'public-tuya-id' }); const sensor = registry.sensors[0];
  assert.deepEqual({ model: sensor.model, tuyaDeviceId: sensor.tuyaDeviceId, connectionType: sensor.connectionType, provider: sensor.provider }, { model: DEWIN, tuyaDeviceId: 'public-tuya-id', connectionType: 'cloud', provider: 'Tuya Cloud' });
  assert.doesNotMatch(JSON.stringify(registry), /client.?secret|client.?id|password|token|credential/i);
});

test('v3 migration imports missing Dewin Device ID from legacy env without overwriting registry identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-migrate-')); const filePath = path.join(directory, 'hardware.json'); const previous = process.env.TUYA_DEVICE_ID; process.env.TUYA_DEVICE_ID = 'legacy-env-id';
  const legacy = { version: 3, plugs: [], cameras: [], sensors: [{ id: 'dewin-pond', alias: 'Dewin', model: '', protocol: 'tuya-cloud', connectionType: 'cloud', provider: 'Tuya Cloud', role: 'pond_temperature', verificationStatus: 'verified' }] };
  try { await writeFile(filePath, JSON.stringify(legacy)); const store = new HardwareRegistryStore({ filePath, defaults: defaultHardwareRegistry({ deviceList: [] }) }); const migrated = await store.read(); assert.equal(migrated.sensors[0].tuyaDeviceId, 'legacy-env-id'); assert.equal(store.legacyRoleAssignments['dewin-pond'], 'pond_temperature'); assert.ok(!Object.hasOwn(migrated.sensors[0], 'role')); }
  finally { if (previous === undefined) delete process.env.TUYA_DEVICE_ID; else process.env.TUYA_DEVICE_ID = previous; await rm(directory, { recursive: true, force: true }); }
});

test('registry validates IPv4/MAC and duplicate physical identity', () => {
  assert.equal(validateIpv4('192.168.1.25'), '192.168.1.25'); assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
  assert.throws(() => validateIpv4('192.168.1.999'), /IPv4/); assert.throws(() => normalizeMac('bad'), /MAC/);
  const plug = { id: 'p', alias: 'P', model: 'P105', ip: '192.0.2.1', mac: 'AA:BB:CC:DD:EE:01' };
  const camera = { id: 'c', alias: 'C', model: 'C410', ip: '192.0.2.1', mac: 'AA:BB:CC:DD:EE:02' };
  assert.throws(() => validateHardwareRegistry({ plugs: [plug], sensors: [], cameras: [camera] }), (error) => error.code === 'DUPLICATE_IP');
});

test('supported sensor replacement preserves logical id and invalidates verification; alias-only does not', async () => withStore(async ({ store }) => {
  const created = await store.create('sensors', { alias: 'Sonda', model: DEWIN, tuyaDeviceId: 'old-id' }); await store.markVerified('sensors', created.id, { model: DEWIN, deviceId: 'old-id' });
  assert.equal((await store.update('sensors', created.id, { alias: 'Sonda nuova' })).verificationStatus, 'verified');
  const replaced = await store.update('sensors', created.id, { tuyaDeviceId: 'new-id' }); assert.equal(replaced.id, created.id); assert.equal(replaced.verificationStatus, 'pending'); assert.equal(replaced.detected, null);
}));

test('supported C410 replacement invalidates verification and can acquire normalized MAC', async () => withStore(async ({ store }) => {
  const pending = await store.update('cameras', 'tapo-c410-pond', { ip: '192.168.1.12', mac: 'AA:BB:CC:DD:EE:12' }); assert.equal(pending.verificationStatus, 'pending');
  const verified = await store.markVerified('cameras', pending.id, { model: 'C410', mac: 'AA-BB-CC-DD-EE-12' }); assert.equal(verified.mac, 'AA:BB:CC:DD:EE:12'); assert.equal(verified.verificationStatus, 'verified');
}));

test('unknown models and credential-shaped input fields are rejected or discarded', async () => withStore(async ({ store, filePath }) => {
  await assert.rejects(store.create('sensors', { alias: 'X', model: 'T1', tuyaDeviceId: 'x' }), (error) => error.code === 'UNSUPPORTED_MODEL');
  await store.create('sensors', { alias: 'D', model: DEWIN, tuyaDeviceId: 'device-id', clientSecret: 'secret-value' });
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /secret-value|clientSecret/);
}));
