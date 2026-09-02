import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { supportedCameraModel } from './supported-device-catalog.js';

export const VALID_DEVICE_ROLES = Object.freeze(['pump', 'heater', 'none']);
const ASSIGNABLE_ROLES = new Set([...VALID_DEVICE_ROLES, 'pond_temperature', 'pond_camera']);

function validateAssignments(assignments, deviceIds, allowedById = null) {
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
    throw new Error('Configurazione ruoli non valida.');
  }
  const normalized = {};
  const occupied = new Set();
  for (const id of deviceIds) {
    const role = assignments[id] ?? 'none';
    if (!ASSIGNABLE_ROLES.has(role) || (allowedById && !allowedById.get(id)?.has(role))) throw new Error(`Ruolo non valido per ${id}.`);
    if (role !== 'none' && occupied.has(role)) throw new Error(`Il ruolo ${role} è assegnato più volte.`);
    occupied.add(role);
    normalized[id] = role;
  }
  return normalized;
}

export class DeviceRoleStore {
  constructor({ filePath, deviceList }) {
    this.filePath = filePath;
    this.deviceIds = deviceList.map((device) => device.id);
    this.allowedById = new Map(deviceList.map((device) => [device.id, device.connectionType === 'cloud' || device.tuyaDeviceId !== undefined ? new Set(['none', 'pond_temperature']) : supportedCameraModel(device.model) ? new Set(['none', 'pond_camera']) : new Set(['none', 'pump', 'heater'])]));
    this.defaults = validateAssignments(
      Object.fromEntries(deviceList.map((device) => [device.id, device.role || 'none'])),
      this.deviceIds, this.allowedById,
    );
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return validateAssignments(parsed.assignments, this.deviceIds, this.allowedById);
    } catch (error) {
      if (error.code === 'ENOENT') return { ...this.defaults };
      throw error;
    }
  }

  async assign(deviceId, role) {
    if (!this.deviceIds.includes(deviceId)) throw new Error('Dispositivo non configurato.');
    if (!ASSIGNABLE_ROLES.has(role) || !this.allowedById.get(deviceId)?.has(role)) throw new Error('Ruolo non valido.');
    const operation = this.writeQueue.then(async () => {
      const assignments = await this.read();
      if (role !== 'none') {
        const previousRole = assignments[deviceId];
        for (const id of this.deviceIds) {
          if (id !== deviceId && assignments[id] === role) {
            assignments[id] = previousRole !== 'none' ? previousRole : 'none';
          }
        }
      }
      assignments[deviceId] = role;
      await this.write(assignments);
      return assignments;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async reconcileDevices(deviceList, legacyAssignments = {}) {
    const nextIds = deviceList.map((device) => device.id);
    if (nextIds.length === this.deviceIds.length && nextIds.every((id, index) => id === this.deviceIds[index])) {
      return this.read();
    }
    const previousIds = this.deviceIds;
    const previousDefaults = this.defaults;
    const previousAllowed = this.allowedById;
    this.deviceIds = nextIds;
    this.allowedById = new Map(deviceList.map((device) => [device.id, device.connectionType === 'cloud' || device.tuyaDeviceId !== undefined ? new Set(['none', 'pond_temperature']) : supportedCameraModel(device.model) ? new Set(['none', 'pond_camera']) : new Set(['none', 'pump', 'heater'])]));
    this.defaults = validateAssignments(
      Object.fromEntries(nextIds.map((id) => [id, previousDefaults[id] || legacyAssignments[id] || deviceList.find((device) => device.id === id)?.role || 'none'])), nextIds, this.allowedById,
    );
    try {
      const assignments = await this.read();
      for (const id of nextIds) if (!previousIds.includes(id) && assignments[id] === 'none' && this.defaults[id] !== 'none') assignments[id] = this.defaults[id];
      await this.write(assignments);
      return assignments;
    } catch (error) {
      this.deviceIds = previousIds;
      this.defaults = previousDefaults;
      this.allowedById = previousAllowed;
      throw error;
    }
  }

  async write(assignments) {
    const validated = validateAssignments(assignments, this.deviceIds, this.allowedById);
    const payload = `${JSON.stringify({ version: 1, assignments: validated }, null, 2)}\n`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
