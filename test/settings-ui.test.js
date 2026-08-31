import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('settings renders configurable registries for plugs, sensors and cameras', async () => {
  const [page, script] = await Promise.all([
    readFile(new URL('../public/settings.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/settings.js', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /<h2 id="plugs-heading">Prese<\/h2>/);
  assert.match(page, /<h2 id="sensors-heading">Sensori<\/h2>/);
  assert.match(page, /<h2 id="cameras-heading">Telecamere<\/h2>/);
  assert.match(page, /data-add-kind="plugs"[^>]*>Aggiungi presa/i);
  assert.match(page, /data-add-kind="sensors"[^>]*>Aggiungi sensore/i);
  assert.match(page, /data-add-kind="cameras"[^>]*>Aggiungi telecamera/i);
  assert.match(script, /request\('\/api\/hardware'/);
  assert.match(script, /Nessun sensore configurato/);
});

test('settings exposes only the currently supported role vocabulary', async () => {
  const [script, style] = await Promise.all([
    readFile(new URL('../public/settings.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/style.css', import.meta.url), 'utf8'),
  ]);
  assert.match(script, /pump: 'Pompa Filtro'/);
  assert.match(script, /heater: 'Riscaldatore'/);
  assert.match(script, /none: 'Nessun ruolo'/);
  assert.match(script, /pond_temperature: 'Temperatura Acqua'/);
  assert.doesNotMatch(script, /external_temperature|Temperatura Esterna/);
  assert.match(script, /pond_camera: 'Telecamera Pond'/);
  assert.doesNotMatch(script, /water_level|humidity/);
  assert.match(style, /\.role-select\s*\{[\s\S]*?min-height:\s*48px/);
  assert.match(style, /@media \(max-width: 700px\)[\s\S]*?\.settings-grid\s*\{\s*grid-template-columns:\s*1fr/);
});

test('settings cards show hardware identity, connection and verification data', async () => {
  const source = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
  const cardSource = source.slice(source.indexOf('function hardwareCard'), source.indexOf('function renderKind'));
  for (const field of ['device.alias', 'device.model', 'device.ip', 'device.mac', 'device.protocol', 'device.online', 'device.rssi']) {
    assert.match(cardSource, new RegExp(field.replace('.', '\\.')));
  }
  assert.match(cardSource, /VERIFICATA/);
  assert.match(cardSource, /DA VERIFICARE/);
  assert.match(cardSource, /if \(!\(kind === 'sensors' && device\.connectionType === 'cloud'\)\)/);
  assert.match(cardSource, /actionButton\('Modifica'/);
  assert.match(cardSource, /actionButton\('Verifica'/);
  assert.match(cardSource, /actionButton\('Rimuovi'/);
});

test('settings requires read-only verification before adding a supported active device', async () => {
  const script = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
  assert.match(script, /saveButton\.disabled = adding && kind !== 'sensors'/);
  assert.match(script, /if \(adding && kind !== 'sensors' && !formVerified\) return/);
  assert.doesNotMatch(script, /Verifica sensori? non ancora disponibile/);
  assert.doesNotMatch(script, /\/api\/(?:devices|functions)\/[^'`]*\/(?:on|off|toggle)/i);
});

test('settings does not offer operational roles to registry-only plugs', async () => {
  const script = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
  assert.match(script, /kind === 'plugs' && !runtimeSupported \? \['none'\]/);
  assert.match(script, /device\.runtimeSupported \? 'OPERATIVA' : 'NON ATTIVA'/);
  assert.match(script, /non può ricevere un ruolo operativo finché non è supportata dal runtime/);
});

test('cloud sensor cards show provider and cloud status without IP or MAC rows', async () => {
  const script = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
  const card = script.slice(script.indexOf('function hardwareCard'), script.indexOf('function renderKind'));
  assert.match(card, /`\$\{device\.type\}\$\{device\.provider \? ` · \$\{device\.provider\}` : ''\}`/);
  assert.match(card, /kind === 'sensors' && device\.connectionType === 'cloud'/);
  assert.match(card, /if \(!\(kind === 'sensors' && device\.connectionType === 'cloud'\)\)/);
  assert.match(card, /textRow\('Connessione', 'CLOUD'\)/);
  assert.match(card, /\? \[textRow\('Connessione', 'CLOUD'\), statusRow\]\s*: \[/);
  const cloudBadgeGuard = card.indexOf("if (!(kind === 'sensors' && device.connectionType === 'cloud'))");
  assert.ok(cloudBadgeGuard >= 0);
  assert.ok(cloudBadgeGuard < card.indexOf("verification.textContent"));
  assert.match(card, /textRow\('Configurazione', device\.configurationStatus === 'complete' \? 'COMPLETA' : 'INCOMPLETA'\)/);
});

test('camera form requires IP but permits an initially empty MAC', async () => {
  const script = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
  assert.match(script, /hardware-ip'\)\.required = !cloud/);
  assert.match(script, /hardware-mac'\)\.required = !cloud && kind !== 'cameras'/);
});

test('sensor form preserves its protocol and hides redundant cloud verification', async () => {
  const script = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
  assert.match(script, /editingDevice\?\.protocol \|\| provider \|\| 'none'/);
  assert.match(script, /hardware-verify'\)\.hidden = cloud/);
  assert.match(script, /kind === 'sensors' && device\.connectionType !== 'cloud'/);
  assert.doesNotMatch(script, /if \(kind === 'sensors'\) throw new Error\('Verifica sensori non ancora disponibile/);
});
