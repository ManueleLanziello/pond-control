const devicesElement = document.querySelector('#devices');
const statusElement = document.querySelector('#status-message');
const updateElement = document.querySelector('#last-update');

function signalQuality(rssi) {
  if (typeof rssi !== 'number') return 'Non disponibile';
  if (rssi >= -60) return 'Ottimo';
  if (rssi >= -70) return 'Buono';
  if (rssi >= -80) return 'Debole';
  return 'Molto debole';
}

function valueRow(label, value, extraClass = '') {
  const row = document.createElement('div');
  row.className = 'detail-row';
  const term = document.createElement('span');
  term.className = 'detail-label';
  term.textContent = label;
  const content = document.createElement('span');
  content.className = `detail-value ${extraClass}`.trim();
  content.textContent = value;
  row.append(term, content);
  return row;
}

function deviceCard(device) {
  const card = document.createElement('article');
  card.className = `device-card ${device.online ? '' : 'is-offline'}`.trim();

  const heading = document.createElement('div');
  heading.className = 'card-heading';
  const names = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = device.name;
  const model = document.createElement('p');
  model.className = 'model';
  model.textContent = device.model;
  names.append(title, model);

  const state = document.createElement('span');
  const stateLabel = device.online && device.state ? device.state : 'OFFLINE';
  state.className = `badge badge-${stateLabel.toLowerCase()}`;
  state.textContent = stateLabel;
  heading.append(names, state);

  const details = document.createElement('div');
  details.className = 'details';
  details.append(
    valueRow('Stato', device.online ? (device.state || 'Non leggibile') : 'Non disponibile'),
    valueRow('Connessione', device.online ? 'ONLINE' : 'OFFLINE', device.online ? 'online-text' : 'offline-text'),
    valueRow('Segnale Wi-Fi', typeof device.rssi === 'number' ? `${device.rssi} dBm · ${signalQuality(device.rssi)}` : 'Non disponibile'),
    valueRow('Protocollo', device.protocol),
    valueRow('IP', device.ip, 'mono'),
  );
  card.append(heading, details);
  return card;
}

function renderDevices(devices) {
  devicesElement.replaceChildren(...devices.map(deviceCard));
}

async function refresh() {
  try {
    const response = await fetch('/api/devices', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.devices)) throw new Error('Risposta API non valida');
    renderDevices(payload.devices);
    const offline = payload.devices.filter((device) => !device.online).length;
    statusElement.textContent = offline ? `${offline} dispositivo${offline === 1 ? '' : 'i'} offline` : 'Tutti i dispositivi sono online';
    statusElement.className = `status-message ${offline ? 'has-error' : 'is-ok'}`;
    updateElement.textContent = `Ultimo aggiornamento: ${new Date().toLocaleTimeString('it-IT')}`;
  } catch {
    statusElement.textContent = 'Aggiornamento non riuscito. I dati precedenti restano visibili.';
    statusElement.className = 'status-message has-error';
  }
}

refresh();
setInterval(refresh, 5000);
