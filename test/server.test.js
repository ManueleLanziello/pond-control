import assert from 'node:assert/strict';
import test from 'node:test';
import { devices } from '../devices.js';
import { createDeviceStatusLogger, createPondServer } from '../server.js';

const DEVICE_ID_FOR_TEST = 'bf0a19b9163f00415ba1o9';
const DEFAULT_ASSIGNMENTS = {
  'tapo-p105-pond': 'pump',
  'tapo-p100m-pond': 'heater',
};

async function withServer(readDevice, callback, options = {}) {
  const defaultAssignments = { ...DEFAULT_ASSIGNMENTS };
  const snapshots = options.deviceManager ? null : await Promise.all(devices.map(async (device) => {
    try {
      const deviceInfo = await readDevice(device);
      return {
        id: device.id,
        name: Buffer.from(deviceInfo.nickname || '', 'base64').toString('utf8') || device.fallbackName,
        model: deviceInfo.model || device.model,
        ip: device.ip,
        type: deviceInfo.type || device.type,
        state: typeof deviceInfo.device_on === 'boolean' ? (deviceInfo.device_on ? 'ON' : 'OFF') : null,
        rssi: deviceInfo.rssi ?? null,
        protocol: device.protocolLabel,
        online: true,
        communicationDegraded: false,
        consecutiveFailures: 0,
        lastReadAt: '2026-08-25T12:34:56.000Z',
      };
    } catch {
      return {
        id: device.id, name: device.fallbackName, model: device.model, ip: device.ip,
        type: device.type, state: null, rssi: null, protocol: device.protocolLabel,
        online: false, communicationDegraded: true, consecutiveFailures: 3,
        lastReadAt: null,
      };
    }
  }));
  const server = createPondServer({
    deviceManager: options.deviceManager || { snapshots: () => snapshots.map((item) => ({ ...item })) },
    logDeviceStatus: () => {},
    roleStore: { read: async () => ({ ...defaultAssignments }) },
    ...options,
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
    device_on: device.id === 'tapo-p105-pond',
    rssi: device.id === 'tapo-p105-pond' ? -55 : -68,
  };
}

test('GET /api/devices returns both configured devices and no credentials', async () => {
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/devices`);
    assert.equal(response.status, 200);
    const raw = await response.text();
    const payload = JSON.parse(raw);
    assert.equal(payload.devices.length, 2);
    assert.deepEqual(payload.devices.map((device) => device.id), ['tapo-p105-pond', 'tapo-p100m-pond']);
    assert.deepEqual(payload.devices.map((device) => device.role), ['pump', 'heater']);
    assert.deepEqual(payload.devices.map((device) => device.name), ['Presa Tapo P105 da Tapo', 'Presa Tapo P100M da Tapo']);
    assert.ok(payload.devices.every((device) => !Object.hasOwn(device, 'alias')));
    assert.deepEqual(payload.devices.map((device) => device.protocol), ['TPAP/SPAKE2+', 'TPAP/SPAKE2+']);
    assert.ok(payload.devices.every((device) => device.online === true));
    assert.ok(payload.devices.every((device) => device.lastReadAt === '2026-08-25T12:34:56.000Z'));
    assert.doesNotMatch(raw, /TAPO_USERNAME|TAPO_PASSWORD|username|password|token|cookie|stok|sessionId/i);
  });
});

test('GET /api/devices keeps physical data attached to device identity when roles are swapped', async () => {
  const swappedAssignments = {
    'tapo-p105-pond': 'heater',
    'tapo-p100m-pond': 'pump',
  };
  await withServer(async (device) => ({
    model: device.model,
    nickname: Buffer.from(`Alias ${device.model}`).toString('base64'),
    type: device.type,
    device_on: device.id === 'tapo-p100m-pond',
    rssi: device.id === 'tapo-p100m-pond' ? -44 : -77,
  }), async (baseUrl) => {
    const payload = await (await fetch(`${baseUrl}/api/devices`)).json();
    assert.deepEqual(payload.devices.map(({ id, role, model, name, ip, state, rssi }) => ({
      id, role, model, name, ip, state, rssi,
    })), [
      {
        id: 'tapo-p105-pond', role: 'heater', model: 'P105', name: 'Alias P105',
        ip: '192.168.1.5', state: 'OFF', rssi: -77,
      },
      {
        id: 'tapo-p100m-pond', role: 'pump', model: 'P100M', name: 'Alias P100M',
        ip: '192.168.1.4', state: 'ON', rssi: -44,
      },
    ]);
  }, { roleStore: { read: async () => ({ ...swappedAssignments }) } });
});

test('device status logger reports initial states and transitions only', () => {
  const logs = [];
  const logStatus = createDeviceStatusLogger((message) => logs.push(message));
  const online = { id: 'tapo-p100m-pond', role: 'heater', model: 'P100M', name: 'Riscaldatore Pond', online: true };
  logStatus([online]);
  logStatus([online]);
  logStatus([{ ...online, online: false }]);
  logStatus([{ ...online, online: false }]);
  logStatus([online]);
  assert.deepEqual(logs, [
    '[P100M] Riscaldatore Pond - ONLINE',
    '[P100M] OFFLINE',
    '[P100M] ONLINE',
  ]);
});

test('GET /api/devices uses the configured fallback when nickname is unavailable', async () => {
  await withServer(async (device) => ({ ...fixture(device), nickname: '' }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/devices`);
    const payload = await response.json();
    assert.deepEqual(payload.devices.map((device) => device.name), ['Presa Tapo P105', 'Presa Tapo P100M']);
    assert.deepEqual(payload.devices.map((device) => device.role), ['pump', 'heater']);
  });
});

test('a Tapo rename changes name but never id or role', async () => {
  await withServer(async (device) => ({
    ...fixture(device),
    nickname: Buffer.from(`Nome Tapo ${device.model}`).toString('base64'),
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/devices`);
    const payload = await response.json();
    assert.deepEqual(payload.devices.map(({ id, role, name }) => ({ id, role, name })), [
      { id: 'tapo-p105-pond', role: 'pump', name: 'Nome Tapo P105' },
      { id: 'tapo-p100m-pond', role: 'heater', name: 'Nome Tapo P100M' },
    ]);
  });
});

test('GET /api/devices isolates an offline device', async () => {
  await withServer(async (device) => {
    if (device.id === 'tapo-p100m-pond') throw new Error('simulated sensitive transport failure');
    return fixture(device);
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/devices`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    const pump = payload.devices.find((device) => device.id === 'tapo-p105-pond');
    const heater = payload.devices.find((device) => device.id === 'tapo-p100m-pond');
    assert.equal(pump.online, true);
    assert.equal(pump.state, 'ON');
    assert.equal(heater.online, false);
    assert.equal(heater.state, null);
    assert.equal(heater.rssi, null);
    assert.doesNotMatch(JSON.stringify(payload), /simulated sensitive transport failure/);
  });
});

test('PWA assets are served with installable metadata and network-only worker', async () => {
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const [pageResponse, manifestResponse, workerResponse, icon192Response, icon512Response] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/manifest.webmanifest`),
      fetch(`${baseUrl}/service-worker.js`),
      fetch(`${baseUrl}/icons/pond-192.png`),
      fetch(`${baseUrl}/icons/pond-512.png`),
    ]);

    assert.equal(manifestResponse.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
    const manifest = await manifestResponse.json();
    assert.deepEqual({
      name: manifest.name,
      shortName: manifest.short_name,
      startUrl: manifest.start_url,
      scope: manifest.scope,
      display: manifest.display,
      orientation: manifest.orientation,
      themeColor: manifest.theme_color,
      backgroundColor: manifest.background_color,
    }, {
      name: 'Pond Control',
      shortName: 'Pond Control',
      startUrl: './',
      scope: './',
      display: 'standalone',
      orientation: 'landscape',
      themeColor: '#050b12',
      backgroundColor: '#050b12',
    });
    assert.deepEqual(manifest.icons.map(({ src, sizes, type }) => ({ src, sizes, type })), [
      { src: './icons/pond-192.png', sizes: '192x192', type: 'image/png' },
      { src: './icons/pond-512.png', sizes: '512x512', type: 'image/png' },
    ]);

    const page = await pageResponse.text();
    assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(page, /<meta name="theme-color" content="#050b12">/);
    assert.match(page, /<script type="module" src="\/pwa\.js"><\/script>/);

    const worker = await workerResponse.text();
    assert.doesNotMatch(worker, /\bcaches\b|indexedDB|localStorage/);
    assert.match(worker, /!requestUrl\.pathname\.startsWith\('\/api\/'\)/);
    assert.match(worker, /event\.request\.method === 'GET'/);

    for (const [response, expectedSize] of [[icon192Response, 192], [icon512Response, 512]]) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.readUInt32BE(16), expectedSize);
      assert.equal(bytes.readUInt32BE(20), expectedSize);
    }
  });
});

test('camera API exposes status and one explicit ON/OFF toggle without touching other services', async () => {
  const calls = [];
  const cameraManager = {
    snapshot: async () => ({ configured: true, live: false, status: 'READY', imageAvailable: true }),
    imagePath: async () => null,
    start: async () => { calls.push('ON'); return { configured: true, live: true, status: 'LIVE' }; },
    stop: async () => { calls.push('OFF'); return { configured: true, live: false, status: 'READY' }; },
  };
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const status = await fetch(`${baseUrl}/api/camera/status`);
    assert.deepEqual(await status.json(), { configured: true, live: false, status: 'READY', imageAvailable: true });

    const started = await fetch(`${baseUrl}/api/camera/live`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true }),
    });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).live, true);

    const stopped = await fetch(`${baseUrl}/api/camera/live`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }),
    });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).live, false);

    const invalid = await fetch(`${baseUrl}/api/camera/live`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: 'ON' }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(calls, ['ON', 'OFF']);
  }, { cameraManager });
});

test('API exposes no mutating endpoint', async () => {
  let reads = 0;
  const deviceManager = { snapshots: () => [] };
  await withServer(async () => { reads += 1; }, async (baseUrl) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${baseUrl}/api/devices`, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
    }
    assert.equal(reads, 0);
  }, { deviceManager });
});

test('100 GET /api/devices requests use snapshots and cause zero hardware reads or sessions', async () => {
  let snapshots = 0;
  const deviceManager = {
    snapshots() {
      snapshots += 1;
      return devices.map((device) => ({
        id: device.id, name: device.fallbackName, model: device.model, ip: device.ip,
        type: device.type, state: 'OFF', rssi: -60, protocol: device.protocolLabel,
        online: true, communicationDegraded: false, consecutiveFailures: 0,
        lastReadAt: '2026-08-25T12:34:56.000Z',
      }));
    },
  };
  await withServer(async () => { throw new Error('hardware must not be called'); }, async (baseUrl) => {
    await Promise.all(Array.from({ length: 100 }, () => fetch(`${baseUrl}/api/devices`)));
  }, { deviceManager });
  assert.equal(snapshots, 100);
});

test('PUT /api/functions/heater/state accepts only ON/OFF and returns verified state', async () => {
  const calls = [];
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const valid = await fetch(`${baseUrl}/api/functions/heater/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'OFF' }),
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), {
      ok: true, role: 'heater', deviceId: 'tapo-p100m-pond', state: 'OFF',
    });

    for (const body of [{ state: 'TOGGLE' }, { state: true }, { state: 'ON', extra: true }]) {
      const invalid = await fetch(`${baseUrl}/api/functions/heater/state`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(invalid.status, 400);
    }
    assert.deepEqual(calls, ['OFF']);
  }, {
    controlHeaterState: async (state) => {
      calls.push(state);
      return { ok: true, role: 'heater', deviceId: 'tapo-p100m-pond', state };
    },
  });
});

test('PUT /api/functions/pump/state accepts only ON/OFF and returns verified state', async () => {
  const calls = [];
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const valid = await fetch(`${baseUrl}/api/functions/pump/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'OFF' }),
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), {
      ok: true, role: 'pump', deviceId: 'tapo-p105-pond', state: 'OFF',
    });
    for (const body of [{ state: 'TOGGLE' }, { state: false }, { state: 'ON', extra: true }]) {
      const invalid = await fetch(`${baseUrl}/api/functions/pump/state`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(invalid.status, 400);
    }
    assert.deepEqual(calls, ['OFF']);
  }, {
    controlPumpState: async (state) => {
      calls.push(state);
      return { ok: true, role: 'pump', deviceId: 'tapo-p105-pond', state };
    },
  });
});

test('static dashboard files are served correctly', async () => {
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const expectations = [
      ['/', 'text/html', 'Pond Control'],
      ['/app.js', 'text/javascript', "fetch('/api/devices'"],
      ['/camera-view.js', 'text/javascript', '/api/camera/live'],
      ['/dashboard-model.js', 'text/javascript', 'buildDashboardFunctions'],
      ['/dewin-view.js', 'text/javascript', 'dewinCardView'],
      ['/temperature-chart.js', 'text/javascript', 'TEMPERATURE_CHART_RANGE'],
      ['/heater-control.js', 'text/javascript', 'requestHeaterState'],
      ['/pump-control.js', 'text/javascript', 'requestPumpState'],
      ['/weather-icons.js', 'text/javascript', 'weatherIconForCode'],
      ['/style.css', 'text/css', '.device-grid'],
      ['/settings', 'text/html', 'Telecamere'],
      ['/settings.js', 'text/javascript', '/api/hardware'],
    ];
    for (const [pathname, contentType, marker] of expectations) {
      const response = await fetch(`${baseUrl}${pathname}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), new RegExp(contentType));
      assert.match(await response.text(), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});

test('all Pond Control SVG icons are served with the SVG content type', async () => {
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    for (const icon of [
      'pond.svg',
      'battery.svg',
      'pump.svg',
      'heater.svg',
      'history.svg',
      'cloud.svg',
      'thermometer.svg',
      'termos.svg',
      'termotime.svg',
      'umidity.svg',
      'update.svg',
      'weather.svg',
      'wind.svg',
      'wifi.svg',
      'network.svg',
      'p100m.svg',
      'p105.svg',
      'shield.svg',
      'power.svg',
      'poweroff.svg',
      'poweron.svg',
      'rain.svg',
      'settings.svg',
      'snow.svg',
      'storm.svg',
      'sun.svg',
    ]) {
      const response = await fetch(`${baseUrl}/icons/${icon}`);
      assert.equal(response.status, 200, icon);
      assert.equal(response.headers.get('content-type'), 'image/svg+xml', icon);
      assert.match(await response.text(), /^<svg\b/, icon);
    }
  });
});

test('GET /api/weather returns only the cached weather snapshot', async () => {
  let snapshotReads = 0;
  const weather = {
    location: 'Rivarolo Canavese', temperature: 27.4, condition: 'Sereno', weatherCode: 0,
    min: 18.2, max: 29.1, rainProbability: 10, windSpeed: 8.4,
    updatedAt: '2026-08-26T12:00:00.000Z', stale: false, available: true, forecast: [],
  };
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/weather`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), weather);
  }, { weatherService: { snapshot: () => { snapshotReads += 1; return weather; } } });
  assert.equal(snapshotReads, 1);
});

test('GET /api/dewin returns only the cached read-only Dewin snapshot', async () => {
  let snapshotReads = 0;
  const dewin = {
    available: true, online: true, deviceId: DEVICE_ID_FOR_TEST, name: 'T & H Sensor with external probe',
    category: 'qxj', ambientTemperature: { value: 28.9, unit: '°C', raw: 289, scale: 1 },
    ambientHumidity: { value: 56, unit: '%', raw: 56, scale: 0 }, batteryState: { value: 'high', raw: 'high' },
    externalProbeTemperature: { value: 28.5, unit: '°C', raw: 285, scale: 1 },
    datapoints: [], updatedAt: '2026-08-27T14:00:00.000Z', stale: false,
  };
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dewin`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), dewin);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const rejected = await fetch(`${baseUrl}/api/dewin`, { method });
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get('allow'), 'GET');
    }
  }, { dewinService: { snapshot: () => { snapshotReads += 1; return dewin; } } });
  assert.equal(snapshotReads, 1);
});

test('GET /api/dewin/history supports an explicit date and defaults through Europe/Rome store', async () => {
  const requestedDates = [];
  const dewinService = {
    snapshot: () => ({ available: false, stale: true, datapoints: [] }),
    history: async (date) => {
      requestedDates.push(date);
      return { date: date || '2026-08-27', samples: [{ timestamp: '2026-08-27T14:00:00.000Z', pond: 28.5, ambient: 28.9 }] };
    },
  };
  await withServer(async (device) => fixture(device), async (baseUrl) => {
    const explicit = await fetch(`${baseUrl}/api/dewin/history?date=2026-08-26`);
    assert.deepEqual(await explicit.json(), {
      date: '2026-08-26', samples: [{ timestamp: '2026-08-27T14:00:00.000Z', pond: 28.5, ambient: 28.9 }],
    });
    const current = await fetch(`${baseUrl}/api/dewin/history`);
    assert.equal((await current.json()).date, '2026-08-27');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const rejected = await fetch(`${baseUrl}/api/dewin/history`, { method });
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get('allow'), 'GET');
    }
  }, { dewinService });
  assert.deepEqual(requestedDates, ['2026-08-26', undefined]);
});

test('physical device configuration keeps stable ids and contains no logical roles', () => {
  assert.deepEqual(devices.map(({ id, fallbackName, model, ip, protocol }) => ({
    id, fallbackName, model, ip, protocol,
  })), [
    {
      id: 'tapo-p105-pond', fallbackName: 'Presa Tapo P105',
      model: 'P105', ip: '192.168.1.5', protocol: 'tpap',
    },
    {
      id: 'tapo-p100m-pond', fallbackName: 'Presa Tapo P100M',
      model: 'P100M', ip: '192.168.1.4', protocol: 'tpap',
    },
  ]);
  assert.ok(devices.every((device) => !Object.hasOwn(device, 'role')));
});
