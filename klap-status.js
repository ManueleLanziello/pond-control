import net from 'node:net';
import { KlapV2Client } from './src/klap/client.js';

function configuration() {
  const username = process.env.TAPO_USERNAME?.trim();
  const password = process.env.TAPO_PASSWORD;
  if (!username || !password) throw new Error('TAPO_USERNAME e TAPO_PASSWORD sono obbligatorie.');
  const ips = (process.env.TAPO_DEVICE_IPS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!ips.length) throw new Error('Impostare TAPO_DEVICE_IPS con almeno un indirizzo IPv4.');
  const invalid = ips.filter((ip) => net.isIP(ip) !== 4);
  if (invalid.length) throw new Error(`IPv4 non validi in TAPO_DEVICE_IPS: ${invalid.join(', ')}`);
  return { username, password, ips: [...new Set(ips)] };
}

function decodeAlias(value) {
  if (!value) return 'non disponibile';
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const normalized = value.replace(/=+$/, '');
    return Buffer.from(decoded).toString('base64').replace(/=+$/, '') === normalized ? decoded : value;
  } catch { return value; }
}

async function main() {
  const { username, password, ips } = configuration();
  let failures = 0;
  for (const ip of ips) {
    const client = new KlapV2Client({ ip, username, password, timeout: Number(process.env.TAPO_DEVICE_TIMEOUT_MS || 5000) });
    try {
      const info = await client.getDeviceInfo();
      console.log(`IP: ${ip}`);
      console.log(`Modello: ${info.model || 'non disponibile'}`);
      console.log(`Alias: ${decodeAlias(info.nickname || info.alias)}`);
      console.log(`Tipo: ${info.type || 'non disponibile'}`);
      console.log(`Stato: ${typeof info.device_on === 'boolean' ? (info.device_on ? 'ON' : 'OFF') : 'non leggibile'}`);
      console.log(`RSSI: ${info.rssi ?? 'non disponibile'}`);
      console.log('Protocollo: KLAP v2');
    } catch (error) {
      failures += 1;
      console.error(`${ip}: lettura KLAP fallita: ${error.message}`);
    } finally {
      client.close();
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Errore: ${error.message}`);
  process.exitCode = 1;
});
