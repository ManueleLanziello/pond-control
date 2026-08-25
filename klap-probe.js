import net from 'node:net';
import { printKlapProbeReport, probeKlapHandshake1 } from './src/klap/probe.js';

function deviceIps() {
  const ips = (process.env.TAPO_DEVICE_IPS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!ips.length) throw new Error('Impostare TAPO_DEVICE_IPS con almeno un indirizzo IPv4.');
  const invalid = ips.filter((ip) => net.isIP(ip) !== 4);
  if (invalid.length) throw new Error(`IPv4 non validi in TAPO_DEVICE_IPS: ${invalid.join(', ')}`);
  return [...new Set(ips)];
}

async function main() {
  let failures = 0;
  for (const ip of deviceIps()) {
    try {
      const report = await probeKlapHandshake1(ip, {
        timeout: Number(process.env.TAPO_DEVICE_TIMEOUT_MS || 5000),
      });
      printKlapProbeReport(report);
    } catch (error) {
      failures += 1;
      console.error(`IP: ${ip}`);
      console.error(`KLAP handshake1 fallito: ${error.message}`);
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Errore: ${error.message}`);
  process.exitCode = 1;
});
