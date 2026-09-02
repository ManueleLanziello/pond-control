import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { requireSupportedDeviceModel } from './supported-device-catalog.js';

export const HARDWARE_KINDS = Object.freeze(['plugs', 'sensors', 'cameras']);
export const SENSOR_ROLES = Object.freeze(['none', 'pond_temperature']);
export const CAMERA_ROLES = Object.freeze(['none', 'pond_camera']);
const HARDWARE_REGISTRY_VERSION = 4;
const MAC_PATTERN = /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const DEWIN_SUPPORTED_MODEL = 'T & H Sensor with external probe';

function normalizedIntegrationName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isLegacyDewinRecord(sensor) {
  if (String(sensor?.model || '').trim()) return false;
  const cloudConnection = normalizedIntegrationName(sensor?.connectionType) === 'cloud';
  const tuyaIntegration = [sensor?.protocol, sensor?.provider, sensor?.runtimeAdapter]
    .some((value) => normalizedIntegrationName(value).includes('tuya'));
  const knownDewinShape = sensor?.id === 'dewin-pond'
    || normalizedIntegrationName(sensor?.type).includes('sondaesterna')
    || normalizedIntegrationName(sensor?.type).includes('externalprobe');
  return cloudConnection && tuyaIntegration && knownDewinShape;
}

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

function normalizeRecord(kind, input, { allowIncomplete = false } = {}) {
  const alias = requiredText(input.alias, 'alias');
  const category = { plugs: 'plug', sensors: 'sensor', cameras: 'camera' }[kind];
  let definition;
  try { definition = requireSupportedDeviceModel(category, input.model); } catch (error) { throw new HardwareRegistryError(error.message, error.code); }
  const model = definition.model; const connectionType = definition.connectionType;
  const ip = connectionType === 'cloud' ? '' : validateIpv4(input.ip);
  let mac = '';
  const macRequired = kind === 'plugs' || kind === 'cameras';
  if (input.mac || (!allowIncomplete && macRequired)) mac = normalizeMac(input.mac);
  const tuyaDeviceId = kind === 'sensors'
    ? (allowIncomplete ? String(input.tuyaDeviceId || '').trim() : requiredText(input.tuyaDeviceId, 'tuyaDeviceId'))
    : undefined;
  return {
    id: requiredText(input.id, 'id'), alias, model, ip, mac, protocol: definition.protocol,
    manufacturer: definition.manufacturer, runtimeAdapter: definition.adapter, connectionType,
    ...(definition.provider ? { provider: definition.provider } : {}), ...(definition.type ? { type: definition.type } : {}),
    ...(tuyaDeviceId === undefined ? {} : { tuyaDeviceId }),
    configurationStatus: (connectionType === 'cloud' ? Boolean(tuyaDeviceId) || (allowIncomplete && input.verificationStatus === 'verified') : Boolean(mac)) ? 'complete' : 'incomplete',
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
  for (const record of normalized) {
    if (ids.has(record.id)) throw new HardwareRegistryError('ID dispositivo duplicato.', 'DUPLICATE_ID');
    if (record.ip && ips.has(record.ip)) throw new HardwareRegistryError('Indirizzo IP già configurato.', 'DUPLICATE_IP');
    if (record.mac && macs.has(record.mac)) throw new HardwareRegistryError('Indirizzo MAC già configurato.', 'DUPLICATE_MAC');
    ids.add(record.id);
    if (record.ip) ips.add(record.ip);
    if (record.mac) macs.add(record.mac);
  }
  return normalized;
}

export function validateHardwareRegistry(value, options = {}) {
  if (!value || typeof value !== 'object') throw new HardwareRegistryError('Registro hardware non valido.');
  const registry = {
    version: HARDWARE_REGISTRY_VERSION,
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
    if (record.ip && ips.has(record.ip)) throw new HardwareRegistryError('Indirizzo IP già configurato.', 'DUPLICATE_IP');
    if (record.mac && macs.has(record.mac)) throw new HardwareRegistryError('Indirizzo MAC già configurato.', 'DUPLICATE_MAC');
    ids.add(record.id);
    if (record.ip) ips.add(record.ip);
    if (record.mac) macs.add(record.mac);
  }
  return registry;
}

export function defaultHardwareRegistry({ deviceList, cameraIp, cameraMac = '', dewinDeviceId = '', dewinConfigured = false }) {
  const registry = validateHardwareRegistry({
    plugs: deviceList.map((device) => ({
      id: device.id,
      alias: device.fallbackName,
      model: device.model,
      ip: device.ip,
      mac: '',
      protocol: device.protocol,
    })),
    sensors: (dewinDeviceId || dewinConfigured) ? [{
      id: 'dewin-pond', alias: 'Dewin Pond', type: 'Sensore temperatura con sonda esterna',
      model: 'T & H Sensor with external probe', tuyaDeviceId: dewinDeviceId, ip: '', mac: '',
      protocol: 'tuya-cloud', provider: 'Tuya Cloud', connectionType: 'cloud', role: 'pond_temperature', verificationStatus: 'verified',
      detected: { provider: 'Tuya Cloud' },
    }] : [],
    cameras: cameraIp ? [{
      id: 'tapo-c410-pond', alias: 'C410 Pond', model: 'C410', ip: cameraIp,
      mac: cameraMac, protocol: 'pytapo-https', role: 'pond_camera',
    }] : [],
  }, { allowIncomplete: true });
  Object.defineProperty(registry, 'legacyRoleAssignments', { value: {
    ...((dewinDeviceId || dewinConfigured) ? { 'dewin-pond': 'pond_temperature' } : {}),
    ...(cameraIp ? { 'tapo-c410-pond': 'pond_camera' } : {}),
  }, enumerable: false });
  return registry;
}

export class HardwareRegistryStore {
  constructor({ filePath, defaults, idFactory = () => crypto.randomUUID() }) {
    this.filePath = filePath;
    this.legacyRoleAssignments = { ...(defaults.legacyRoleAssignments || {}), ...Object.fromEntries(HARDWARE_KINDS.flatMap((kind) => (defaults[kind] || []).filter((record) => record.role && record.role !== 'none').map((record) => [record.id, record.role]))) };
    this.defaults = validateHardwareRegistry(defaults, { allowIncomplete: true });
    this.idFactory = idFactory;
    this.writeQueue = Promise.resolve();
    this.bootstrapPromise = null;
    this.pendingMigration = false;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      for (const kind of HARDWARE_KINDS) for (const record of parsed[kind] || []) if (record.role && record.role !== 'none') this.legacyRoleAssignments[record.id] = record.role;
      for (const sensor of parsed.sensors || []) if (isLegacyDewinRecord(sensor)) sensor.model = DEWIN_SUPPORTED_MODEL;
      // Legacy Dewin identity was non-secret but lived in .env. Import it only when absent.
      for (const sensor of parsed.sensors || []) if (!sensor.tuyaDeviceId && sensor.id === 'dewin-pond' && process.env.TUYA_DEVICE_ID?.trim()) sensor.tuyaDeviceId = process.env.TUYA_DEVICE_ID.trim();
      const registry = validateHardwareRegistry(parsed, { allowIncomplete: true });
      if (Number(parsed.version || 1) < HARDWARE_REGISTRY_VERSION) {
        this.pendingMigration = true;
        const defaultDewin = this.defaults.sensors.find((sensor) => sensor.id === 'dewin-pond');
        if (defaultDewin && !registry.sensors.some((sensor) => sensor.id === defaultDewin.id)) {
          registry.sensors.push(structuredClone(defaultDewin));
        }
        // La scrittura v4 avviene alla prima mutazione, dopo che il role store ha
        // importato i ruoli legacy: così un arresto a metà startup non perde ruoli.
        return validateHardwareRegistry(registry, { allowIncomplete: true });
      }
      this.pendingMigration = false;
      return registry;
    } catch (error) {
      if (error.code === 'ENOENT') return this.#bootstrap();
      throw error;
    }
  }

  #bootstrap() {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = (async () => {
        await this.#persist(this.defaults);
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
      const technicalFields = ['ip', 'mac', 'model', 'tuyaDeviceId'];
      const physicalChanged = technicalFields
        .some((field) => input[field] !== undefined && input[field] !== previous[field]);
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
      if (detected?.mac) {
        const detectedMac = normalizeMac(detected.mac);
        if (record.mac && normalizeMac(record.mac) !== detectedMac) {
          throw new HardwareRegistryError('Il MAC rilevato non corrisponde alla configurazione.', 'MAC_MISMATCH');
        }
        record.mac = detectedMac;
        detected = { ...detected, mac: detectedMac };
      }
      record.configurationStatus = record.connectionType === 'cloud' || record.mac ? 'complete' : 'incomplete';
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
      return removed;
    });
  }

  async completePendingMigration(registry) {
    if (!this.pendingMigration) return false;
    const validated = validateHardwareRegistry(registry, { allowIncomplete: true });
    await this.#persist(validated);
    this.pendingMigration = false;
    return true;
  }

  #mutate(operation) {
    const pending = this.writeQueue.then(async () => {
      const registry = await this.read();
      const result = await operation(registry);
      const validated = validateHardwareRegistry(registry, { allowIncomplete: true });
      await this.#persist(validated);
      return structuredClone(result);
    });
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async #persist(registry) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
