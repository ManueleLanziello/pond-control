import { createOperationLock } from './operation-lock.js';

export const DEVICE_POLL_INTERVAL_MS = 2000;
export const DEVICE_FRESHNESS_MS = 5000;
export const OFFLINE_FAILURE_THRESHOLD = 3;
export const LOGIN_BACKOFF_MS = Object.freeze([0, 2000, 5000, 10000]);

export class DeviceCommunicationError extends Error {
  constructor(message, code = 'DEVICE_COMMUNICATION_FAILED') {
    super(message);
    this.name = 'DeviceCommunicationError';
    this.code = code;
  }
}

function decodeAlias(value) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const input = value.replace(/=+$/, '');
    const roundTrip = Buffer.from(decoded).toString('base64').replace(/=+$/, '');
    return decoded && roundTrip === input ? decoded : value;
  } catch { return value; }
}

function technicalIdentity(device) {
  return JSON.stringify([device.ip, device.model, device.protocol, device.adapter, device.type]);
}

function createEntry(device) {
  return {
    device,
    client: null,
    lock: createOperationLock(),
    info: null,
    lastReadTimestamp: null,
    online: false,
    communicationDegraded: false,
    consecutiveFailures: 0,
    currentError: null,
    nextAttemptAt: 0,
    inProgress: false,
  };
}

export class DeviceManager {
  constructor({
    deviceList,
    createClient,
    now = () => Date.now(),
    log = () => {},
    pollIntervalMs = DEVICE_POLL_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.deviceList = deviceList;
    this.createClient = createClient;
    this.now = now;
    this.log = log;
    this.pollIntervalMs = pollIntervalMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.timer = null;
    this.pollPromise = null;
    this.cyclePromise = null;
    this.entries = new Map(deviceList.map((device) => [device.id, createEntry(device)]));
  }

  hasDevice(deviceId) { return this.entries.has(deviceId); }

  reconcileDevices(deviceList) {
    const desired = new Map(deviceList.map((device) => [device.id, device]));
    const removed = [];
    const added = [];
    const replaced = [];
    const preserved = [];
    for (const [id, entry] of this.entries) {
      const next = desired.get(id);
      if (!next) {
        this.invalidate(entry);
        this.entries.delete(id);
        removed.push(id);
      } else if (technicalIdentity(entry.device) !== technicalIdentity(next)) {
        this.invalidate(entry);
        this.entries.set(id, createEntry(next));
        replaced.push(id);
      } else {
        entry.device = next;
        preserved.push(id);
      }
    }
    for (const [id, device] of desired) {
      if (!this.entries.has(id)) {
        this.entries.set(id, createEntry(device));
        added.push(id);
      }
    }
    this.deviceList = [...deviceList];
    return { added, removed, replaced, preserved };
  }

  registerDevice(device) {
    return this.reconcileDevices([...this.deviceList.filter(({ id }) => id !== device.id), device]);
  }

  updateDevice(deviceId, device) {
    if (!this.entries.has(deviceId)) throw new DeviceCommunicationError('Dispositivo non configurato.', 'DEVICE_NOT_FOUND');
    return this.reconcileDevices(this.deviceList.map((current) => current.id === deviceId ? device : current));
  }

  removeDevice(deviceId) {
    return this.reconcileDevices(this.deviceList.filter(({ id }) => id !== deviceId));
  }

  entry(deviceId) {
    const entry = this.entries.get(deviceId);
    if (!entry) throw new DeviceCommunicationError('Dispositivo non configurato.', 'DEVICE_NOT_FOUND');
    return entry;
  }

  snapshot(deviceId) {
    const entry = this.entry(deviceId);
    const { device, info } = entry;
    return {
      id: device.id,
      name: decodeAlias(info?.nickname) || device.fallbackName,
      model: info?.model || device.model,
      ip: device.ip,
      type: info?.type || device.type,
      state: typeof info?.device_on === 'boolean' ? (info.device_on ? 'ON' : 'OFF') : null,
      rssi: typeof info?.rssi === 'number' ? info.rssi : null,
      protocol: device.protocolLabel,
      online: entry.online,
      communicationDegraded: entry.communicationDegraded,
      consecutiveFailures: entry.consecutiveFailures,
      lastReadAt: entry.lastReadTimestamp === null
        ? null
        : new Date(entry.lastReadTimestamp).toISOString(),
    };
  }

  snapshots() {
    return this.deviceList.map((device) => this.snapshot(device.id));
  }

  isFreshAndReliable(deviceId, maxAgeMs = DEVICE_FRESHNESS_MS) {
    const entry = this.entry(deviceId);
    return entry.online
      && !entry.communicationDegraded
      && entry.consecutiveFailures === 0
      && entry.lastReadTimestamp !== null
      && this.now() - entry.lastReadTimestamp <= maxAgeMs;
  }

  clientFor(entry) {
    if (!entry.client) entry.client = this.createClient(entry.device);
    return entry.client;
  }

  invalidate(entry) {
    try { entry.client?.close(); } catch { /* best effort */ }
    entry.client = null;
  }

  recordSuccess(entry, info) {
    const wasUnavailable = !entry.online || entry.communicationDegraded;
    entry.info = info;
    entry.lastReadTimestamp = this.now();
    entry.online = true;
    entry.communicationDegraded = false;
    entry.consecutiveFailures = 0;
    entry.currentError = null;
    entry.nextAttemptAt = 0;
    if (wasUnavailable) this.log(`[${entry.device.model}] ONLINE`);
  }

  recordFailure(entry, error) {
    const firstFailure = entry.consecutiveFailures === 0;
    entry.consecutiveFailures += 1;
    entry.communicationDegraded = true;
    entry.currentError = error?.message || 'errore di comunicazione';
    const backoffIndex = Math.min(entry.consecutiveFailures - 1, LOGIN_BACKOFF_MS.length - 1);
    entry.nextAttemptAt = this.now() + LOGIN_BACKOFF_MS[backoffIndex];
    if (firstFailure) this.log(`[${entry.device.model}] comunicazione instabile`);
    if (entry.consecutiveFailures === OFFLINE_FAILURE_THRESHOLD) {
      entry.online = false;
      this.log(`[${entry.device.model}] OFFLINE`);
    }
  }

  async readUnlocked(entry) {
    if (this.now() < entry.nextAttemptAt) {
      throw new DeviceCommunicationError('Nuovo tentativo rinviato dal backoff.', 'DEVICE_BACKOFF');
    }
    entry.inProgress = true;
    try {
      const info = await this.clientFor(entry).getDeviceInfo();
      this.recordSuccess(entry, info);
      return this.snapshot(entry.device.id);
    } catch (error) {
      this.invalidate(entry);
      this.recordFailure(entry, error);
      throw new DeviceCommunicationError('Comunicazione dispositivo non riuscita.', 'DEVICE_COMMUNICATION_FAILED');
    } finally {
      entry.inProgress = false;
    }
  }

  async setDeviceOnUnlocked(entry, deviceOn) {
    entry.inProgress = true;
    try {
      await this.clientFor(entry).setDeviceOn(deviceOn);
      const info = await this.clientFor(entry).getDeviceInfo();
      this.recordSuccess(entry, info);
      if (info?.device_on !== deviceOn) {
        throw new DeviceCommunicationError('Stato verificato diverso da quello richiesto.', 'STATE_MISMATCH');
      }
      return this.snapshot(entry.device.id);
    } catch (error) {
      this.invalidate(entry);
      this.recordFailure(entry, error);
      if (error instanceof DeviceCommunicationError && error.code === 'STATE_MISMATCH') throw error;
      throw new DeviceCommunicationError('Scrittura o verifica dispositivo non riuscita.', 'DEVICE_WRITE_FAILED');
    } finally {
      entry.inProgress = false;
    }
  }

  read(deviceId) {
    const entry = this.entry(deviceId);
    return entry.lock.runExclusive(() => this.readUnlocked(entry));
  }

  setDeviceOn(deviceId, deviceOn) {
    const entry = this.entry(deviceId);
    return entry.lock.runExclusive(() => this.setDeviceOnUnlocked(entry, deviceOn));
  }

  withDevices(deviceIds, operation) {
    const ids = [...new Set(deviceIds)].sort();
    const acquire = (index) => {
      if (index >= ids.length) {
        return operation({
          read: (deviceId) => this.readUnlocked(this.entry(deviceId)),
          setDeviceOn: (deviceId, value) => this.setDeviceOnUnlocked(this.entry(deviceId), value),
          snapshot: (deviceId) => this.snapshot(deviceId),
          isFreshAndReliable: (deviceId, maxAgeMs) => this.isFreshAndReliable(deviceId, maxAgeMs),
        });
      }
      const entry = this.entry(ids[index]);
      return entry.lock.runExclusive(() => acquire(index + 1));
    };
    return acquire(0);
  }

  pollAll() {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = Promise.all(this.deviceList.map(async (device) => {
      try { return await this.read(device.id); } catch { return this.snapshot(device.id); }
    })).finally(() => { this.pollPromise = null; });
    return this.pollPromise;
  }

  startPolling(afterPoll = async () => {}) {
    if (this.timer !== null) return Promise.resolve(this.snapshots());
    const cycle = () => {
      if (this.cyclePromise) return this.cyclePromise;
      this.cyclePromise = (async () => {
      const snapshots = await this.pollAll();
      await afterPoll(snapshots);
      return snapshots;
      })().finally(() => { this.cyclePromise = null; });
      return this.cyclePromise;
    };
    const initial = cycle();
    this.timer = this.setIntervalFn(() => { void cycle(); }, this.pollIntervalMs);
    return initial;
  }

  stop() {
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    this.timer = null;
    for (const entry of this.entries.values()) this.invalidate(entry);
  }
}
