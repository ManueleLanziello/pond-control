import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { devices } from '../devices.js';
import { DeviceRoleStore } from '../src/device-roles.js';
import { defaultHardwareRegistry, HardwareRegistryStore, normalizeMac, validateHardwareRegistry, validateIpv4 } from '../src/hardware-registry.js';
import { RoleRuntimeManager } from '../src/role-runtime-manager.js';
import { isRuntimeEligible, runtimeConfiguration } from '../src/supported-device-catalog.js';

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

test('real SmartHome v3 migration preserves existing and legacy roles before atomically persisting v4', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-real-v3-'));
  const hardwarePath = path.join(directory, 'hardware.json'); const rolesPath = path.join(directory, 'device-roles.json');
  const previousDeviceId = process.env.TUYA_DEVICE_ID; process.env.TUYA_DEVICE_ID = 'legacy-tuya-device-id';
  const fixture = {
    version: 3,
    plugs: [
      { id: 'tapo-p105-pond', alias: 'Pompa', model: 'P105', ip: '192.0.2.5', mac: 'AA:BB:CC:DD:EE:05', protocol: 'tpap', verificationStatus: 'verified' },
      { id: '87521ed0-4fd1-406c-ae23-a5e1b33ea8ad', alias: 'Riscaldatore', model: 'P100M', ip: '192.0.2.4', mac: 'AA:BB:CC:DD:EE:04', protocol: 'tpap', verificationStatus: 'verified' },
    ],
    sensors: [{ id: 'dewin-pond', alias: 'DEWIN Sensore Temperature', model: '', type: 'Sensore temperatura con sonda esterna', ip: '', mac: '', protocol: 'Tuya Cloud', connectionType: 'cloud', provider: 'Tuya Cloud', role: 'pond_temperature', clientSecret: 'do-not-persist-tuya-secret', configurationStatus: 'complete', verificationStatus: 'pending', verifiedAt: null, detected: null }],
    cameras: [{ id: 'tapo-c410-pond', alias: 'C410 Pond', model: 'C410', ip: '192.168.1.11', mac: '30:68:93:2E:83:C2', protocol: 'pytapo-https', role: 'pond_camera', password: 'do-not-persist-camera-password', configurationStatus: 'complete', verificationStatus: 'verified' }],
  };
  const existingRoles = { version: 1, assignments: { 'tapo-p105-pond': 'pump', '87521ed0-4fd1-406c-ae23-a5e1b33ea8ad': 'heater' } };
  const runStartupMigration = async () => {
    const hardwareStore = new HardwareRegistryStore({ hardwarePath, filePath: hardwarePath, defaults: defaultHardwareRegistry({ deviceList: [] }) });
    const registry = await hardwareStore.read(); const all = [...registry.plugs, ...registry.sensors, ...registry.cameras];
    const roleStore = new DeviceRoleStore({ filePath: rolesPath, deviceList: all });
    const assignments = await roleStore.reconcileDevices(all, hardwareStore.legacyRoleAssignments);
    await hardwareStore.completePendingMigration(registry);
    return { registry, assignments, hardwareStore };
  };
  try {
    await writeFile(hardwarePath, JSON.stringify(fixture)); await writeFile(rolesPath, JSON.stringify(existingRoles));
    const interruptedHardwareStore = new HardwareRegistryStore({ filePath: hardwarePath, defaults: defaultHardwareRegistry({ deviceList: [] }) });
    const interruptedRegistry = await interruptedHardwareStore.read(); const interruptedAll = [...interruptedRegistry.plugs, ...interruptedRegistry.sensors, ...interruptedRegistry.cameras];
    const interruptedRoleStore = new DeviceRoleStore({ filePath: rolesPath, deviceList: interruptedAll });
    const importedBeforeCompletion = await interruptedRoleStore.reconcileDevices(interruptedAll, interruptedHardwareStore.legacyRoleAssignments);
    assert.equal(JSON.parse(await readFile(hardwarePath, 'utf8')).version, 3);
    assert.deepEqual(importedBeforeCompletion, { 'tapo-p105-pond': 'pump', '87521ed0-4fd1-406c-ae23-a5e1b33ea8ad': 'heater', 'dewin-pond': 'pond_temperature', 'tapo-c410-pond': 'pond_camera' });
    const first = await runStartupMigration();
    assert.equal(first.registry.sensors[0].model, DEWIN); assert.equal(first.registry.sensors[0].tuyaDeviceId, 'legacy-tuya-device-id');
    assert.deepEqual(first.assignments, { 'tapo-p105-pond': 'pump', '87521ed0-4fd1-406c-ae23-a5e1b33ea8ad': 'heater', 'dewin-pond': 'pond_temperature', 'tapo-c410-pond': 'pond_camera' });
    const persistedHardware = JSON.parse(await readFile(hardwarePath, 'utf8')); assert.equal(persistedHardware.version, 4); assert.ok(!Object.hasOwn(persistedHardware.sensors[0], 'role')); assert.ok(!Object.hasOwn(persistedHardware.cameras[0], 'role'));
    assert.doesNotMatch(JSON.stringify(persistedHardware), /TUYA_CLIENT_ID|TUYA_CLIENT_SECRET|clientSecret|password|token|do-not-persist/i);
    const created = [];
    const sensorRuntimes = new RoleRuntimeManager({ category: 'sensor', emptySnapshot: () => ({}), createRuntime: (record) => { created.push(record.id); return {}; } });
    const cameraRuntimes = new RoleRuntimeManager({ category: 'camera', emptySnapshot: () => ({}), createRuntime: (record) => { created.push(record.id); return {}; } });
    await sensorRuntimes.reconcile(first.registry.sensors.filter((record) => isRuntimeEligible('sensor', record)).map((record) => runtimeConfiguration('sensor', record)), first.assignments);
    await cameraRuntimes.reconcile(first.registry.cameras.filter((record) => isRuntimeEligible('camera', record)).map((record) => runtimeConfiguration('camera', record)), first.assignments);
    assert.deepEqual(created, ['tapo-c410-pond']);
    const uiRoleStore = new DeviceRoleStore({ filePath: rolesPath, deviceList: [...first.registry.plugs, ...first.registry.sensors, ...first.registry.cameras] });
    const manuallyReassigned = await uiRoleStore.assign('tapo-p105-pond', 'heater');
    assert.deepEqual(manuallyReassigned, { 'tapo-p105-pond': 'heater', '87521ed0-4fd1-406c-ae23-a5e1b33ea8ad': 'pump', 'dewin-pond': 'pond_temperature', 'tapo-c410-pond': 'pond_camera' });
    const recovered = await runStartupMigration(); assert.equal(recovered.hardwareStore.pendingMigration, false); assert.deepEqual(recovered.assignments, manuallyReassigned);
    const second = await runStartupMigration(); assert.equal(second.hardwareStore.pendingMigration, false); assert.deepEqual(second.assignments, manuallyReassigned); assert.deepEqual(JSON.parse(await readFile(hardwarePath, 'utf8')), persistedHardware);
  } finally {
    if (previousDeviceId === undefined) delete process.env.TUYA_DEVICE_ID; else process.env.TUYA_DEVICE_ID = previousDeviceId;
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy Dewin protocol variants normalize through integration identity instead of literal spelling', async () => {
  for (const protocol of ['tuya-cloud', 'Tuya Cloud', 'TUYA_CLOUD', ' tuya.cloud ']) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-tuya-variant-')); const filePath = path.join(directory, 'hardware.json');
    try {
      await writeFile(filePath, JSON.stringify({ version: 3, plugs: [], cameras: [], sensors: [{ id: `legacy-${protocol}`, alias: 'Dewin', model: '', type: 'Sensore temperatura con sonda esterna', protocol, provider: 'Tuya Cloud', connectionType: 'CLOUD', verificationStatus: 'pending' }] }));
      const store = new HardwareRegistryStore({ filePath, defaults: defaultHardwareRegistry({ deviceList: [] }) });
      assert.equal((await store.read()).sensors[0].model, DEWIN);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
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
