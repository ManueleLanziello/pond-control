import crypto from 'node:crypto';

export const DEWIN_REFRESH_INTERVAL_MS = 60_000;
export const DEWIN_STALE_AFTER_MS = 5 * 60_000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const EMPTY_BODY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const NORMALIZED_CODES = Object.freeze({
  temp_current: 'ambientTemperature',
  humidity_value: 'ambientHumidity',
  battery_state: 'batteryState',
  temp_current_external: 'externalProbeTemperature',
  temp_calibration: 'temperatureCalibration',
  hum_calibration: 'humidityCalibration',
  temp_correction: 'temperatureCorrection',
});

function normalizedUnit(unit) {
  return unit === '℃' ? '°C' : unit ?? null;
}

function parseValues(values) {
  if (values && typeof values === 'object') return values;
  if (typeof values !== 'string' || !values) return null;
  try { return JSON.parse(values); } catch { return null; }
}

export function parseTuyaDatapoints(statuses, specification) {
  const metadata = new Map((specification?.status || []).map((entry) => [entry.code, entry]));
  return (Array.isArray(statuses) ? statuses : []).map((status) => {
    const spec = metadata.get(status.code);
    const values = parseValues(spec?.values);
    const scale = Number.isInteger(values?.scale) ? values.scale : null;
    const converted = typeof status.value === 'number' && scale !== null
      ? status.value / (10 ** scale)
      : status.value;
    return {
      code: status.code,
      raw: status.value,
      scale,
      unit: normalizedUnit(values?.unit ?? spec?.lang_config?.unit),
      value: converted,
      type: spec?.type ?? null,
      label: spec?.name ?? null,
    };
  });
}

export function buildDewinSnapshot({ device, statuses, specification, updatedAt }) {
  const datapoints = parseTuyaDatapoints(statuses, specification);
  const byCode = new Map(datapoints.map((datapoint) => [datapoint.code, datapoint]));
  const snapshot = {
    available: true,
    online: Boolean(device?.online),
    deviceId: device?.id ?? null,
    name: device?.name ?? null,
    category: device?.category ?? specification?.category ?? null,
    ambientTemperature: null,
    ambientHumidity: null,
    batteryState: null,
    externalProbeTemperature: null,
    temperatureCalibration: null,
    humidityCalibration: null,
    temperatureCorrection: null,
    datapoints,
    updatedAt,
    stale: false,
  };
  for (const [code, field] of Object.entries(NORMALIZED_CODES)) {
    if (byCode.has(code)) snapshot[field] = structuredClone(byCode.get(code));
  }
  return snapshot;
}

function signRequest({ clientId, clientSecret, accessToken = '', requestPath, now }) {
  const timestamp = String(now());
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const stringToSign = `GET\n${EMPTY_BODY_SHA256}\n\n${requestPath}`;
  const message = `${clientId}${accessToken}${timestamp}${nonce}${stringToSign}`;
  const sign = crypto.createHmac('sha256', clientSecret).update(message).digest('hex').toUpperCase();
  return {
    client_id: clientId,
    sign,
    sign_method: 'HMAC-SHA256',
    t: timestamp,
    nonce,
    ...(accessToken ? { access_token: accessToken } : {}),
  };
}

export class TuyaCloudClient {
  constructor({ clientId, clientSecret, deviceId, baseUrl = 'https://openapi.tuyaeu.com', fetchImpl = fetch, now = () => Date.now() }) {
    if (!clientId || !clientSecret || !deviceId) throw new Error('Configurazione Tuya incompleta');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.deviceId = deviceId;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async request(requestPath, accessToken = '') {
    const response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
      method: 'GET',
      headers: signRequest({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        accessToken,
        requestPath,
        now: this.now,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error(`Tuya HTTP ${response.status}: risposta non JSON`); }
    if (!response.ok || payload.success !== true) {
      throw new Error(`Tuya HTTP ${response.status}, code=${payload.code ?? 'n/a'}, message=${payload.msg ?? 'unknown'}`);
    }
    return payload.result;
  }

  async accessToken() {
    if (this.token && this.now() < this.tokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS) return this.token;
    const result = await this.request('/v1.0/token?grant_type=1');
    if (!result?.access_token) throw new Error('Tuya non ha restituito un access token');
    this.token = result.access_token;
    this.tokenExpiresAt = this.now() + Number(result.expire_time || 0) * 1000;
    return this.token;
  }

  async readDevice() {
    const token = await this.accessToken();
    const id = encodeURIComponent(this.deviceId);
    const [device, specification, statuses] = await Promise.all([
      this.request(`/v1.0/iot-03/devices/${id}`, token),
      this.request(`/v1.2/iot-03/devices/${id}/specification`, token),
      this.request(`/v1.0/iot-03/devices/${id}/status`, token),
    ]);
    return { device, specification, statuses };
  }
}

export class DewinService {
  constructor({ client, historyStore = null, refreshIntervalMs = DEWIN_REFRESH_INTERVAL_MS, staleAfterMs = DEWIN_STALE_AFTER_MS, now = () => Date.now(), log = () => {}, logError = () => {} }) {
    this.client = client;
    this.historyStore = historyStore;
    this.refreshIntervalMs = refreshIntervalMs;
    this.staleAfterMs = staleAfterMs;
    this.now = now;
    this.log = log;
    this.logError = logError;
    this.current = {
      available: false, online: false, deviceId: client.deviceId, name: null, category: null,
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
        const result = await this.client.readDevice();
        this.current = buildDewinSnapshot({
          ...result,
          updatedAt: new Date(this.now()).toISOString(),
        });
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
        this.current = { ...this.current, stale: true };
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
  const deviceId = process.env.TUYA_DEVICE_ID?.trim();
  if (!clientId || !clientSecret || !deviceId) throw new Error('Credenziali Tuya mancanti');
  const client = new TuyaCloudClient({
    clientId,
    clientSecret,
    deviceId,
    baseUrl: process.env.TUYA_BASE_URL?.trim() || 'https://openapi.tuyaeu.com',
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  return new DewinService({ ...options, client });
}
