import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export const HARDWARE_KINDS = Object.freeze(['plugs', 'sensors', 'cameras']);
export const SENSOR_ROLES = Object.freeze(['none', 'pond_temperature', 'external_temperature']);
export const CAMERA_ROLES = Object.freeze(['none', 'pond_camera']);
const MAC_PATTERN = /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

export class HardwareRegistryError extends Error {
  constructor(message, code = 'INVALID_HARDWARE_CONFIGURATION') {
    super(message);
    this.name = 'HardwareRegistryError';
    this.code = code;
  }
}

export function normalizeMac(value) {
  const mac = String(value || '').trim();
  if (!MAC_PATTERN.test(mac)) throw new HardwareRegistryError('Indirizzo MAC non valido.', 'INVALID_MAC');
  return mac.replaceAll('-', ':').toUpperCase();
}

export function validateIpv4(value) {
  const ip = String(value || '').trim();
  if (net.isIP(ip) !== 4) throw new HardwareRegistryError('Indirizzo IPv4 non valido.', 'INVALID_IP');
  return ip;
}

function requiredText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new HardwareRegistryError(`${label} obbligatorio.`, `MISSING_${label.toUpperCase()}`);
  return normalized;
}

function allowedRoles(kind) {
  if (kind === 'sensors') return SENSOR_ROLES;
  if (kind === 'cameras') return CAMERA_ROLES;
  return ['none'];
}

function normalizeRecord(kind, input, { allowIncomplete = false } = {}) {
  const alias = requiredText(input.alias, 'alias');
  const model = requiredText(input.model || input.type, kind === 'sensors' ? 'tipo' : 'modello');
  const ip = validateIpv4(input.ip);
  let mac = '';
  if (input.mac || !allowIncomplete) mac = normalizeMac(input.mac);
  const protocol = requiredText(input.protocol || (kind === 'plugs' ? 'tpap' : kind === 'cameras' ? 'pytapo-https' : 'none'), 'protocollo');
  const role = kind === 'plugs' ? undefined : String(input.role || 'none');
  if (role !== undefined && !allowedRoles(kind).includes(role)) {
    throw new HardwareRegistryError('Ruolo non valido.', 'INVALID_ROLE');
  }
  return {
    id: requiredText(input.id, 'id'), alias, model, ip, mac, protocol,
    ...(role === undefined ? {} : { role }),
    configurationStatus: mac ? 'complete' : 'incomplete',
    verificationStatus: input.verificationStatus === 'verified' ? 'verified' : 'pending',
    verifiedAt: input.verificationStatus === 'verified' ? input.verifiedAt || null : null,
    detected: input.verificationStatus === 'verified' ? input.detected || null : null,
  };
}

function validateCollection(kind, records, options) {
  const normalized = records.map((record) => normalizeRecord(kind, record, options));
  const ids = new Set();
  const ips = new Set();
  const macs = new Set();
  const roles = new Set();
  for (const record of normalized) {
    if (ids.has(record.id)) throw new HardwareRegistryError('ID dispositivo duplicato.', 'DUPLICATE_ID');
    if (ips.has(record.ip)) throw new HardwareRegistryError('Indirizzo IP già configurato.', 'DUPLICATE_IP');
    if (record.mac && macs.has(record.mac)) throw new HardwareRegistryError('Indirizzo MAC già configurato.', 'DUPLICATE_MAC');
    if (record.role && record.role !== 'none' && roles.has(record.role)) {
      throw new HardwareRegistryError('Ruolo già assegnato.', 'DUPLICATE_ROLE');
    }
    ids.add(record.id);
    ips.add(record.ip);
    if (record.mac) macs.add(record.mac);
    if (record.role && record.role !== 'none') roles.add(record.role);
  }
  return normalized;
}

export function validateHardwareRegistry(value, options = {}) {
  if (!value || typeof value !== 'object') throw new HardwareRegistryError('Registro hardware non valido.');
  const registry = {
    version: 1,
    plugs: validateCollection('plugs', value.plugs || [], options),
    sensors: validateCollection('sensors', value.sensors || [], options),
    cameras: validateCollection('cameras', value.cameras || [], options),
  };
  const all = HARDWARE_KINDS.flatMap((kind) => registry[kind]);
  const ids = new Set();
  const ips = new Set();
  const macs = new Set();
  for (const record of all) {
    if (ids.has(record.id)) throw new HardwareRegistryError('ID dispositivo duplicato.', 'DUPLICATE_ID');
    if (ips.has(record.ip)) throw new HardwareRegistryError('Indirizzo IP già configurato.', 'DUPLICATE_IP');
    if (record.mac && macs.has(record.mac)) throw new HardwareRegistryError('Indirizzo MAC già configurato.', 'DUPLICATE_MAC');
    ids.add(record.id);
    ips.add(record.ip);
    if (record.mac) macs.add(record.mac);
  }
  return registry;
}

export function defaultHardwareRegistry({ deviceList, cameraIp }) {
  return validateHardwareRegistry({
    plugs: deviceList.map((device) => ({
      id: device.id,
      alias: device.fallbackName,
      model: device.model,
      ip: device.ip,
      mac: '',
      protocol: device.protocol,
    })),
    sensors: [],
    cameras: cameraIp ? [{
      id: 'tapo-c410-pond', alias: 'C410 Pond', model: 'C410', ip: cameraIp,
      mac: '', protocol: 'pytapo-https', role: 'pond_camera',
    }] : [],
  }, { allowIncomplete: true });
}

export class HardwareRegistryStore {
  constructor({ filePath, defaults, idFactory = () => crypto.randomUUID() }) {
    this.filePath = filePath;
    this.defaults = validateHardwareRegistry(defaults, { allowIncomplete: true });
    this.idFactory = idFactory;
    this.writeQueue = Promise.resolve();
    this.bootstrapPromise = null;
  }

  async read() {
    try {
      return validateHardwareRegistry(JSON.parse(await readFile(this.filePath, 'utf8')), { allowIncomplete: true });
    } catch (error) {
      if (error.code === 'ENOENT') return this.#bootstrap();
      throw error;
    }
  }

  #bootstrap() {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = (async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(this.defaults, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        try {
          await rename(temporaryPath, this.filePath);
        } catch (error) {
          if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
        }
        return structuredClone(this.defaults);
      })();
    }
    return this.bootstrapPromise;
  }

  async create(kind, input) {
    return this.#mutate(async (registry) => {
      const record = normalizeRecord(kind, { ...input, id: input.id || this.idFactory() });
      registry[kind].push(record);
      return record;
    });
  }

  async update(kind, id, input) {
    return this.#mutate(async (registry) => {
      const index = registry[kind].findIndex((record) => record.id === id);
      if (index < 0) throw new HardwareRegistryError('Dispositivo non trovato.', 'NOT_FOUND');
      const previous = registry[kind][index];
      const physicalChanged = ['ip', 'mac', 'model'].some((field) => input[field] !== undefined && input[field] !== previous[field]);
      registry[kind][index] = normalizeRecord(kind, {
        ...previous, ...input, id,
        verificationStatus: physicalChanged ? 'pending' : previous.verificationStatus,
        verifiedAt: physicalChanged ? null : previous.verifiedAt,
        detected: physicalChanged ? null : previous.detected,
      }, { allowIncomplete: !physicalChanged && !previous.mac });
      return registry[kind][index];
    });
  }

  async markVerified(kind, id, detected, now = new Date().toISOString()) {
    return this.#mutate(async (registry) => {
      const record = registry[kind].find((candidate) => candidate.id === id);
      if (!record) throw new HardwareRegistryError('Dispositivo non trovato.', 'NOT_FOUND');
      record.verificationStatus = 'verified';
      record.verifiedAt = now;
      record.detected = detected;
      return record;
    });
  }

  async remove(kind, id) {
    return this.#mutate(async (registry) => {
      const index = registry[kind].findIndex((record) => record.id === id);
      if (index < 0) throw new HardwareRegistryError('Dispositivo non trovato.', 'NOT_FOUND');
      const [removed] = registry[kind].splice(index, 1);
      if (removed.role && removed.role !== 'none') {
        throw new HardwareRegistryError('Liberare il ruolo prima di rimuovere il dispositivo.', 'ROLE_ASSIGNED');
      }
      return removed;
    });
  }

  #mutate(operation) {
    const pending = this.writeQueue.then(async () => {
      const registry = await this.read();
      const result = await operation(registry);
      const validated = validateHardwareRegistry(registry, { allowIncomplete: true });
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      return structuredClone(result);
    });
    this.writeQueue = pending.catch(() => {});
    return pending;
  }
}
