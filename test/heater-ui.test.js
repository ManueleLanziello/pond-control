import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { heaterControlView, requestHeaterState } from '../public/heater-control.js';

test('heater UI is disabled while pending, offline, or unassigned', () => {
  const online = { role: 'heater', device: { online: true, state: 'ON' } };
  const pumpOn = { role: 'pump', device: {
    online: true, state: 'ON', communicationDegraded: false, consecutiveFailures: 0,
    lastReadAt: new Date().toISOString(),
  } };
  assert.equal(heaterControlView(online, pumpOn).disabled, false);
  assert.equal(heaterControlView(online, pumpOn, true).disabled, true);
  assert.equal(heaterControlView({ role: 'heater', device: { online: false, state: null } }, pumpOn).disabled, true);
  assert.equal(heaterControlView({ role: 'heater', device: null }, pumpOn).disabled, true);
  assert.equal(heaterControlView({ role: 'pump', device: { online: true, state: 'ON' } }, pumpOn).visible, false);
});

test('heater ON is blocked in the UI when pump is unsafe, but heater OFF remains available', () => {
  const heaterOff = { role: 'heater', device: { online: true, state: 'OFF' } };
  for (const pump of [
    { role: 'pump', device: { online: true, state: 'OFF' } },
    { role: 'pump', device: { online: false, state: null } },
    { role: 'pump', device: null },
  ]) {
    const view = heaterControlView(heaterOff, pump);
    assert.equal(view.disabled, true);
    assert.equal(view.safetyMessage, 'Pompa non attiva');
  }
  const heaterOn = { role: 'heater', device: { online: true, state: 'ON' } };
  assert.equal(heaterControlView(heaterOn, { role: 'pump', device: null }).requestedState, 'OFF');
  assert.equal(heaterControlView(heaterOn, { role: 'pump', device: null }).disabled, false);
  const safePump = { role: 'pump', device: {
    online: true, state: 'ON', communicationDegraded: false, consecutiveFailures: 0,
    lastReadAt: new Date().toISOString(),
  } };
  assert.equal(heaterControlView(heaterOff, safePump).requestedState, 'ON');
  assert.equal(heaterControlView(heaterOff, safePump).disabled, false);
});

test('degraded or stale pump does not enable heater ON in the UI', () => {
  const heaterOff = { role: 'heater', device: { online: true, state: 'OFF' } };
  const degraded = { role: 'pump', device: {
    online: true, state: 'ON', communicationDegraded: true, consecutiveFailures: 1,
    lastReadAt: new Date().toISOString(),
  } };
  const stale = { role: 'pump', device: {
    online: true, state: 'ON', communicationDegraded: false, consecutiveFailures: 0,
    lastReadAt: new Date(Date.now() - 5001).toISOString(),
  } };
  assert.equal(heaterControlView(heaterOff, degraded).disabled, true);
  assert.equal(heaterControlView(heaterOff, stale).disabled, true);
});

test('heater UI requests the role endpoint without optimistic state mutation', async () => {
  let request;
  const result = await requestHeaterState(async (url, options) => {
    request = { url, options };
    return new Response('{"ok":true,"role":"heater","deviceId":"stable","state":"OFF"}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }, 'OFF');
  assert.equal(request.url, '/api/functions/heater/state');
  assert.equal(request.options.method, 'PUT');
  assert.deepEqual(JSON.parse(request.options.body), { state: 'OFF' });
  assert.equal(result.state, 'OFF');
});

test('dashboard disables heater during its request and keeps heater control role-based', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /pondFunction\.role === 'heater'/);
  assert.match(source, /heaterCommandPending = true;[\s\S]*renderDevices\(latestDevices\)[\s\S]*await requestHeaterState/);
  assert.match(source, /heaterControlView\(pondFunction, pumpFunction, heaterCommandPending\)/);
});
