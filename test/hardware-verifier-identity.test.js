import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHardwareIdentity } from '../src/hardware-verifier.js';

test('read-only identity validation rejects model and MAC mismatch before runtime activation', () => {
  assert.throws(() => assertHardwareIdentity(
    { model: 'P105', mac: '18:69:45:C7:DA:2E' },
    { model: 'P100M', mac: '18:69:45:C7:DA:2E' },
  ), (error) => error.code === 'MODEL_MISMATCH');
  assert.throws(() => assertHardwareIdentity(
    { model: 'P105', mac: '18:69:45:C7:DA:2E' },
    { model: 'P105', mac: 'AA:BB:CC:DD:EE:FF' },
  ), (error) => error.code === 'MAC_MISMATCH');
  assert.doesNotThrow(() => assertHardwareIdentity(
    { model: 'P105', mac: '18:69:45:C7:DA:2E' },
    { model: 'P105(IT)', mac: '18-69-45-C7-DA-2E' },
  ));
});
