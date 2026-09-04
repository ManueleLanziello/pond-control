import {
  DewinTuyaAdapter,
  buildDewinMeasurementSnapshot,
  parseTuyaDatapoints,
  TuyaCloudClient,
} from '@smarthome/core';

export const DEWIN_REFRESH_INTERVAL_MS = 60_000;
export const DEWIN_STALE_AFTER_MS = 5 * 60_000;

export { parseTuyaDatapoints, TuyaCloudClient };

export function buildDewinSnapshot({ device, statuses, specification, updatedAt }) {
  const coreSnapshot = buildDewinMeasurementSnapshot({ device, statuses, specification, updatedAt });
  return pondSnapshotFromCore(coreSnapshot);
}

function pondSnapshotFromCore(coreSnapshot) {
  return {
    available: true,
    online: coreSnapshot.online,
    deviceId: coreSnapshot.deviceId,
    name: coreSnapshot.name,
    category: coreSnapshot.category,
    ambientTemperature: coreSnapshot.measurements.ambientTemperature,
    ambientHumidity: coreSnapshot.measurements.ambientHumidity,
    batteryState: coreSnapshot.measurements.batteryState,
    externalProbeTemperature: coreSnapshot.measurements.externalProbeTemperature,
    temperatureCalibration: coreSnapshot.measurements.temperatureCalibration,
    humidityCalibration: coreSnapshot.measurements.humidityCalibration,
    temperatureCorrection: coreSnapshot.measurements.temperatureCorrection,
    datapoints: coreSnapshot.datapoints,
    updatedAt: coreSnapshot.updatedAt,
    stale: false,
  };
}

export class DewinService {
  constructor({ client, adapter = null, historyStore = null, refreshIntervalMs = DEWIN_REFRESH_INTERVAL_MS, staleAfterMs = DEWIN_STALE_AFTER_MS, now = () => Date.now(), log = () => {}, logError = () => {} }) {
    this.client = client;
    this.adapter = adapter || new DewinTuyaAdapter({ client, now: () => new Date(this.now()).toISOString() });
    this.historyStore = historyStore;
    this.refreshIntervalMs = refreshIntervalMs;
    this.staleAfterMs = staleAfterMs;
    this.now = now;
    this.log = log;
    this.logError = logError;
    this.current = {
      available: false, online: false, deviceId: client?.deviceId ?? null, name: null, category: null,
      ambientTemperature: null, ambientHumidity: null, batteryState: null,
      externalProbeTemperature: null, temperatureCalibration: null, humidityCalibration: null,
      temperatureCorrection: null, datapoints: [], updatedAt: null, stale: true,
    };
    this.timer = null;
    this.refreshPromise = null;
    this.loaded = false;
    this.errorActive = false;
    this.prolongedStaleLogged = false;
    this.historyErrorActive = false;
  }

  snapshot() {
    const updatedMs = this.current.updatedAt ? Date.parse(this.current.updatedAt) : 0;
    const expired = !updatedMs || this.now() - updatedMs > this.staleAfterMs;
    return structuredClone({ ...this.current, stale: this.current.stale || expired });
  }

  async history(date) {
    if (!this.historyStore) return { date: date ?? null, samples: [] };
    return this.historyStore.read(date);
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        this.current = pondSnapshotFromCore(await this.adapter.read());
        if (this.historyStore && this.current.online
          && Number.isFinite(this.current.externalProbeTemperature?.value)
          && Number.isFinite(this.current.ambientTemperature?.value)) {
          try {
            await this.historyStore.appendSample({
              timestamp: this.current.updatedAt,
              pond: this.current.externalProbeTemperature?.value,
              ambient: this.current.ambientTemperature?.value,
            });
            if (this.historyErrorActive) this.log('[DEWIN] persistenza storico ripristinata');
            this.historyErrorActive = false;
          } catch (historyError) {
            if (!this.historyErrorActive) this.logError(`[DEWIN] storico non salvato: ${historyError.message}`);
            this.historyErrorActive = true;
          }
        }
        if (!this.loaded) this.log('[DEWIN] dati Tuya Cloud disponibili');
        else if (this.errorActive) this.log('[DEWIN] collegamento Tuya Cloud ripristinato');
        this.loaded = true;
        this.errorActive = false;
        this.prolongedStaleLogged = false;
      } catch (refreshError) {
        this.current = { ...this.current, online: false, stale: true };
        if (!this.errorActive) this.logError(`[DEWIN] aggiornamento non riuscito: ${refreshError.message}`);
        this.errorActive = true;
        const updatedMs = this.current.updatedAt ? Date.parse(this.current.updatedAt) : 0;
        if (updatedMs && this.now() - updatedMs > this.staleAfterMs && !this.prolongedStaleLogged) {
          this.logError('[DEWIN] ultimo dato valido obsoleto da oltre 5 minuti');
          this.prolongedStaleLogged = true;
        }
      } finally {
        this.refreshPromise = null;
      }
      return this.snapshot();
    })();
    return this.refreshPromise;
  }

  async start() {
    await this.refresh();
    if (this.historyStore) {
      void this.historyStore.prune().catch((pruneError) => {
        this.logError(`[DEWIN] retention storico non riuscita: ${pruneError.message}`);
      });
    }
    if (!this.timer) this.timer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function createDewinServiceFromEnvironment(options = {}) {
  const clientId = process.env.TUYA_CLIENT_ID?.trim();
  const clientSecret = process.env.TUYA_CLIENT_SECRET?.trim();
  const deviceId = options.deviceId?.trim() || process.env.TUYA_DEVICE_ID?.trim();
  if (!clientId || !clientSecret || !deviceId) throw new Error('Credenziali Tuya mancanti');
  const client = new TuyaCloudClient({
    clientId,
    clientSecret,
    deviceId,
    baseUrl: process.env.TUYA_BASE_URL?.trim() || 'https://openapi.tuyaeu.com',
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  const { deviceId: ignoredDeviceId, ...serviceOptions } = options;
  return new DewinService({ ...serviceOptions, client });
}
