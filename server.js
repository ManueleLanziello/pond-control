import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { devices as defaultDevices } from './devices.js';
import { KlapV2Client } from './src/klap/client.js';
import { error, info } from './src/logger.js';
import { TpapClient } from './src/tpap/client.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(ROOT, '.env'));
const PUBLIC_ROOT = path.join(ROOT, 'public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function decodeAlias(value) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const input = value.replace(/=+$/, '');
    const roundTrip = Buffer.from(decoded).toString('base64').replace(/=+$/, '');
    return decoded && roundTrip === input ? decoded : value;
  } catch { return value; }
}

function credentialsFromEnvironment() {
  const username = process.env.TAPO_USERNAME?.trim();
  const password = process.env.TAPO_PASSWORD;
  if (!username || !password) throw new Error('Credenziali Tapo non disponibili nel processo server.');
  return { username, password };
}

export async function readConfiguredDevice(device) {
  const credentials = credentialsFromEnvironment();
  const options = {
    ip: device.ip,
    ...credentials,
    timeout: Number(process.env.TAPO_DEVICE_TIMEOUT_MS || 5000),
  };
  const client = device.protocol === 'tpap'
    ? new TpapClient(options)
    : device.protocol === 'klap'
      ? new KlapV2Client(options)
      : null;
  if (!client) throw new Error(`Protocollo non supportato: ${device.protocol}`);
  try {
    return await client.getDeviceInfo();
  } finally {
    client.close();
  }
}

function publicDevice(device, info, online, lastReadAt) {
  return {
    id: device.id,
    name: decodeAlias(info?.nickname) || device.fallbackName,
    model: info?.model || device.model,
    ip: device.ip,
    type: info?.type || device.type,
    state: typeof info?.device_on === 'boolean' ? (info.device_on ? 'ON' : 'OFF') : null,
    rssi: typeof info?.rssi === 'number' ? info.rssi : null,
    protocol: device.protocolLabel,
    online,
    lastReadAt,
  };
}

export async function collectDevices({ deviceList = defaultDevices, readDevice = readConfiguredDevice, now = () => new Date() } = {}) {
  return Promise.all(deviceList.map(async (device) => {
    const lastReadAt = now().toISOString();
    try {
      const info = await readDevice(device);
      return publicDevice(device, info, true, lastReadAt);
    } catch {
      return publicDevice(device, null, false, lastReadAt);
    }
  }));
}

export function createDeviceStatusLogger(log = info) {
  const previousStates = new Map();
  return (deviceResults) => {
    for (const device of deviceResults) {
      const state = device.online ? 'ONLINE' : 'OFFLINE';
      const previous = previousStates.get(device.id);
      if (previous === undefined) log(`[${device.model}] ${device.name} - ${state}`);
      else if (previous !== state) log(`[${device.model}] ${state}`);
      previousStates.set(device.id, state);
    }
  };
}

function sendJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  response.end(data);
}

async function serveStatic(request, response, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return true;
  }
  const [filename, contentType] = entry;
  const content = await readFile(path.join(PUBLIC_ROOT, filename));
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : content);
  return true;
}

export function createPondServer({
  deviceList = defaultDevices,
  readDevice = readConfiguredDevice,
  now,
  logDeviceStatus = createDeviceStatusLogger(),
} = {}) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname === '/api/devices') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end();
          return;
        }
        const result = await collectDevices({ deviceList, readDevice, now });
        logDeviceStatus(result);
        sendJson(response, 200, { devices: result });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Endpoint non trovato' });
        return;
      }
      if (await serveStatic(request, response, url.pathname)) return;
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Non trovato');
    } catch {
      sendJson(response, 500, { error: 'Errore interno del server' });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    credentialsFromEnvironment();
    const server = createPondServer();
    server.listen(3000, '0.0.0.0', () => {
      info('Pond Control disponibile su http://localhost:3000');
    });
    server.on('close', () => info('Pond Control arrestato'));
    const shutdown = () => server.close();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch {
    error('Tapo credentials missing: configure TAPO_USERNAME and TAPO_PASSWORD in .env');
    process.exitCode = 1;
  }
}
