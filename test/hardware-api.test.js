import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { devices } from '../devices.js';
import { createPondServer } from '../server.js';
import { defaultHardwareRegistry, HardwareRegistryStore } from '../src/hardware-registry.js';

async function withHardwareApi(callback, { dewinConfigured = false, dewinSnapshot = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-hardware-api-'));
  const hardwareStore = new HardwareRegistryStore({
    filePath: path.join(directory, 'hardware.json'),
    defaults: defaultHardwareRegistry({ deviceList: devices, cameraIp: '192.168.1.11', dewinConfigured }),
    idFactory: () => 'sensor-generated',
  });
  const assignments = { 'tapo-p105-pond': 'pump', 'tapo-p100m-pond': 'heater' };
  const roleStore = {
    read: async () => ({ ...assignments }),
    assign: async (id, role) => {
      if (role !== 'none') {
        for (const deviceId of Object.keys(assignments)) if (assignments[deviceId] === role) assignments[deviceId] = 'none';
      }
      assignments[id] = role;
      return { ...assignments };
    },
  };
  const verificationCalls = [];
  const verifyPlug = async (configured) => {
    verificationCalls.push({ kind: 'plug', configured });
    return { model: configured.model, alias: configured.alias, mac: configured.mac, protocol: 'TPAP/SPAKE2+', online: true, rssi: -51 };
  };
  const verifyCamera = async (configured) => {
    verificationCalls.push({ kind: 'camera', configured });
    return { model: configured.model, alias: configured.alias, mac: configured.mac, protocol: 'PyTapo HTTPS', online: true };
  };
  const deviceManager = { snapshots: () => devices.map((device) => ({
    id: device.id, name: device.fallbackName, model: device.model, ip: device.ip,
    protocol: device.protocolLabel, online: true, state: 'OFF', rssi: -55,
  })) };
  const dewinService = {
    snapshot: () => {
      dewinService.snapshotCalls += 1;
      return dewinSnapshot || ({ available: false, online: false });
    },
    history: async () => ({ samples: [] }), start: async () => {}, stop: () => {},
    snapshotCalls: 0,
  };
  const server = createPondServer({
    hardwareStore, roleStore, deviceManager, verifyPlug, verifyCamera, dewinService, logDeviceStatus: () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { await callback({ baseUrl, hardwareStore, assignments, verificationCalls, dewinService }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { response, payload: await response.json() };
}

test('first hardware API read bootstraps the missing file and preserves runtime roles', async () => {
  await withHardwareApi(async ({ baseUrl, hardwareStore, assignments }) => {
    const { response, payload } = await jsonRequest(baseUrl, '/api/hardware');
    assert.equal(response.status, 200);
    assert.deepEqual(payload.plugs.map(({ id, role, online, state, rssi }) => ({ id, role, online, state, rssi })), [
      { id: 'tapo-p105-pond', role: 'pump', online: true, state: 'OFF', rssi: -55 },
      { id: 'tapo-p100m-pond', role: 'heater', online: true, state: 'OFF', rssi: -55 },
    ]);
    assert.equal(payload.cameras[0].alias, 'C410 Pond');
    assert.equal(payload.cameras[0].ip, '192.168.1.11');
    assert.ok(payload.plugs.every((plug) => plug.runtimeSupported === true));
    assert.deepEqual(assignments, { 'tapo-p105-pond': 'pump', 'tapo-p100m-pond': 'heater' });
    assert.deepEqual((await hardwareStore.read()).plugs.map((plug) => plug.id), devices.map((device) => device.id));
    assert.deepEqual(payload.roles.sensors, ['none', 'pond_temperature', 'external_temperature']);
    assert.deepEqual(payload.roles.cameras, ['none', 'pond_camera']);
  });
});

test('hardware API represents configured Dewin role and current DewinService status', async () => {
  await withHardwareApi(async ({ baseUrl }) => {
    const payload = await (await fetch(`${baseUrl}/api/hardware`)).json();
    assert.deepEqual(payload.sensors.map(({ id, role, connectionType, online, configurationStatus }) => ({
      id, role, connectionType, online, configurationStatus,
    })), [{
      id: 'dewin-pond', role: 'pond_temperature', connectionType: 'cloud', online: true, configurationStatus: 'complete',
    }]);
  }, { dewinConfigured: true, dewinSnapshot: { available: true, online: true } });
});

test('Dewin alias and role edits stay verified and manual verification reuses one cached snapshot', async () => {
  await withHardwareApi(async ({ baseUrl, hardwareStore, dewinService }) => {
    for (const change of [{ alias: 'Dewin rinominato' }, { role: 'external_temperature' }]) {
      const updated = await jsonRequest(baseUrl, '/api/hardware/sensors/dewin-pond', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change),
      });
      assert.equal(updated.response.status, 200);
      assert.equal(updated.payload.device.verificationStatus, 'verified');
    }
    assert.equal(dewinService.snapshotCalls, 0);
    const verified = await jsonRequest(baseUrl, '/api/hardware/sensors/dewin-pond/verify', { method: 'POST' });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.payload.device.verificationStatus, 'verified');
    assert.equal(dewinService.snapshotCalls, 1);
    assert.equal((await hardwareStore.read()).sensors[0].alias, 'Dewin rinominato');
  }, {
    dewinConfigured: true,
    dewinSnapshot: { available: true, online: true, updatedAt: '2026-08-31T12:00:00.000Z' },
  });
});

test('registry-only plug cannot take pump or heater from runtime devices', async () => {
  await withHardwareApi(async ({ baseUrl, assignments, verificationCalls }) => {
    const configured = {
      alias: 'Presa futura', model: 'P110', ip: '192.168.1.30', mac: 'AA:BB:CC:DD:EE:30',
      protocol: 'tpap', role: 'none',
    };
    const created = await jsonRequest(baseUrl, '/api/hardware/plugs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(configured),
    });
    assert.equal(created.response.status, 201);
    const id = created.payload.device.id;
    for (const role of ['pump', 'heater']) {
      const attempted = await jsonRequest(baseUrl, `/api/hardware/plugs/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }),
      });
      assert.equal(attempted.response.status, 400);
      assert.equal(attempted.payload.code, 'RUNTIME_DEVICE_UNSUPPORTED');
      assert.deepEqual(assignments, { 'tapo-p105-pond': 'pump', 'tapo-p100m-pond': 'heater' });
    }
    const registry = await (await fetch(`${baseUrl}/api/hardware`)).json();
    const future = registry.plugs.find((plug) => plug.id === id);
    assert.equal(future.role, 'none');
    assert.equal(future.runtimeSupported, false);
    assert.equal(verificationCalls.length, 1);
  });
});

test('plug role transfer is delegated to the existing runtime role store', async () => {
  await withHardwareApi(async ({ baseUrl, assignments }) => {
    const { response } = await jsonRequest(baseUrl, '/api/hardware/plugs/tapo-p100m-pond', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'pump' }),
    });
    assert.equal(response.status, 200);
    assert.equal(assignments['tapo-p100m-pond'], 'pump');
    assert.equal(assignments['tapo-p105-pond'], 'none');
  });
});

test('read-only verification records detected data without any control method', async () => {
  await withHardwareApi(async ({ baseUrl, verificationCalls }) => {
    const { response, payload } = await jsonRequest(baseUrl, '/api/hardware/plugs/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        alias: 'Presa test', model: 'P110', ip: '192.168.1.30', mac: 'AA:BB:CC:DD:EE:30', protocol: 'tpap', role: 'none',
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(payload.verified, true);
    assert.equal(verificationCalls.length, 1);
    assert.equal(verificationCalls[0].configured.ip, '192.168.1.30');
  });
});

test('camera API accepts an IP edit while MAC is still unknown without running a probe', async () => {
  await withHardwareApi(async ({ baseUrl, verificationCalls }) => {
    const { response, payload } = await jsonRequest(baseUrl, '/api/hardware/cameras/tapo-c410-pond', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: '192.168.1.11', mac: '' }),
    });
    assert.equal(response.status, 200);
    assert.equal(payload.device.ip, '192.168.1.11');
    assert.equal(payload.device.mac, '');
    assert.equal(payload.device.configurationStatus, 'incomplete');
    assert.equal(verificationCalls.length, 0);
  });
});

test('sensor persistence is available while verification remains explicitly unavailable', async () => {
  await withHardwareApi(async ({ baseUrl, hardwareStore }) => {
    const sensor = {
      alias: 'Sonda Pond', model: 'T1', ip: '192.168.1.25', mac: 'AA:BB:CC:DD:EE:25',
      protocol: 'none', role: 'pond_temperature',
    };
    const created = await jsonRequest(baseUrl, '/api/hardware/sensors', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sensor),
    });
    assert.equal(created.response.status, 201);
    assert.equal((await hardwareStore.read()).sensors[0].verificationStatus, 'pending');
    const verified = await jsonRequest(baseUrl, `/api/hardware/sensors/${created.payload.device.id}/verify`, { method: 'POST' });
    assert.equal(verified.response.status, 501);
  });
});

test('removal of a device with an operational role is blocked', async () => {
  await withHardwareApi(async ({ baseUrl }) => {
    const { response, payload } = await jsonRequest(baseUrl, '/api/hardware/plugs/tapo-p105-pond', { method: 'DELETE' });
    assert.equal(response.status, 400);
    assert.equal(payload.code, 'ROLE_ASSIGNED');
  });
});

test('hardware verifier source contains read operations and no plug control calls', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/hardware-verifier.js', import.meta.url), 'utf8'));
  assert.match(source, /getDeviceInfo\(\)/);
  assert.match(source, /discoverProtocol\(\)/);
  assert.doesNotMatch(source, /setDeviceOn|setDeviceOff|setPower|toggle/i);
});

test('production startup materializes the local hardware registry before listening', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../server.js', import.meta.url), 'utf8'));
  const startup = source.slice(source.indexOf('if (isMain)'), source.indexOf("process.once('SIGINT'"));
  assert.match(startup, /const hardwareStore = new HardwareRegistryStore/);
  assert.match(startup, /await hardwareStore\.read\(\)/);
  assert.ok(startup.indexOf('await hardwareStore.read()') < startup.indexOf("server.listen(3000"));
  assert.doesNotMatch(startup, /writeFile\([^\n]*(?:\.env|device-roles)/);
});
