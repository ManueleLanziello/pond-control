import assert from 'node:assert/strict';
import test from 'node:test';
import { devices } from '../devices.js';
import {
  DEVICE_FRESHNESS_MS, DeviceManager, LOGIN_BACKOFF_MS, OFFLINE_FAILURE_THRESHOLD,
} from '../src/device-manager.js';
import { createManagerHarness } from './helpers/device-manager-harness.js';

test('persistent TPAP client is reused across successful reads', async () => {
  const run = createManagerHarness(devices, {
    states: { 'tapo-p105-pond': true, 'tapo-p100m-pond': false },
  });
  await run.manager.read('tapo-p105-pond');
  await run.manager.read('tapo-p105-pond');
  assert.equal(run.clientCreations.get('tapo-p105-pond'), 1);
  assert.equal(run.events.filter((event) => event[0] === 'read' && event[1] === 'tapo-p105-pond').length, 2);
});

test('communication error invalidates client and next controlled attempt creates one replacement', async () => {
  const run = createManagerHarness(devices, {
    states: { 'tapo-p105-pond': true }, readFailures: { 'tapo-p105-pond': 1 },
  });
  await assert.rejects(run.manager.read('tapo-p105-pond'));
  await run.manager.read('tapo-p105-pond');
  assert.equal(run.clientCreations.get('tapo-p105-pond'), 2);
  assert.equal(run.events.filter((event) => event[0] === 'close' && event[1] === 'tapo-p105-pond').length, 1);
});

test('per-device mutex serializes one device while allowing different devices in parallel', async () => {
  let releasePump;
  let releaseHeater;
  const pumpGate = new Promise((resolve) => { releasePump = resolve; });
  const heaterGate = new Promise((resolve) => { releaseHeater = resolve; });
  const entered = [];
  const manager = new DeviceManager({
    deviceList: devices,
    createClient(device) {
      return {
        async getDeviceInfo() {
          entered.push(device.id);
          await (device.id === 'tapo-p105-pond' ? pumpGate : heaterGate);
          return { device_on: false };
        },
        close() {},
      };
    },
  });
  const firstPump = manager.read('tapo-p105-pond');
  const secondPump = manager.read('tapo-p105-pond');
  const heater = manager.read('tapo-p100m-pond');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered.sort(), ['tapo-p100m-pond', 'tapo-p105-pond']);
  releaseHeater();
  releasePump();
  await Promise.all([firstPump, secondPump, heater]);
  assert.equal(entered.filter((id) => id === 'tapo-p105-pond').length, 2);
});

test('snapshots are traffic-free regardless of request count', async () => {
  const run = createManagerHarness(devices, { states: {} });
  for (let index = 0; index < 100; index += 1) run.manager.snapshots();
  assert.equal(run.events.length, 0);
  assert.equal(run.clientCreations.size, 0);
});

test('one and two failures retain last valid state; third marks offline; success recovers', async () => {
  const run = createManagerHarness(devices, { states: { 'tapo-p105-pond': true } });
  await run.manager.read('tapo-p105-pond');
  run.readFailures['tapo-p105-pond'] = 3;
  await assert.rejects(run.manager.read('tapo-p105-pond'));
  assert.equal(run.manager.snapshot('tapo-p105-pond').online, true);
  assert.equal(run.manager.snapshot('tapo-p105-pond').communicationDegraded, true);
  await assert.rejects(run.manager.read('tapo-p105-pond'));
  assert.equal(run.manager.snapshot('tapo-p105-pond').online, true);
  run.advance(2000);
  await assert.rejects(run.manager.read('tapo-p105-pond'));
  assert.equal(run.manager.snapshot('tapo-p105-pond').online, false);
  assert.equal(run.manager.snapshot('tapo-p105-pond').consecutiveFailures, OFFLINE_FAILURE_THRESHOLD);
  run.advance(5000);
  await run.manager.read('tapo-p105-pond');
  const recovered = run.manager.snapshot('tapo-p105-pond');
  assert.equal(recovered.online, true);
  assert.equal(recovered.communicationDegraded, false);
  assert.equal(recovered.consecutiveFailures, 0);
});

test('freshness expires after five seconds and a degraded snapshot is never reliable', async () => {
  const run = createManagerHarness(devices, { states: { 'tapo-p105-pond': true } });
  await run.manager.read('tapo-p105-pond');
  assert.equal(run.manager.isFreshAndReliable('tapo-p105-pond', DEVICE_FRESHNESS_MS), true);
  run.advance(DEVICE_FRESHNESS_MS + 1);
  assert.equal(run.manager.isFreshAndReliable('tapo-p105-pond', DEVICE_FRESHNESS_MS), false);
  run.readFailures['tapo-p105-pond'] = 1;
  await assert.rejects(run.manager.read('tapo-p105-pond'));
  assert.equal(run.manager.isFreshAndReliable('tapo-p105-pond', DEVICE_FRESHNESS_MS), false);
});

test('login backoff prevents aggressive client recreation and success resets it', async () => {
  const run = createManagerHarness(devices, {
    states: { 'tapo-p105-pond': true }, readFailures: { 'tapo-p105-pond': 2 },
  });
  await assert.rejects(run.manager.read('tapo-p105-pond'));
  await assert.rejects(run.manager.read('tapo-p105-pond'));
  const clientsAfterSecondFailure = run.clientCreations.get('tapo-p105-pond');
  await assert.rejects(run.manager.read('tapo-p105-pond'), (error) => error.code === 'DEVICE_BACKOFF');
  assert.equal(run.clientCreations.get('tapo-p105-pond'), clientsAfterSecondFailure);
  run.advance(LOGIN_BACKOFF_MS[1]);
  await run.manager.read('tapo-p105-pond');
  assert.equal(run.manager.snapshot('tapo-p105-pond').consecutiveFailures, 0);
});

test('pollAll collapses overlapping callers into one hardware cycle', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = createManagerHarness(devices, {
    states: { 'tapo-p105-pond': true, 'tapo-p100m-pond': false },
    delays: { 'tapo-p105-pond': () => gate, 'tapo-p100m-pond': () => gate },
  });
  const first = run.manager.pollAll();
  const second = run.manager.pollAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.events.filter((event) => event[0] === 'read').length, 2);
  release();
  assert.equal(await first, await second);
});
