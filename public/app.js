import { buildDashboardFunctions, plugDashboardLabel, sensorDashboardLabel } from './dashboard-model.js';
import { initCameraCard } from './camera-view.js';
import { dewinCardView, formatDewinValue } from './dewin-view.js';
import { heaterControlView, requestHeaterState } from './heater-control.js';
import { pumpControlView, requestPumpState } from './pump-control.js';
import { renderTemperatureChart } from './temperature-chart.js';
import { weatherIconForCode } from './weather-icons.js';

const devicesElement = document.querySelector('#devices');
const statusElement = document.querySelector('#status-message');
const updateElement = document.querySelector('#last-update');
const temperatureChartElement = document.querySelector('#temperature-chart-card');
const cameraCardElement = document.querySelector('#camera-card');
let latestDevices = [];
let latestWeather = null;
let latestDewin = null;
let latestDewinHistory = null;
let latestHardware = null;
let heaterCommandPending = false;
let heaterCommandMessage = '';
let pumpCommandPending = false;
let pumpCommandMessage = '';

function iconImage(source, className) {
  const image = document.createElement('img');
  image.className = className;
  image.src = source;
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  return image;
}

function valueRow(iconPath, label, value, note = '', extraClass = '') {
  const row = document.createElement('div');
  row.className = 'detail-row';
  const symbol = iconImage(iconPath, 'detail-icon');
  const term = document.createElement('span');
  term.className = 'detail-label';
  term.textContent = label;
  const valueWrap = document.createElement('span');
  valueWrap.className = 'detail-value-wrap';
  const content = document.createElement('span');
  content.className = `detail-value ${extraClass}`.trim();
  content.textContent = value;
  valueWrap.append(content);
  if (note) {
    const secondary = document.createElement('small');
    secondary.textContent = note;
    valueWrap.append(secondary);
  }
  row.append(symbol, term, valueWrap);
  return row;
}

function formatWeatherDate(value, options = { weekday: 'short', day: 'numeric' }) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('it-IT', options).format(new Date(`${value}T12:00:00`));
}

function cardMainHeader(titleText, subtitleText, icon, centerContent, endContent, subtitleClass = '') {
  const heading = document.createElement('div');
  heading.className = 'card-heading';
  const title = document.createElement('h2');
  title.className = 'card-main-title';
  title.textContent = titleText;
  const subtitle = document.createElement('p');
  subtitle.className = `card-main-subtitle ${subtitleClass}`.trim();
  subtitle.textContent = subtitleText;
  const mainRow = document.createElement('div');
  mainRow.className = 'card-main-row';
  const start = document.createElement('div');
  start.className = 'card-main-cell card-main-start';
  const center = document.createElement('div');
  center.className = 'card-main-cell card-main-center';
  const end = document.createElement('div');
  end.className = 'card-main-cell card-main-end';
  if (icon) start.append(icon);
  if (centerContent) center.append(centerContent);
  if (endContent) end.append(endContent);
  mainRow.append(start, center, end);
  heading.append(title, subtitle, mainRow);
  return heading;
}

function weatherCard(weather) {
  const card = document.createElement('article');
  card.className = `device-card weather-card role-weather ${weather?.stale ? 'is-stale' : ''}`;
  const currentIcon = weatherIconForCode(weather?.weatherCode, { key: 'weather', src: '/icons/weather.svg' });
  const weatherIcon = iconImage(currentIcon.src, 'function-icon');
  weatherIcon.dataset.weatherIcon = currentIcon.key;
  let temperature = null;
  let condition = null;
  if (weather?.available) {
    temperature = document.createElement('strong');
    temperature.className = 'primary-state weather-temperature';
    temperature.textContent = `${Math.round(weather.temperature)}°`;
    condition = document.createElement('span');
    condition.className = 'card-main-secondary weather-condition';
    condition.textContent = weather.condition;
  }
  const heading = cardMainHeader(
    'Meteo',
    weather?.location || 'Rivarolo Canavese',
    weatherIcon,
    temperature,
    condition,
    'weather-subtitle',
  );
  card.append(heading);

  if (!weather?.available) {
    const unavailable = document.createElement('p');
    unavailable.className = 'empty-assignment';
    unavailable.textContent = 'DATI METEO NON ANCORA DISPONIBILI';
    card.append(unavailable);
    return card;
  }

  const overview = document.createElement('div');
  overview.className = 'weather-overview';
  overview.append(
    valueRow('/icons/termos.svg', 'Temperature', `${Math.round(weather.min)}° / ${Math.round(weather.max)}°`, formatWeatherDate(weather.date, { weekday: 'long', day: 'numeric', month: 'short' })),
    valueRow('/icons/rain.svg', 'Pioggia', `${Math.round(weather.rainProbability)}%`),
    valueRow('/icons/wind.svg', 'Vento', `${Math.round(weather.windSpeed)} km/h`),
  );
  const forecast = document.createElement('div');
  forecast.className = 'weather-forecast';
  for (const day of weather.forecast || []) {
    const item = document.createElement('div');
    item.className = 'forecast-item';
    const dayName = document.createElement('strong');
    dayName.textContent = formatWeatherDate(day.date);
    const forecastIconData = weatherIconForCode(day.weatherCode);
    const forecastIcon = iconImage(forecastIconData.src, 'forecast-icon');
    forecastIcon.dataset.weatherIcon = forecastIconData.key;
    const dayCondition = document.createElement('span');
    dayCondition.textContent = day.condition;
    const temperatures = document.createElement('b');
    temperatures.textContent = `${Math.round(day.min)}° / ${Math.round(day.max)}°`;
    item.append(dayName, forecastIcon, dayCondition, temperatures);
    forecast.append(item);
  }
  card.append(overview, forecast);
  return card;
}

function pondTemperatureCard(dewin) {
  const view = dewinCardView(dewin);
  const card = document.createElement('article');
  card.className = `device-card pond-temperature-card role-temperature ${view.stale ? 'is-stale' : ''}`.trim();
  const temperatureIcon = iconImage('/icons/thermometer.svg', 'function-icon');
  const value = document.createElement('strong');
  value.className = 'primary-state pond-temperature-value';
  value.textContent = view.pondTemperature.replace(/\s*°C$/, '');
  const unit = document.createElement('span');
  unit.className = 'pond-temperature-unit';
  unit.textContent = '°C';
  const sensorSubtitle = sensorDashboardLabel('pond_temperature', latestHardware, dewin?.name || 'Sonda DEWIN');
  const heading = cardMainHeader('Temperatura Acqua', sensorSubtitle, temperatureIcon, value, unit, 'temperature-subtitle');
  card.append(heading);

  if (!view.available) {
    const placeholder = document.createElement('div');
    placeholder.className = 'pond-temperature-placeholder';
    const placeholderTitle = document.createElement('strong');
    placeholderTitle.textContent = 'Monitoraggio acqua';
    const placeholderText = document.createElement('span');
    placeholderText.textContent = 'In attesa dei dati Dewin';
    placeholder.append(placeholderTitle, placeholderText);
    card.append(placeholder);
    return card;
  }

  const details = document.createElement('div');
  details.className = 'details dewin-details';
  details.append(
    valueRow('/icons/wifi.svg', 'Connessione', view.online ? 'ONLINE' : 'OFFLINE', '', view.online ? 'online-text' : 'offline-text'),
    valueRow('/icons/termos.svg', 'Ambiente', view.ambientTemperature),
    valueRow('/icons/umidity.svg', 'Umidità', view.ambientHumidity),
    valueRow('/icons/battery.svg', 'Batteria', view.battery),
    valueRow('/icons/update.svg', 'Aggiornato', view.updatedAt
      ? new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(view.updatedAt))
      : '—'),
  );
  card.append(details);

  if (view.optional.length) {
    const optional = document.createElement('details');
    optional.className = 'dewin-optional';
    const summary = document.createElement('summary');
    summary.textContent = 'Calibrazione sensore';
    const rows = document.createElement('div');
    rows.className = 'dewin-optional-rows';
    for (const [label, datapoint] of view.optional) {
      const row = document.createElement('span');
      row.textContent = `${label}: ${formatDewinValue(datapoint)}`;
      rows.append(row);
    }
    optional.append(summary, rows);
    card.append(optional);
  }
  return card;
}

function functionCard(pondFunction, pumpFunction) {
  const { device } = pondFunction;
  const functionTitle = pondFunction.role === 'pump' ? 'Pompa Filtro' : 'Riscaldatore';
  const card = document.createElement('article');
  card.className = `device-card function-card role-${pondFunction.role} ${device && !device.online ? 'is-offline' : ''} ${device ? '' : 'is-unassigned'}`.trim();

  const functionIcon = iconImage(`/icons/${pondFunction.role}.svg`, 'function-icon');
  const stateLabel = device ? (device.online && device.state ? device.state : 'OFFLINE') : 'NON ASSEGNATA';
  const stateClass = device ? stateLabel.toLowerCase() : 'unassigned';
  const primaryState = document.createElement('strong');
  primaryState.className = `primary-state state-${stateClass}`;
  primaryState.textContent = stateLabel;
  const controlView = pondFunction.role === 'pump'
    ? pumpControlView(pondFunction, pumpCommandPending)
    : heaterControlView(pondFunction, pumpFunction, heaterCommandPending);
  const button = document.createElement('button');
  button.className = `heater-control-button function-control-button header-control-button action-${(controlView.requestedState || '').toLowerCase()}`;
  button.type = 'button';
  button.disabled = controlView.disabled;
  button.setAttribute('aria-label', controlView.actionLabel);
  button.title = controlView.actionLabel;
  const controlIconSource = controlView.requestedState === 'ON'
    ? '/icons/poweron.svg'
    : controlView.requestedState === 'OFF'
      ? '/icons/poweroff.svg'
      : null;
  if (controlIconSource) button.append(iconImage(controlIconSource, 'control-icon'));
  if (controlView.requestedState) {
    button.addEventListener('click', () => (
      pondFunction.role === 'pump'
        ? commandPump(device, controlView.requestedState)
        : commandHeater(device, controlView.requestedState)
    ));
  }
  const heading = cardMainHeader(
    functionTitle,
    plugDashboardLabel(device, latestHardware),
    functionIcon,
    primaryState,
    button,
    `${pondFunction.role}-subtitle`,
  );

  if (!device) {
    const empty = document.createElement('p');
    empty.className = 'empty-assignment';
    empty.textContent = 'NESSUNA PRESA ASSEGNATA';
    card.append(heading, empty);
    return card;
  }

  const details = document.createElement('div');
  details.className = 'details';
  details.append(
    valueRow('/icons/wifi.svg', 'Connessione', device.online ? 'ONLINE' : 'OFFLINE', '', device.online ? 'online-text' : 'offline-text'),
  );
  card.append(heading, details);

  if (pondFunction.role === 'pump') {
    if (pumpCommandMessage) {
      const message = document.createElement('p');
      message.className = 'heater-control-message';
      message.textContent = pumpCommandMessage;
      card.append(message);
    }
  }

  if (pondFunction.role === 'heater') {
    if (controlView.safetyMessage) {
      const safety = document.createElement('p');
      safety.className = 'heater-safety-message';
      safety.textContent = controlView.safetyMessage;
      card.append(safety);
    }
    if (heaterCommandMessage) {
      const message = document.createElement('p');
      message.className = 'heater-control-message';
      message.textContent = heaterCommandMessage;
      card.append(message);
    }
  }
  return card;
}

function thermostatCard() {
  const card = document.createElement('article');
  card.className = 'device-card thermostat-card role-thermostat';
  const icon = iconImage('/icons/termotime.svg', 'function-icon');
  const status = document.createElement('span');
  status.className = 'thermostat-card-status';
  status.textContent = 'Automazione non configurata';
  const heading = cardMainHeader('Termostato', 'Controllo clima', icon, status, null, 'thermostat-subtitle');
  card.append(heading);
  return card;
}

function renderDevices(devices) {
  const functions = buildDashboardFunctions(devices);
  const pumpFunction = functions.find((item) => item.role === 'pump');
  devicesElement.replaceChildren(
    weatherCard(latestWeather),
    pondTemperatureCard(latestDewin),
    ...functions.map((item) => functionCard(item, pumpFunction)),
    thermostatCard(),
  );
}

async function commandHeater(device, requestedState) {
  if (heaterCommandPending || !device?.online) return;
  heaterCommandPending = true;
  heaterCommandMessage = '';
  renderDevices(latestDevices);
  try {
    const result = await requestHeaterState(fetch, requestedState);
    latestDevices = latestDevices.map((item) => (
      item.id === result.deviceId ? { ...item, state: result.state, online: true } : item
    ));
    heaterCommandMessage = `Stato verificato: ${result.state}`;
  } catch {
    heaterCommandMessage = 'Comando riscaldatore non riuscito';
  } finally {
    heaterCommandPending = false;
    renderDevices(latestDevices);
  }
}

async function commandPump(device, requestedState) {
  if (pumpCommandPending || !device?.online) return;
  pumpCommandPending = true;
  pumpCommandMessage = '';
  renderDevices(latestDevices);
  try {
    const result = await requestPumpState(fetch, requestedState);
    latestDevices = latestDevices.map((item) => {
      if (item.id === result.deviceId) return { ...item, state: result.state, online: true };
      if (requestedState === 'OFF' && item.role === 'heater') return { ...item, state: 'OFF' };
      return item;
    });
    pumpCommandMessage = `Stato verificato: ${result.state}`;
  } catch (commandError) {
    pumpCommandMessage = commandError.message || 'Comando pompa non riuscito';
  } finally {
    pumpCommandPending = false;
    renderDevices(latestDevices);
  }
}

async function refresh() {
  try {
    const weatherRequest = fetch('/api/weather', { cache: 'no-store' })
      .then(async (response) => (response.ok ? response.json() : null))
      .catch(() => null);
    const dewinRequest = fetch('/api/dewin', { cache: 'no-store' })
      .then(async (response) => (response.ok ? response.json() : null))
      .catch(() => null);
    const dewinHistoryRequest = fetch('/api/dewin/history', { cache: 'no-store' })
      .then(async (response) => (response.ok ? response.json() : null))
      .catch(() => null);
    const hardwareRequest = fetch('/api/hardware', { cache: 'no-store' })
      .then(async (hardwareResponse) => (hardwareResponse.ok ? hardwareResponse.json() : null))
      .catch(() => null);
    const response = await fetch('/api/devices', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.devices)) throw new Error('Risposta API non valida');
    latestDevices = payload.devices;
    const weather = await weatherRequest;
    if (weather) latestWeather = weather;
    const dewin = await dewinRequest;
    if (dewin) latestDewin = dewin;
    const dewinHistory = await dewinHistoryRequest;
    if (dewinHistory) latestDewinHistory = dewinHistory;
    const hardware = await hardwareRequest;
    if (hardware) latestHardware = hardware;
    renderTemperatureChart(temperatureChartElement, latestDewinHistory, latestDewin);
    renderDevices(latestDevices);
    const functions = buildDashboardFunctions(payload.devices);
    const unassigned = functions.filter((item) => !item.device).length;
    const offline = functions.filter((item) => item.device && !item.device.online).length;
    statusElement.textContent = unassigned
      ? `${unassigned} funzion${unassigned === 1 ? 'e' : 'i'} senza presa assegnata`
      : offline
        ? `${offline} funzion${offline === 1 ? 'e' : 'i'} offline`
        : 'Tutte le funzioni sono online';
    statusElement.className = `status-message ${unassigned || offline ? 'has-error' : 'is-ok'}`;
    updateElement.textContent = `Ultimo aggiornamento: ${new Date().toLocaleTimeString('it-IT')}`;
  } catch {
    statusElement.textContent = 'Aggiornamento non riuscito. I dati precedenti restano visibili.';
    statusElement.className = 'status-message has-error';
  }
}

refresh();
setInterval(refresh, 5000);
initCameraCard(cameraCardElement);
