import net from 'node:net';
import { TpapClient } from './src/tpap/client.js';

function requiredEnvironment() {
  const username = process.env.TAPO_USERNAME?.trim();
  const password = process.env.TAPO_PASSWORD;
  console.log(`TAPO_USERNAME presente: ${username ? 'SI' : 'NO'}`);
  console.log(`TAPO_PASSWORD presente: ${password ? 'SI' : 'NO'}`);
  if (!username || !password) throw new Error('TAPO_USERNAME e TAPO_PASSWORD sono entrambe obbligatorie.');
  return { username, password };
}

function deviceIps() {
  const ips = (process.env.TAPO_DEVICE_IPS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!ips.length) throw new Error('Impostare TAPO_DEVICE_IPS con l’IPv4 della P105 rilevata dal discovery.');
  const invalid = ips.filter((ip) => net.isIP(ip) !== 4);
  if (invalid.length) throw new Error(`IPv4 non validi in TAPO_DEVICE_IPS: ${invalid.join(', ')}`);
  return [...new Set(ips)];
}

function decodeAlias(value) {
  if (!value) return 'non disponibile';
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const normalizedInput = value.replace(/=+$/, '');
    const roundTrip = Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '');
    return decoded && roundTrip === normalizedInput && /^[\p{L}\p{N}\p{P}\p{Z}\p{S}]+$/u.test(decoded) ? decoded : value;
  } catch { return value; }
}

async function main() {
  const credentials = requiredEnvironment();
  let failures = 0;
  for (const ip of deviceIps()) {
    const client = new TpapClient({ ip, ...credentials, timeout: Number(process.env.TAPO_DEVICE_TIMEOUT_MS || 5000) });
    try {
      const protocol = await client.discoverProtocol();
      const info = await client.getDeviceInfo();
      console.log('\nStato dispositivo (sola lettura)');
      console.log(`  IP:         ${ip}`);
      console.log(`  Modello:    ${info.model || 'non disponibile'}`);
      console.log(`  Alias:      ${decodeAlias(info.nickname || info.alias)}`);
      console.log(`  Tipo:       ${info.type || 'non disponibile'}`);
      console.log(`  Stato:      ${typeof info.device_on === 'boolean' ? (info.device_on ? 'ON' : 'OFF') : 'non leggibile'}`);
      console.log(`  RSSI:       ${info.rssi ?? 'non disponibile'}`);
      console.log(`  Protocollo: TPAP/SPAKE2+ (pake ${protocol.pake.join(',') || 'non dichiarato'})`);
    } catch (error) {
      failures += 1;
      console.error(`\n${ip}: lettura TPAP fallita: ${error.message}`);
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
