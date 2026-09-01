import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { devices } from '../devices.js';
import { DeviceRoleStore, VALID_DEVICE_ROLES } from '../src/device-roles.js';
import { createPondServer } from '../server.js';
import { defaultHardwareRegistry, HardwareRegistryStore } from '../src/hardware-registry.js';

async function withRoleStore(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-control-roles-'));
  const filePath = path.join(directory, 'device-roles.json');
  const store = new DeviceRoleStore({ filePath, deviceList: devices });
  try {
    await callback({ store, filePath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withRoleServer(store, callback) {
  let tapoReads = 0;
  const hardwareStore = new HardwareRegistryStore({
    filePath: path.join(path.dirname(store.filePath), 'hardware.json'),
    defaults: defaultHardwareRegistry({ deviceList: devices }),
  });
  await hardwareStore.read();
  await hardwareStore.markVerified('plugs', 'tapo-p105-pond', { model: 'P105', mac: 'AA:BB:CC:DD:EE:05' });
  await hardwareStore.markVerified('plugs', 'tapo-p100m-pond', { model: 'P100M', mac: 'AA:BB:CC:DD:EE:00' });
  const runtimeIds = new Set(devices.map(({ id }) => id));
  const server = createPondServer({
    roleStore: store,
    hardwareStore,
    deviceManager: {
      reconcileDevices: (configured) => { runtimeIds.clear(); configured.forEach(({ id }) => runtimeIds.add(id)); },
      hasDevice: (id) => runtimeIds.has(id),
      snapshots: () => devices.filter(({ id }) => runtimeIds.has(id)).map((device) => ({
        id: device.id, name: device.fallbackName, model: device.model, ip: device.ip, online: false,
      })),
    },
    readDevice: async () => { tapoReads += 1; return {}; },
    logDeviceStatus: () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`, () => tapoReads);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('valid roles are limited to pump, heater and none', () => {
  assert.deepEqual(VALID_DEVICE_ROLES, ['pump', 'heater', 'none']);
});

test('stable device ids do not depend on role or nickname', () => {
  assert.deepEqual(devices.map(({ id, model }) => ({ id, model })), [
    { id: 'tapo-p105-pond', model: 'P105' },
    { id: 'tapo-p100m-pond', model: 'P100M' },
  ]);
});

test('role assignments persist and transfer an occupied role to the selected device', async () => {
  await withRoleStore(async ({ store, filePath }) => {
    assert.deepEqual(await store.read(), {
      'tapo-p105-pond': 'none',
      'tapo-p100m-pond': 'none',
    });
    const assignments = await store.assign('tapo-p100m-pond', 'pump');
    assert.deepEqual(assignments, {
      'tapo-p105-pond': 'none',
      'tapo-p100m-pond': 'pump',
    });
    const reloaded = new DeviceRoleStore({ filePath, deviceList: devices });
    assert.deepEqual(await reloaded.read(), assignments);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).assignments, assignments);
  });
});

test('assigning an occupied operational role atomically swaps and persists pump and heater', async () => {
  await withRoleStore(async ({ store, filePath }) => {
    await store.assign('tapo-p100m-pond', 'pump');
    assert.deepEqual(await store.assign('tapo-p105-pond', 'heater'), {
      'tapo-p105-pond': 'heater',
      'tapo-p100m-pond': 'pump',
    });
    assert.deepEqual(await store.assign('tapo-p100m-pond', 'heater'), {
      'tapo-p105-pond': 'pump',
      'tapo-p100m-pond': 'heater',
    });
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).assignments, {
      'tapo-p105-pond': 'pump',
      'tapo-p100m-pond': 'heater',
    });
  });
});

test('invalid roles and unknown device ids are rejected', async () => {
  await withRoleStore(async ({ store }) => {
    await assert.rejects(store.assign('tapo-p105-pond', 'filter'), /Ruolo non valido/);
    await assert.rejects(store.assign('nickname-tapo', 'pump'), /Dispositivo non configurato/);
  });
});

test('role API writes only local configuration and never reads or writes a Tapo device', async () => {
  await withRoleStore(async ({ store }) => {
    await withRoleServer(store, async (baseUrl, tapoReads) => {
      const configuration = await fetch(`${baseUrl}/api/device-roles`);
      assert.equal(configuration.status, 200);
      assert.deepEqual(await configuration.json(), {
        validRoles: ['pump', 'heater', 'none'],
        assignments: {
          'tapo-p105-pond': 'none',
          'tapo-p100m-pond': 'none',
        },
      });
      assert.equal(tapoReads(), 0);

      const response = await fetch(`${baseUrl}/api/device-roles/tapo-p100m-pond`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'pump' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).assignments, {
        'tapo-p105-pond': 'none',
        'tapo-p100m-pond': 'pump',
      });
      assert.equal(tapoReads(), 0);

      const invalid = await fetch(`${baseUrl}/api/device-roles/tapo-p100m-pond`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'invalid' }),
      });
      assert.equal(invalid.status, 400);
      assert.equal(tapoReads(), 0);
    });
  });
});
