import assert from 'node:assert/strict';
import test from 'node:test';
import { devices } from '../devices.js';
import { createPumpController, PumpControlError } from '../src/pump-control.js';
import { createManagerHarness } from './helpers/device-manager-harness.js';

const NORMAL = { 'tapo-p105-pond': 'pump', 'tapo-p100m-pond': 'heater' };

function controllerHarness({ assignments = NORMAL, ...managerOptions } = {}) {
  const run = createManagerHarness(devices, managerOptions);
  const control = createPumpController({
    deviceList: devices,
    roleStore: { read: async () => ({ ...assignments }) },
    deviceManager: run.manager,
  });
  return { ...run, control };
}

test('pump ON writes only current role pump and never starts heater', async () => {
  const run = controllerHarness({ states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': false } });
  assert.equal((await run.control('ON')).state, 'ON');
  assert.deepEqual(run.events.filter((event) => event[0] === 'write'), [
    ['write', 'tapo-p105-pond', true],
  ]);
});

test('pump OFF with heater already OFF does not rewrite heater', async () => {
  const run = controllerHarness({ states: { 'tapo-p105-pond': true, 'tapo-p100m-pond': false } });
  assert.equal((await run.control('OFF')).state, 'OFF');
  assert.deepEqual(run.events.filter((event) => event[0] === 'write'), [
    ['write', 'tapo-p105-pond', false],
  ]);
});

test('pump OFF verifies heater OFF before writing pump', async () => {
  const run = controllerHarness({ states: { 'tapo-p105-pond': true, 'tapo-p100m-pond': true } });
  await run.control('OFF');
  assert.deepEqual(run.events.filter((event) => ['read', 'write'].includes(event[0])), [
    ['read', 'tapo-p105-pond'],
    ['read', 'tapo-p100m-pond'],
    ['write', 'tapo-p100m-pond', false],
    ['read', 'tapo-p100m-pond'],
    ['write', 'tapo-p105-pond', false],
    ['read', 'tapo-p105-pond'],
  ]);
});

test('heater failure, mismatch, or unreadable state blocks pump OFF', async () => {
  for (const options of [
    { writeFailures: ['tapo-p100m-pond'] },
    { sticky: ['tapo-p100m-pond'] },
    { readFailures: { 'tapo-p100m-pond': 1 } },
  ]) {
    const run = controllerHarness({
      states: { 'tapo-p105-pond': true, 'tapo-p100m-pond': true }, ...options,
    });
    await assert.rejects(run.control('OFF'), (error) => (
      ['HEATER_SHUTDOWN_FAILED', 'HEATER_STATE_UNKNOWN'].includes(error.code)
    ));
    assert.ok(!run.events.some((event) => event[0] === 'write' && event[1] === 'tapo-p105-pond'));
  }
});

test('heater unassigned allows pump OFF and swapped roles are followed', async () => {
  const noHeater = controllerHarness({
    assignments: { 'tapo-p105-pond': 'pump', 'tapo-p100m-pond': 'none' },
    states: { 'tapo-p105-pond': true },
  });
  assert.equal((await noHeater.control('OFF')).state, 'OFF');

  const swapped = controllerHarness({
    assignments: { 'tapo-p105-pond': 'heater', 'tapo-p100m-pond': 'pump' },
    states: { 'tapo-p105-pond': false, 'tapo-p100m-pond': false },
  });
  assert.equal((await swapped.control('ON')).deviceId, 'tapo-p100m-pond');
});

test('invalid input, missing pump, and offline pump are controlled errors', async () => {
  const invalid = controllerHarness();
  await assert.rejects(invalid.control('TOGGLE'), (error) => error instanceof PumpControlError && error.code === 'INVALID_STATE');

  const missing = controllerHarness({ assignments: { 'tapo-p105-pond': 'none', 'tapo-p100m-pond': 'heater' } });
  await assert.rejects(missing.control('ON'), (error) => error.code === 'PUMP_NOT_ASSIGNED');

  const offline = controllerHarness({ readFailures: { 'tapo-p105-pond': 1 } });
  await assert.rejects(offline.control('ON'), (error) => error.code === 'PUMP_OFFLINE');
  assert.ok(!offline.events.some((event) => event[0] === 'write'));
});
