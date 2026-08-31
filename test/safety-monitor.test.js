import assert from 'node:assert/strict';
import test from 'node:test';
import { devices } from '../devices.js';
import { DEVICE_POLL_INTERVAL_MS } from '../src/device-manager.js';
import { createSafetyMonitor } from '../src/safety-monitor.js';
import { createManagerHarness } from './helpers/device-manager-harness.js';

const NORMAL = { 'tapo-p105-pond': 'pump', 'tapo-p100m-pond': 'heater' };

function harness({ assignments = NORMAL, ...managerOptions } = {}) {
  let currentAssignments = { ...assignments };
  const run = createManagerHarness(devices, managerOptions);
  const logs = [];
  const safety = createSafetyMonitor({
    deviceList: devices,
    roleStore: { read: async () => ({ ...currentAssignments }) },
    deviceManager: run.manager,
    log: (message) => logs.push(message),
    logError: (message) => logs.push(message),
  });
  return {
    ...run, safety, logs,
    setAssignments(value) { currentAssignments = { ...value }; },
  };
}

test('central poll plus safe safety cycle performs exactly one read per device', async () => {
  for (const heaterOn of [true, false]) {
    const run = harness({ states: { 'tapo-p105-pond': true, 'tapo-p100m-pond': heaterOn } });
    await run.manager.pollAll();
    assert.equal((await run.safety.runCycle()).reason, 'PUMP_RUNNING');
    assert.equal(run.events.filter((event) => event[0] === 'read').length, 2);
    assert.ok(!run.events.some((event) => event[0] === 'write'));
  }
});

test('pump OFF uses snapshot and shuts down an ON heater; already OFF needs no extra read', async () => {
  const on = harness({ states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': true } });
  await on.manager.pollAll();
  assert.deepEqual(await on.safety.runCycle(), { action: 'heater-off', verified: true });
  assert.deepEqual(on.events.filter((event) => event[0] === 'write'), [
    ['write', 'tapo-p100m-pond', false],
  ]);

  const off = harness({ states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': false } });
  await off.manager.pollAll();
  assert.equal((await off.safety.runCycle()).reason, 'HEATER_ALREADY_OFF');
  assert.equal(off.events.filter((event) => event[0] === 'read').length, 2);
});

test('first degraded pump reading is immediately unsafe for heater even while UI remains online', async () => {
  const run = harness({ states: { 'tapo-p105-pond': true, 'tapo-p100m-pond': true } });
  await run.manager.pollAll();
  run.readFailures['tapo-p105-pond'] = 1;
  await run.manager.pollAll();
  assert.equal(run.manager.snapshot('tapo-p105-pond').online, true);
  assert.equal(run.manager.snapshot('tapo-p105-pond').communicationDegraded, true);
  assert.equal((await run.safety.runCycle()).verified, true);
  assert.equal(run.states['tapo-p100m-pond'], false);
});

test('unassigned pump shuts heater down; unassigned heater causes no action', async () => {
  const noPump = harness({
    assignments: { 'tapo-p105-pond': 'none', 'tapo-p100m-pond': 'heater' },
    states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': true },
  });
  await noPump.manager.pollAll();
  assert.equal((await noPump.safety.runCycle()).verified, true);

  const noHeater = harness({
    assignments: { 'tapo-p105-pond': 'pump', 'tapo-p100m-pond': 'none' },
    states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': true },
  });
  await noHeater.manager.pollAll();
  assert.equal((await noHeater.safety.runCycle()).reason, 'HEATER_UNASSIGNED');
  assert.ok(!noHeater.events.some((event) => event[0] === 'write'));
});

test('pump recovery never turns heater back on and current role assignments are reread', async () => {
  const run = harness({ states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': true } });
  await run.manager.pollAll();
  await run.safety.runCycle();
  run.states['tapo-p105-pond'] = true;
  await run.manager.pollAll();
  await run.safety.runCycle();
  assert.equal(run.states['tapo-p100m-pond'], false);

  run.setAssignments({ 'tapo-p105-pond': 'heater', 'tapo-p100m-pond': 'pump' });
  run.states['tapo-p100m-pond'] = false;
  run.states['tapo-p105-pond'] = true;
  await run.manager.pollAll();
  await run.safety.runCycle();
  assert.equal(run.states['tapo-p105-pond'], false);
});

test('unified startup poll runs before safety and uses a 2000 ms interval', async () => {
  let scheduledMs;
  let scheduledCallback;
  const run = createManagerHarness(devices, {
    states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': true },
  });
  run.manager.setIntervalFn = (callback, ms) => {
    scheduledCallback = callback;
    scheduledMs = ms;
    return { callback };
  };
  const safety = createSafetyMonitor({
    deviceList: devices,
    roleStore: { read: async () => ({ ...NORMAL }) },
    deviceManager: run.manager,
  });
  await run.manager.startPolling(() => safety.runCycle());
  assert.equal(scheduledMs, DEVICE_POLL_INTERVAL_MS);
  assert.equal(run.states['tapo-p100m-pond'], false);
  assert.equal(typeof scheduledCallback, 'function');
  run.manager.stop();
});

test('overlapping safety evaluations are skipped and failures remain retryable', async () => {
  let releaseRoleRead;
  const roleGate = new Promise((resolve) => { releaseRoleRead = resolve; });
  const run = createManagerHarness(devices, { states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': true } });
  await run.manager.pollAll();
  const safety = createSafetyMonitor({
    deviceList: devices,
    roleStore: { read: async () => { await roleGate; return { ...NORMAL }; } },
    deviceManager: run.manager,
  });
  const first = safety.runCycle();
  assert.deepEqual(await safety.runCycle(), { skipped: true });
  releaseRoleRead();
  await first;

  const retry = harness({
    states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': true },
    writeFailures: ['tapo-p100m-pond'],
  });
  await retry.manager.pollAll();
  assert.equal((await retry.safety.runCycle()).verified, false);
  retry.writeFailures.delete('tapo-p100m-pond');
  assert.equal((await retry.safety.runCycle()).verified, true);
});
