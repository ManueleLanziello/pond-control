const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIME_ZONE = 'Europe/Rome';

function coordinate(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > (name === 'latitude' ? 90 : 180)) throw new Error(`Coordinata ${name} non valida.`);
  return parsed;
}

function minuteOfLocalTime(value) {
  const match = /T(\d{2}):(\d{2})$/.exec(String(value));
  if (!match) throw new Error('Orario Open-Meteo non valido.');
  return Number(match[1]) * 60 + Number(match[2]);
}

export function parseOutdoorTemperature(payload, updatedAt = new Date().toISOString()) {
  const times = payload?.hourly?.time;
  const temperatures = payload?.hourly?.temperature_2m;
  if (!Array.isArray(times) || !Array.isArray(temperatures) || times.length !== temperatures.length) throw new Error('Risposta Open-Meteo oraria incompleta.');
  const samples = times.map((time, index) => {
    const temperature = temperatures[index];
    if (typeof temperature !== 'number' || !Number.isFinite(temperature)) throw new Error('Temperatura Open-Meteo non valida.');
    return { timestamp: time, minute: minuteOfLocalTime(time), temperature };
  });
  if (!samples.length) throw new Error('Nessuna temperatura oraria Open-Meteo disponibile.');
  return { available: true, stale: false, updatedAt, samples };
}

export class OutdoorTemperatureService {
  constructor({ latitude, longitude, fetchImpl = fetch, now = () => Date.now(), cacheMs = 60 * 60_000, timeoutMs = 5000, logError = () => {} }) {
    this.latitude = latitude; this.longitude = longitude; this.fetchImpl = fetchImpl; this.now = now;
    this.cacheMs = cacheMs; this.timeoutMs = timeoutMs; this.logError = logError;
    this.current = { available: false, stale: true, updatedAt: null, samples: [] };
    this.refreshPromise = null;
  }

  url() {
    const url = new URL(FORECAST_URL);
    url.searchParams.set('latitude', String(coordinate(this.latitude, 'latitude')));
    url.searchParams.set('longitude', String(coordinate(this.longitude, 'longitude')));
    url.searchParams.set('hourly', 'temperature_2m');
    url.searchParams.set('timezone', TIME_ZONE);
    url.searchParams.set('forecast_days', '1');
    return url;
  }

  snapshot() { return structuredClone(this.current); }

  async today() {
    const updatedMs = this.current.updatedAt ? Date.parse(this.current.updatedAt) : 0;
    if (this.current.available && this.now() - updatedMs < this.cacheMs) return this.snapshot();
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.url(), { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
        this.current = parseOutdoorTemperature(await response.json(), new Date(this.now()).toISOString());
      } catch (requestError) {
        this.current = { available: false, stale: true, updatedAt: this.current.updatedAt, samples: [] };
        this.logError(`[METEO] temperatura ambiente non disponibile: ${requestError.message}`);
      } finally {
        clearTimeout(timer);
        this.refreshPromise = null;
      }
      return this.snapshot();
    })();
    return this.refreshPromise;
  }
}
