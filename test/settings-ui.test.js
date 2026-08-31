import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('settings cards identify physical plugs by model and show only the role select', async () => {
  const source = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
  const roleCardSource = source.slice(source.indexOf('function roleCard'), source.indexOf('function renderDevices'));
  assert.match(roleCardSource, /title\.textContent = `Presa \$\{device\.model\}`/);
  assert.match(roleCardSource, /select\.className = 'role-select'/);
  assert.doesNotMatch(roleCardSource, /device\.(?:name|ip|protocol|online)/);
  assert.doesNotMatch(roleCardSource, /Ruolo Pond-Control|badge|detail-row/);
});

test('settings role options and touch sizing remain unchanged', async () => {
  const [script, style] = await Promise.all([
    readFile(new URL('../public/settings.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/style.css', import.meta.url), 'utf8'),
  ]);
  assert.match(script, /pump: 'Pompa'/);
  assert.match(script, /heater: 'Riscaldatore'/);
  assert.match(script, /none: 'Nessun ruolo'/);
  assert.match(style, /\.role-select\s*\{[\s\S]*?min-height:\s*48px/);
  assert.match(style, /\.settings-grid\s*\{[\s\S]*?repeat\(2/);
  assert.match(style, /@media \(max-width: 700px\)[\s\S]*?\.settings-grid\s*\{\s*grid-template-columns:\s*1fr/);
});

test('settings physical icons follow the model and never the assigned role', async () => {
  const source = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
  assert.match(source, /deviceIcon\.src = `\/icons\/\$\{device\.model\.toLowerCase\(\)\}\.svg`/);
  assert.doesNotMatch(source, /\/icons\/\$\{device\.role\}/);
  assert.match(source, /title\.textContent = `Presa \$\{device\.model\}`/);
});

test('settings reserves a static card for future sensors without sensor logic', async () => {
  const [page, script] = await Promise.all([
    readFile(new URL('../public/settings.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/settings.js', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /<h2 id="sensors-heading">Sensori<\/h2>/);
  assert.match(page, /<article class="device-card settings-card">[\s\S]*?Nessun sensore configurato/);
  assert.doesNotMatch(script, /sensor/i);
});
