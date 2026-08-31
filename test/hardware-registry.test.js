import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  defaultHardwareRegistry,
  HardwareRegistryStore,
  normalizeMac,
  validateHardwareRegistry,
  validateIpv4,
} from '../src/hardware-registry.js';
import { devices } from '../devices.js';

async function withStore(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-hardware-'));
  const filePath = path.join(directory, 'hardware.json');
  const store = new HardwareRegistryStore({
    filePath,
    defaults: defaultHardwareRegistry({ deviceList: devices, cameraIp: '192.168.1.11' }),
    idFactory: () => 'generated-id',
  });
  try { await callback({ store, filePath }); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('missing hardware file is bootstrapped atomically with current plugs and camera', async () => {
  await withStore(async ({ store, filePath }) => {
    const registry = await store.read();
    assert.deepEqual(registry.plugs.map(({ id, ip, verificationStatus }) => ({ id, ip, verificationStatus })), [
      { id: 'tapo-p105-pond', ip: '192.168.1.5', verificationStatus: 'pending' },
      { id: 'tapo-p100m-pond', ip: '192.168.1.4', verificationStatus: 'pending' },
    ]);
    assert.deepEqual(registry.cameras.map(({ alias, model, role }) => ({ alias, model, role })), [
      { alias: 'C410 Pond', model: 'C410', role: 'pond_camera' },
    ]);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), registry);
  });
});

test('bootstrap includes configured Dewin as a complete cloud sensor without secrets or invented network identity', () => {
  const registry = defaultHardwareRegistry({
    deviceList: devices, cameraIp: '192.168.1.11', dewinConfigured: true,
  });
  assert.deepEqual(registry.sensors, [{
    id: 'dewin-pond', alias: 'Dewin Pond', model: '', type: 'Sensore temperatura con sonda esterna',
    ip: '', mac: '', protocol: 'tuya-cloud', connectionType: 'cloud', provider: 'Tuya Cloud',
    role: 'pond_temperature', configurationStatus: 'complete', verificationStatus: 'verified',
    verifiedAt: null, detected: { provider: 'Tuya Cloud' },
  }]);
  const serialized = JSON.stringify(registry);
  assert.doesNotMatch(serialized, /client.?secret|client.?id|password|token|credential|device.?id/i);
});

test('existing version 1 registry receives Dewin through a one-time migration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-hardware-migration-'));
  const filePath = path.join(directory, 'hardware.json');
  const oldRegistry = defaultHardwareRegistry({ deviceList: devices, cameraIp: '192.168.1.11' });
  await writeFile(filePath, JSON.stringify({ ...oldRegistry, version: 1, sensors: [] }));
  const store = new HardwareRegistryStore({
    filePath,
    defaults: defaultHardwareRegistry({ deviceList: devices, cameraIp: '192.168.1.11', dewinConfigured: true }),
  });
  try {
    const migrated = await store.read();
    assert.equal(migrated.version, 2);
    assert.equal(migrated.sensors[0].id, 'dewin-pond');
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).sensors[0].role, 'pond_temperature');
    await store.update('sensors', 'dewin-pond', { role: 'none' });
    await store.remove('sensors', 'dewin-pond');
    assert.equal((await store.read()).sensors.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('IPv4 and MAC validation accepts normalized values and rejects malformed input', () => {
  assert.equal(validateIpv4('192.168.1.25'), '192.168.1.25');
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
  assert.throws(() => validateIpv4('192.168.1.999'), /IPv4/);
  assert.throws(() => normalizeMac('not-a-mac'), /MAC/);
});

test('registry rejects duplicate ids, IPs, MACs and sensor roles', () => {
  const base = { alias: 'A', model: 'T', protocol: 'none', verificationStatus: 'pending' };
  assert.throws(() => validateHardwareRegistry({
    plugs: [{ ...base, id: 'one', ip: '192.168.1.2', mac: 'AA:BB:CC:DD:EE:01' }],
    sensors: [{ ...base, id: 'two', ip: '192.168.1.2', mac: 'AA:BB:CC:DD:EE:02' }], cameras: [],
  }), (error) => error.code === 'DUPLICATE_IP');
  assert.throws(() => validateHardwareRegistry({
    plugs: [{ ...base, id: 'one', ip: '192.168.1.2', mac: 'AA:BB:CC:DD:EE:01' }],
    sensors: [{ ...base, id: 'two', ip: '192.168.1.3', mac: 'AA:BB:CC:DD:EE:01' }], cameras: [],
  }), (error) => error.code === 'DUPLICATE_MAC');
  assert.throws(() => validateHardwareRegistry({
    plugs: [], cameras: [], sensors: [
      { ...base, id: 'one', ip: '192.168.1.2', mac: 'AA:BB:CC:DD:EE:01', role: 'pond_temperature' },
      { ...base, id: 'two', ip: '192.168.1.3', mac: 'AA:BB:CC:DD:EE:02', role: 'pond_temperature' },
    ],
  }), (error) => error.code === 'DUPLICATE_ROLE');
});

test('create persists records and physical edits reset verification', async () => {
  await withStore(async ({ store, filePath }) => {
    const created = await store.create('sensors', {
      alias: 'Sonda Pond', type: 'Temperatura', model: 'T1', ip: '192.168.1.25',
      mac: 'AA:BB:CC:DD:EE:25', protocol: 'none', role: 'pond_temperature',
    });
    assert.equal(created.id, 'generated-id');
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).sensors.length, 1);
    await store.markVerified('sensors', created.id, { model: 'T1' }, '2026-08-31T12:00:00.000Z');
    assert.equal((await store.read()).sensors[0].verificationStatus, 'verified');
    await store.update('sensors', created.id, { alias: 'Sonda rinominata' });
    assert.equal((await store.read()).sensors[0].verificationStatus, 'verified');
    await store.update('sensors', created.id, { ip: '192.168.1.26' });
    assert.equal((await store.read()).sensors[0].verificationStatus, 'pending');
  });
});

test('cloud sensors require neither IP nor MAC while LAN sensors still do', () => {
  const cloud = validateHardwareRegistry({ plugs: [], cameras: [], sensors: [{
    id: 'cloud', alias: 'Cloud probe', type: 'Temperatura', ip: '', mac: '',
    protocol: 'tuya-cloud', provider: 'Tuya Cloud', connectionType: 'cloud', role: 'pond_temperature',
  }] });
  assert.equal(cloud.sensors[0].configurationStatus, 'complete');
  assert.throws(() => validateHardwareRegistry({ plugs: [], cameras: [], sensors: [{
    id: 'lan', alias: 'LAN probe', type: 'Temperatura', ip: '', mac: '',
    protocol: 'local', connectionType: 'lan', role: 'none',
  }] }), /IPv4/);
});

test('administrative cloud edits preserve verification while technical cloud and LAN edits invalidate it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-hardware-invalidation-'));
  const store = new HardwareRegistryStore({
    filePath: path.join(directory, 'hardware.json'),
    defaults: defaultHardwareRegistry({ deviceList: devices, cameraIp: '192.168.1.11', dewinConfigured: true }),
    idFactory: () => 'lan-sensor',
  });
  try {
    assert.equal((await store.update('sensors', 'dewin-pond', { alias: 'Nuovo alias' })).verificationStatus, 'verified');
    assert.equal((await store.update('sensors', 'dewin-pond', { role: 'none' })).verificationStatus, 'verified');
    assert.equal((await store.update('sensors', 'dewin-pond', { provider: 'Altro provider' })).verificationStatus, 'pending');
    const lan = await store.create('sensors', {
      alias: 'Sonda LAN', type: 'Temperatura', ip: '192.168.1.40', mac: 'AA:BB:CC:DD:EE:40',
      protocol: 'local-v1', connectionType: 'lan', role: 'none',
    });
    await store.markVerified('sensors', lan.id, { protocol: 'local-v1' });
    assert.equal((await store.update('sensors', lan.id, { alias: 'Sonda rinominata' })).verificationStatus, 'verified');
    assert.equal((await store.update('sensors', lan.id, { protocol: 'local-v2' })).verificationStatus, 'pending');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('successful verification acquires and normalizes a missing MAC but rejects a mismatch', async () => {
  await withStore(async ({ store }) => {
    const verified = await store.markVerified('plugs', 'tapo-p105-pond', {
      model: 'P105', mac: '98-03-8E-9C-0C-AF', online: true,
    }, '2026-08-31T12:00:00.000Z');
    assert.equal(verified.mac, '98:03:8E:9C:0C:AF');
    assert.equal(verified.detected.mac, '98:03:8E:9C:0C:AF');
    assert.equal(verified.configurationStatus, 'complete');
    await assert.rejects(store.markVerified('plugs', 'tapo-p105-pond', {
      model: 'P105', mac: '3C-6A-D2-79-F0-D7', online: true,
    }), (error) => error.code === 'MAC_MISMATCH');
    assert.equal((await store.read()).plugs[0].mac, '98:03:8E:9C:0C:AF');
  });
});

test('camera can save a valid IP without MAC and acquires it after read-only verification', async () => {
  await withStore(async ({ store }) => {
    const saved = await store.update('cameras', 'tapo-c410-pond', { ip: '192.168.1.11', mac: '' });
    assert.equal(saved.ip, '192.168.1.11');
    assert.equal(saved.mac, '');
    assert.equal(saved.configurationStatus, 'incomplete');
    const verified = await store.markVerified('cameras', 'tapo-c410-pond', {
      model: 'C410', mac: 'AA-BB-CC-DD-EE-11', online: true,
    });
    assert.equal(verified.mac, 'AA:BB:CC:DD:EE:11');
    assert.equal(verified.detected.mac, 'AA:BB:CC:DD:EE:11');
    assert.equal(verified.configurationStatus, 'complete');
    await assert.rejects(store.markVerified('cameras', 'tapo-c410-pond', {
      model: 'C410', mac: 'AA-BB-CC-DD-EE-12', online: true,
    }), (error) => error.code === 'MAC_MISMATCH');
  });
});

test('removal is blocked while a sensor or camera owns an operational role', async () => {
  await withStore(async ({ store }) => {
    const sensor = await store.create('sensors', {
      alias: 'Sonda Pond', model: 'T1', ip: '192.168.1.25', mac: 'AA:BB:CC:DD:EE:25',
      protocol: 'none', role: 'pond_temperature',
    });
    await assert.rejects(store.remove('sensors', sensor.id), (error) => error.code === 'ROLE_ASSIGNED');
    await store.update('sensors', sensor.id, { role: 'none' });
    await store.remove('sensors', sensor.id);
    assert.equal((await store.read()).sensors.length, 0);
  });
});
