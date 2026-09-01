import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TpapClient } from './tpap/client.js';
import { HardwareRegistryError, normalizeMac } from './hardware-registry.js';

const execFileAsync = promisify(execFile);

function decodeAlias(value) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return Buffer.from(decoded).toString('base64').replace(/=+$/, '') === String(value).replace(/=+$/, '') ? decoded : value;
  } catch { return value; }
}

export function assertHardwareIdentity(configured, detected) {
  const expectedModel = String(configured.model || '').trim().toUpperCase();
  const actualModel = String(detected.model || '').trim().toUpperCase();
  if (!actualModel || !(actualModel === expectedModel || actualModel.startsWith(`${expectedModel}(`))) {
    throw new HardwareRegistryError('Il modello rilevato non corrisponde alla configurazione.', 'MODEL_MISMATCH');
  }
  if (configured.mac) {
    if (!detected.mac) throw new HardwareRegistryError('Il dispositivo non ha restituito il MAC.', 'MAC_UNAVAILABLE');
    if (normalizeMac(detected.mac) !== normalizeMac(configured.mac)) {
      throw new HardwareRegistryError('Il MAC rilevato non corrisponde alla configurazione.', 'MAC_MISMATCH');
    }
  }
}

export async function verifyTapoPlug(configured, { username, password, timeout = 5000 } = {}) {
  const client = new TpapClient({ ip: configured.ip, username, password, timeout });
  try {
    const protocol = await client.discoverProtocol();
    const info = await client.getDeviceInfo();
    const detected = {
      model: info.model || null,
      alias: decodeAlias(info.nickname || info.alias),
      mac: info.mac || info.mac_address || null,
      protocol: `TPAP/SPAKE2+ (pake ${protocol.pake.join(',')})`,
      online: true,
      rssi: typeof info.rssi === 'number' ? info.rssi : null,
      state: typeof info.device_on === 'boolean' ? (info.device_on ? 'ON' : 'OFF') : null,
    };
    assertHardwareIdentity(configured, detected);
    return detected;
  } finally {
    client.close();
  }
}

function findValue(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key.toLowerCase()) && child) return child;
    const nested = findValue(child, keys);
    if (nested) return nested;
  }
  return null;
}

export async function verifyTapoCamera(configured, { pythonPath, probePath, env = process.env } = {}) {
  const { stdout } = await execFileAsync(pythonPath, [probePath], {
    env: { ...env, TAPO_CAMERA_IP: configured.ip }, timeout: 30_000, windowsHide: true,
  });
  const report = JSON.parse(stdout);
  if (!report.authentication) throw new HardwareRegistryError('Autenticazione telecamera non riuscita.', 'AUTHENTICATION_FAILED');
  const detected = {
    model: findValue(report.device_info, ['device_model', 'model']),
    alias: findValue(report.device_info, ['alias', 'device_name', 'name']),
    mac: findValue(report.device_info, ['mac', 'mac_address']),
    protocol: report.transport || 'PyTapo HTTPS',
    online: true,
  };
  assertHardwareIdentity(configured, detected);
  return detected;
}
