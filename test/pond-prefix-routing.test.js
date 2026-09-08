import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pondControlBasePath, pondControlPath } from '../public/base-path.js';

test('resolves root and prefixed Pond Control paths', () => {
  assert.equal(pondControlBasePath('/'), '');
  assert.equal(pondControlBasePath('/settings'), '');
  assert.equal(pondControlBasePath('/pond/'), '/pond');
  assert.equal(pondControlBasePath('/pond/settings'), '/pond');
  assert.equal(pondControlPath('/api/devices', '/'), '/api/devices');
  assert.equal(pondControlPath('/api/devices', '/pond/'), '/pond/api/devices');
});

test('declares the prefixed PWA identity and uses prefixed runtime URLs', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url)));
  assert.deepEqual(
    { id: manifest.id, start_url: manifest.start_url, scope: manifest.scope },
    { id: '/pond/', start_url: '/pond/', scope: '/pond/' },
  );

  const [app, camera, heater, pump, settings, pwa] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/camera-view.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/heater-control.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/pump-control.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/settings.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/pwa.js', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /pondControlPath\('\/api\/weather'\)/);
  assert.match(camera, /pondControlPath\('\/api\/camera\/status'\)/);
  assert.match(heater, /pondControlPath\('\/api\/functions\/heater\/state'\)/);
  assert.match(pump, /pondControlPath\('\/api\/functions\/pump\/state'\)/);
  assert.match(settings, /pondControlPath\(`\/api\/hardware/);
  assert.match(pwa, /pondControlPath\('\/service-worker\.js'\)/);
  assert.match(pwa, /scope: `\$\{basePath\}\/`/);
});
