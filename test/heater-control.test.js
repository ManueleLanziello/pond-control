import assert from 'node:assert/strict';
import test from 'node:test';
import { devices } from '../devices.js';
import { createHeaterController, HeaterControlError } from '../src/heater-control.js';
import { createManagerHarness } from './helpers/device-manager-harness.js';

const NORMAL = { 'tapo-p105-pond': 'pump', 'tapo-p100m-pond': 'heater' };

function controllerHarness({ assignments = NORMAL, ...managerOptions } = {}) {
  const run = createManagerHarness(devices, managerOptions);
  const control = createHeaterController({
    deviceList: devices,
    roleStore: { read: async () => ({ ...assignments }) },
    deviceManager: run.manager,
  });
  return { ...run, control };
}

test('heater ON/OFF follows role and verifies real state', async () => {
  const on = controllerHarness({ states: { 'tapo-p105-pond': true, 'tapo-p100m-pond': false } });
  assert.equal((await on.control('ON')).state, 'ON');
  assert.ok(on.events.some((event) => event[0] === 'write' && event[1] === 'tapo-p100m-pond' && event[2] === true));

  const off = controllerHarness({ states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': true } });
  assert.equal((await off.control('OFF')).state, 'OFF');
  assert.ok(!off.events.some((event) => event[0] === 'read' && event[1] === 'tapo-p105-pond'));
});

test('heater command follows swapped role', async () => {
  const run = controllerHarness({
    assignments: { 'tapo-p105-pond': 'heater', 'tapo-p100m-pond': 'pump' },
    states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': true },
  });
  assert.equal((await run.control('ON')).deviceId, 'tapo-p105-pond');
  assert.ok(!run.events.some((event) => event[0] === 'write' && event[1] === 'tapo-p100m-pond'));
});

test('heater ON rejects missing, OFF, offline, degraded, or stale pump without heater write', async () => {
  const missing = controllerHarness({
    assignments: { 'tapo-p105-pond': 'none', 'tapo-p100m-pond': 'heater' },
  });
  await assert.rejects(missing.control('ON'), (error) => error.code === 'PUMP_NOT_RUNNING');

  for (const options of [
    { states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': false } },
    { states: { 'tapo-p100m-pond': false }, readFailures: { 'tapo-p105-pond': 1 } },
  ]) {
    const run = controllerHarness(options);
    await assert.rejects(run.control('ON'), (error) => error.code === 'PUMP_NOT_RUNNING');
    assert.ok(!run.events.some((event) => event[0] === 'write'));
  }
});

test('invalid input and heater communication failures never report false state', async () => {
  const invalid = controllerHarness();
  await assert.rejects(invalid.control('TOGGLE'), (error) => error instanceof HeaterControlError && error.code === 'INVALID_STATE');
  assert.equal(invalid.events.length, 0);

  const failed = controllerHarness({
    states: { 'tapo-p105-pond': true, 'tapo-p100m-pond': false },
    writeFailures: ['tapo-p100m-pond'],
  });
  await assert.rejects(failed.control('ON'), (error) => error.code === 'WRITE_FAILED');
  assert.equal(failed.states['tapo-p100m-pond'], false);
});
