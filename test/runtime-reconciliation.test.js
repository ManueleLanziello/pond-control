import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { devices } from '../devices.js';
import { createPondServer } from '../server.js';
import { DeviceManager } from '../src/device-manager.js';
import { defaultHardwareRegistry, HardwareRegistryStore } from '../src/hardware-registry.js';

test('startup/request reconciliation uses verified registry model and IP instead of legacy devices.js', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-runtime-reconcile-'));
  const hardwareStore = new HardwareRegistryStore({
    filePath: path.join(directory, 'hardware.json'),
    defaults: defaultHardwareRegistry({ deviceList: devices }),
  });
  await hardwareStore.read();
  await hardwareStore.update('plugs', 'tapo-p100m-pond', {
    alias: 'Presa Tapo P105 nuova', model: 'P105', ip: '192.168.1.6', mac: '18:69:45:C7:DA:2E',
  });
  await hardwareStore.markVerified('plugs', 'tapo-p100m-pond', {
    model: 'P105', mac: '18:69:45:C7:DA:2E', protocol: 'TPAP/SPAKE2+',
  });
  const manager = new DeviceManager({
    deviceList: devices,
    createClient: () => { throw new Error('Il test non deve contattare hardware'); },
  });
  const roleStore = {
    read: async () => ({ 'tapo-p105-pond': 'pump', 'tapo-p100m-pond': 'heater' }),
    reconcileDevices: async () => {},
  };
  const server = createPondServer({ hardwareStore, roleStore, deviceManager: manager });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/devices`);
    const payload = await response.json();
    const heaterSlot = payload.devices.find(({ id }) => id === 'tapo-p100m-pond');
    assert.equal(heaterSlot.model, 'P105');
    assert.equal(heaterSlot.ip, '192.168.1.6');
    assert.equal(heaterSlot.role, 'heater');
    assert.equal(heaterSlot.online, false);
    assert.equal(manager.entries.get('tapo-p100m-pond').client, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
