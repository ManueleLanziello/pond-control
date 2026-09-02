import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pumpControlView, requestPumpState } from '../public/pump-control.js';

test('pump UI exposes verified ON/OFF actions and disables unavailable or pending control', () => {
  const on = { role: 'pump', device: { online: true, state: 'ON' } };
  const off = { role: 'pump', device: { online: true, state: 'OFF' } };
  assert.equal(pumpControlView(on).actionLabel, 'Spegni pompa');
  assert.equal(pumpControlView(on).requestedState, 'OFF');
  assert.equal(pumpControlView(off).requestedState, 'ON');
  assert.equal(pumpControlView(on, true).disabled, true);
  assert.equal(pumpControlView(on, true).actionLabel, 'Spegnimento sicuro in corso…');
  assert.equal(pumpControlView({ role: 'pump', device: { online: false, state: null } }).disabled, true);
  assert.equal(pumpControlView({ role: 'heater', device: { online: true, state: 'ON' } }).visible, false);
});

test('pump UI calls only the role endpoint', async () => {
  let request;
  const result = await requestPumpState(async (url, options) => {
    request = { url, options };
    return new Response('{"ok":true,"role":"pump","deviceId":"stable","state":"OFF"}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }, 'OFF');
  assert.equal(request.url, '/api/functions/pump/state');
  assert.deepEqual(JSON.parse(request.options.body), { state: 'OFF' });
  assert.equal(result.state, 'OFF');
});

test('dashboard keeps five-second polling and does not update pump before response', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /pumpCommandPending = true;[\s\S]*renderDevices\(latestDevices\)[\s\S]*await requestPumpState/);
  assert.match(source, /DASHBOARD_REFRESH_INTERVAL_MS = 5000/);
});
