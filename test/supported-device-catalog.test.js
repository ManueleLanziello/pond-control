import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRuntimeEligiblePlug, requireSupportedPlugModel, runtimePlugConfiguration,
  supportedPlugModel, SUPPORTED_PLUG_MODELS,
} from '../src/supported-device-catalog.js';
import { validateHardwareRegistry } from '../src/hardware-registry.js';

test('catalog supports only validated P105 and P100M plug models', () => {
  assert.deepEqual(SUPPORTED_PLUG_MODELS.map(({ model }) => model), ['P105', 'P100M']);
  assert.equal(supportedPlugModel('p105').adapter, 'tpap');
  assert.equal(supportedPlugModel('P100M').protocolLabel, 'TPAP/SPAKE2+');
  assert.equal(supportedPlugModel('P110'), null);
  assert.throws(() => requireSupportedPlugModel('Shelly'), (error) => error.code === 'UNSUPPORTED_MODEL');
});

test('plug protocol and runtime adapter are derived from model catalog', () => {
  const registry = validateHardwareRegistry({ plugs: [{
    id: 'slot', alias: 'Slot', model: 'P105', ip: '192.168.1.6', mac: '18:69:45:C7:DA:2E',
    protocol: 'user-controlled-invalid-value', verificationStatus: 'verified',
  }], sensors: [], cameras: [] });
  const plug = registry.plugs[0];
  assert.equal(plug.protocol, 'tpap');
  assert.equal(plug.runtimeAdapter, 'tpap');
  assert.equal(plug.manufacturer, 'TP-Link Tapo');
  assert.equal(isRuntimeEligiblePlug(plug), true);
  assert.deepEqual(runtimePlugConfiguration(plug), {
    id: 'slot', fallbackName: 'Slot', model: 'P105', manufacturer: 'TP-Link Tapo',
    ip: '192.168.1.6', type: 'SMART.TAPOPLUG', protocol: 'tpap',
    protocolLabel: 'TPAP/SPAKE2+', adapter: 'tpap',
  });
});

test('unknown plug model is rejected by registry validation', () => {
  assert.throws(() => validateHardwareRegistry({ plugs: [{
    id: 'unknown', alias: 'Unknown', model: 'P110', ip: '192.168.1.9', mac: 'AA:BB:CC:DD:EE:09',
  }], sensors: [], cameras: [] }), (error) => error.code === 'UNSUPPORTED_MODEL');
});
