import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
