import { DeviceManager } from '../../src/device-manager.js';

export function createManagerHarness(deviceList, options = {}) {
  let clock = options.now ?? 1_000_000;
  const states = { ...(options.states || {}) };
  const events = [];
  const clientCreations = new Map();
  const readFailures = { ...(options.readFailures || {}) };
  const writeFailures = new Set(options.writeFailures || []);
  const sticky = new Set(options.sticky || []);
  const delays = options.delays || {};

  const manager = new DeviceManager({
    deviceList,
    now: () => clock,
    log: (message) => events.push(['log', message]),
    createClient(device) {
      clientCreations.set(device.id, (clientCreations.get(device.id) || 0) + 1);
      events.push(['client', device.id]);
      return {
        async getDeviceInfo() {
          events.push(['read', device.id]);
          if (delays[device.id]) await delays[device.id]();
          if ((readFailures[device.id] || 0) > 0) {
            readFailures[device.id] -= 1;
            throw new Error('simulated read failure');
          }
          return {
            model: device.model,
            nickname: Buffer.from(`Test ${device.model}`).toString('base64'),
            type: device.type,
            device_on: states[device.id],
            rssi: -60,
          };
        },
        async setDeviceOn(value) {
          events.push(['write', device.id, value]);
          if (writeFailures.has(device.id)) throw new Error('simulated write failure');
          if (!sticky.has(device.id)) states[device.id] = value;
        },
        close() { events.push(['close', device.id]); },
      };
    },
  });

  return {
    manager, states, events, clientCreations, readFailures, writeFailures, sticky,
    advance(ms) { clock += ms; },
    setNow(value) { clock = value; },
  };
}
