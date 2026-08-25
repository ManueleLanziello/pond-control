import os from 'node:os';
import net from 'node:net';
import { Credentials, Discover } from 'node-kasa';

const DISCOVERY_TIMEOUT_MS = Number(process.env.TAPO_DISCOVERY_TIMEOUT_MS || 5000);
const DEVICE_TIMEOUT_MS = Number(process.env.TAPO_DEVICE_TIMEOUT_MS || 5000);

function ipv4ToInt(ip) {
  return ip.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function intToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function activeIpv4Interfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries = []]) =>
    entries
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => ({
        name,
        address: entry.address,
        broadcast: intToIpv4((ipv4ToInt(entry.address) | (~ipv4ToInt(entry.netmask) >>> 0)) >>> 0),
      })),
  );
}

function credentialsFromEnvironment() {
  const username = process.env.TAPO_USERNAME?.trim();
  const password = process.env.TAPO_PASSWORD;

  if (!username && !password) return null;
  if (!username || !password) {
    throw new Error('Impostare entrambe TAPO_USERNAME e TAPO_PASSWORD, oppure nessuna delle due.');
  }
  return new Credentials(username, password);
}

function explicitIps() {
  const ips = (process.env.TAPO_DEVICE_IPS || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);

  const invalid = ips.filter((ip) => net.isIP(ip) !== 4);
  if (invalid.length) throw new Error(`TAPO_DEVICE_IPS contiene IP IPv4 non validi: ${invalid.join(', ')}`);
  return [...new Set(ips)];
}

async function readDevice(device, fallbackIp) {
  await device.update();
  return {
    ip: device.host || fallbackIp || 'non disponibile',
    model: device.model || 'non disponibile',
    alias: device.alias || 'non disponibile',
    power: typeof device.isOn === 'boolean' ? (device.isOn ? 'ON' : 'OFF') : 'non leggibile',
  };
}

function printDevice(info) {
  console.log('\nDispositivo Tapo trovato');
  console.log(`  IP:     ${info.ip}`);
  console.log(`  Modello:${info.model ? ` ${info.model}` : ' non disponibile'}`);
  console.log(`  Alias:  ${info.alias}`);
  console.log(`  Stato:  ${info.power}`);
}

function safeProtocolInfo(raw) {
  const response = raw?.discoveryResponse || {};
  const scheme = response.mgt_encrypt_schm || {};
  return {
    ip: raw?.meta?.ip || response.ip || 'non disponibile',
    model: response.device_model || 'non disponibile',
    deviceType: response.device_type || 'non disponibile',
    encryption: scheme.encrypt_type || response.encrypt_type || 'non dichiarata',
    loginVersion: scheme.lv ?? 'non dichiarata',
    httpPort: scheme.http_port ?? 'non dichiarata',
    https: scheme.is_support_https ?? false,
  };
}

function printProtocol(info) {
  console.log(`\nProtocollo annunciato da ${info.ip}:`);
  console.log(`  Modello:     ${info.model}`);
  console.log(`  Tipo:        ${info.deviceType}`);
  console.log(`  Cifratura:   ${info.encryption}`);
  console.log(`  Login level: ${info.loginVersion}`);
  console.log(`  Porta HTTP:  ${info.httpPort}`);
  console.log(`  HTTPS:       ${info.https ? 'sì' : 'no'}`);
}

async function main() {
  const credentials = credentialsFromEnvironment();
  const interfaces = activeIpv4Interfaces();
  const manualIps = explicitIps();
  const devices = new Map();
  const protocols = new Map();
  const errors = [];
  const onDiscoveredRaw = (raw) => {
    const info = safeProtocolInfo(raw);
    if (!protocols.has(info.ip)) {
      protocols.set(info.ip, info);
      printProtocol(info);
    }
  };

  if (!interfaces.length) throw new Error('Nessuna interfaccia IPv4 LAN attiva trovata.');

  console.log('Interfacce IPv4 LAN considerate:');
  for (const item of interfaces) console.log(`  ${item.name}: ${item.address} (broadcast ${item.broadcast})`);
  if (credentials) {
    console.log('\nCredenziali Tapo: TAPO_USERNAME e TAPO_PASSWORD presenti e caricate (valori non mostrati).');
  } else {
    console.log('\nCredenziali Tapo non impostate: il discovery può rilevare la presa, ma la lettura autenticata può fallire.');
  }

  for (const item of interfaces) {
    try {
      const found = await Discover.discover({
        target: item.broadcast,
        interface: item.address,
        discoveryTimeout: DISCOVERY_TIMEOUT_MS,
        timeout: DEVICE_TIMEOUT_MS,
        credentials: credentials || undefined,
        onDiscoveredRaw,
      });
      for (const [ip, device] of Object.entries(found)) devices.set(ip, device);
    } catch (error) {
      errors.push(`${item.name} (${item.address}): ${error.message}`);
    }
  }

  // Fallback ragionevole: IP noti/riservati via DHCP, senza modificare il router.
  for (const ip of manualIps) {
    if (devices.has(ip)) continue;
    try {
      const device = await Discover.discoverSingle(ip, {
        discoveryTimeout: DISCOVERY_TIMEOUT_MS,
        timeout: DEVICE_TIMEOUT_MS,
        credentials: credentials || undefined,
        onDiscoveredRaw,
      });
      if (device) devices.set(ip, device);
    } catch (error) {
      errors.push(`${ip}: ${error.message}`);
    }
  }

  let readable = 0;
  for (const [ip, device] of devices) {
    try {
      printDevice(await readDevice(device, ip));
      readable += 1;
    } catch (error) {
      errors.push(`${ip}: rilevato, ma lettura non riuscita: ${error.message}`);
    }
  }

  if (errors.length) {
    console.error('\nAvvisi/errori:');
    for (const error of errors) console.error(`  - ${error}`);
  }

  if (!devices.size) {
    console.error('\nNessun dispositivo rilevato. Fallback: impostare TAPO_DEVICE_IPS con l’IP della P105 (anche più IP separati da virgola).');
    process.exitCode = 2;
  } else if (!readable) {
    const message = credentials
      ? 'Le credenziali erano caricate: verificare il protocollo annunciato, la compatibilità firmware e l’abilitazione del controllo locale di terze parti.'
      : 'Impostare TAPO_USERNAME e TAPO_PASSWORD per la lettura autenticata.';
    console.error(`\nDispositivo rilevato ma non leggibile. ${message}`);
    process.exitCode = 3;
  }
}

main().catch((error) => {
  console.error(`Errore fatale: ${error.message}`);
  process.exitCode = 1;
});
