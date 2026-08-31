const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const CONDITIONS = new Map([
  [0, 'Sereno'], [1, 'Prevalentemente sereno'], [2, 'Parzialmente nuvoloso'], [3, 'Coperto'],
  [45, 'Nebbia'], [48, 'Nebbia con brina'], [51, 'Pioviggine debole'], [53, 'Pioviggine'],
  [55, 'Pioviggine intensa'], [56, 'Pioviggine gelata'], [57, 'Pioviggine gelata intensa'],
  [61, 'Pioggia debole'], [63, 'Pioggia'], [65, 'Pioggia intensa'], [66, 'Pioggia gelata'],
  [67, 'Pioggia gelata intensa'], [71, 'Neve debole'], [73, 'Neve'], [75, 'Neve intensa'],
  [77, 'Nevischio'], [80, 'Rovesci deboli'], [81, 'Rovesci'], [82, 'Rovesci intensi'],
  [85, 'Rovesci di neve'], [86, 'Rovesci di neve intensi'], [95, 'Temporale'],
  [96, 'Temporale con grandine'], [99, 'Temporale intenso con grandine'],
]);

export function weatherCondition(code) {
  return CONDITIONS.get(Number(code)) || 'Condizioni non disponibili';
}

function number(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Dato meteo non valido: ${field}`);
  return value;
}

export function parseOpenMeteo(payload, config, updatedAt = new Date().toISOString()) {
  if (!payload?.current || !payload?.daily || !Array.isArray(payload.daily.time)) {
    throw new Error('Risposta Open-Meteo incompleta');
  }
  const daily = payload.daily;
  const forecast = daily.time.slice(0, 3).map((date, index) => ({
    date,
    weatherCode: number(daily.weather_code?.[index], `daily.weather_code[${index}]`),
    condition: weatherCondition(daily.weather_code[index]),
    min: number(daily.temperature_2m_min?.[index], `daily.temperature_2m_min[${index}]`),
    max: number(daily.temperature_2m_max?.[index], `daily.temperature_2m_max[${index}]`),
    rainProbability: number(daily.precipitation_probability_max?.[index], `daily.precipitation_probability_max[${index}]`),
  }));
  if (forecast.length !== 3) throw new Error('Previsione Open-Meteo insufficiente');
  return {
    location: config.locationName,
    date: daily.time[0],
    temperature: number(payload.current.temperature_2m, 'current.temperature_2m'),
    condition: weatherCondition(payload.current.weather_code),
    weatherCode: number(payload.current.weather_code, 'current.weather_code'),
    min: forecast[0].min,
    max: forecast[0].max,
    rainProbability: forecast[0].rainProbability,
    windSpeed: number(payload.current.wind_speed_10m, 'current.wind_speed_10m'),
    updatedAt,
    stale: false,
    available: true,
    forecast,
  };
}

export class WeatherService {
  constructor({ config, fetchImpl = fetch, now = () => Date.now(), log = () => {}, logError = () => {} }) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this.logError = logError;
    this.current = { location: config.locationName, available: false, stale: true, updatedAt: null, forecast: [] };
    this.refreshPromise = null;
    this.timer = null;
    this.errorActive = false;
    this.loaded = false;
  }

  url() {
    const url = new URL(FORECAST_URL);
    url.searchParams.set('latitude', String(this.config.latitude));
    url.searchParams.set('longitude', String(this.config.longitude));
    url.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m');
    url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    url.searchParams.set('timezone', this.config.timezone);
    url.searchParams.set('forecast_days', '3');
    return url;
  }

  snapshot() {
    const updatedMs = this.current.updatedAt ? Date.parse(this.current.updatedAt) : 0;
    const expired = !updatedMs || this.now() - updatedMs > this.config.staleAfterMs;
    return structuredClone({ ...this.current, stale: this.current.stale || expired });
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const response = await this.fetchImpl(this.url(), { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
        this.current = parseOpenMeteo(await response.json(), this.config, new Date(this.now()).toISOString());
        if (!this.loaded) this.log(`[METEO] ${this.config.locationName} - dati disponibili`);
        else if (this.errorActive) this.log('[METEO] collegamento ripristinato');
        this.loaded = true;
        this.errorActive = false;
      } catch (refreshError) {
        this.current = { ...this.current, stale: true };
        if (!this.errorActive) this.logError(`[METEO] aggiornamento non riuscito: ${refreshError.message}`);
        this.errorActive = true;
      } finally {
        this.refreshPromise = null;
      }
      return this.snapshot();
    })();
    return this.refreshPromise;
  }

  async start() {
    await this.refresh();
    if (!this.timer) this.timer = setInterval(() => void this.refresh(), this.config.refreshIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
