import assert from 'node:assert/strict';
import test from 'node:test';
import { devices } from '../devices.js';
import { createDeviceStatusLogger, createPondServer } from '../server.js';

async function withServer(readDevice, callback) {
  const server = createPondServer({
    readDevice,
    now: () => new Date('2026-08-25T12:34:56.000Z'),
    logDeviceStatus: () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function fixture(device) {
  return {
    model: device.model,
    nickname: Buffer.from(`${device.fallbackName} da Tapo`).toString('base64'),
    type: 'SMART.TAPOPLUG',
    device_on: device.id === 'pond-pump',
    rssi: device.id === 'pond-pump' ? -55 : -68,
  };
}

test('GET /api/devices returns both configured devices and no credentials', async () => {
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/devices`);
    assert.equal(response.status, 200);
    const raw = await response.text();
    const payload = JSON.parse(raw);
    assert.equal(payload.devices.length, 2);
    assert.deepEqual(payload.devices.map((device) => device.id), ['pond-pump', 'fan']);
    assert.deepEqual(payload.devices.map((device) => device.name), ['Pompa Laghetto da Tapo', 'Ventilatore da Tapo']);
    assert.ok(payload.devices.every((device) => !Object.hasOwn(device, 'alias')));
    assert.deepEqual(payload.devices.map((device) => device.protocol), ['TPAP/SPAKE2+', 'TPAP/SPAKE2+']);
    assert.ok(payload.devices.every((device) => device.online === true));
    assert.ok(payload.devices.every((device) => device.lastReadAt === '2026-08-25T12:34:56.000Z'));
    assert.doesNotMatch(raw, /TAPO_USERNAME|TAPO_PASSWORD|username|password|token|cookie|stok|sessionId/i);
  });
});

test('device status logger reports initial states and transitions only', () => {
  const logs = [];
  const logStatus = createDeviceStatusLogger((message) => logs.push(message));
  const online = { id: 'fan', model: 'P100M', name: 'Ventilatore', online: true };
  logStatus([online]);
  logStatus([online]);
  logStatus([{ ...online, online: false }]);
  logStatus([{ ...online, online: false }]);
  logStatus([online]);
  assert.deepEqual(logs, [
    '[P100M] Ventilatore - ONLINE',
    '[P100M] OFFLINE',
    '[P100M] ONLINE',
  ]);
});

test('GET /api/devices uses the configured fallback when nickname is unavailable', async () => {
  await withServer(async (device) => ({ ...fixture(device), nickname: '' }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/devices`);
    const payload = await response.json();
    assert.deepEqual(payload.devices.map((device) => device.name), ['Pompa Laghetto', 'Ventilatore']);
  });
});

test('GET /api/devices isolates an offline device', async () => {
  await withServer(async (device) => {
    if (device.id === 'fan') throw new Error('simulated sensitive transport failure');
    return fixture(device);
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/devices`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    const pump = payload.devices.find((device) => device.id === 'pond-pump');
    const fan = payload.devices.find((device) => device.id === 'fan');
    assert.equal(pump.online, true);
    assert.equal(pump.state, 'ON');
    assert.equal(fan.online, false);
    assert.equal(fan.state, null);
    assert.equal(fan.rssi, null);
    assert.doesNotMatch(JSON.stringify(payload), /simulated sensitive transport failure/);
  });
});

test('API exposes no mutating endpoint', async () => {
  let reads = 0;
  await withServer(async (device) => { reads += 1; return fixture(device); }, async (baseUrl) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${baseUrl}/api/devices`, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
    }
    assert.equal(reads, 0);
  });
});

test('static dashboard files are served correctly', async () => {
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const expectations = [
      ['/', 'text/html', 'Pond Control'],
      ['/app.js', 'text/javascript', "fetch('/api/devices'"],
      ['/style.css', 'text/css', '.device-grid'],
    ];
    for (const [pathname, contentType, marker] of expectations) {
      const response = await fetch(`${baseUrl}${pathname}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), new RegExp(contentType));
      assert.match(await response.text(), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});

test('dashboard configuration remains explicit and protocol-based', () => {
  assert.deepEqual(devices.map(({ id, ip, protocol }) => ({ id, ip, protocol })), [
    { id: 'pond-pump', ip: '192.168.1.5', protocol: 'tpap' },
    { id: 'fan', ip: '192.168.1.20', protocol: 'tpap' },
  ]);
});
