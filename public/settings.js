const devicesElement = document.querySelector('#role-devices');
const statusElement = document.querySelector('#settings-status');

const ROLE_LABELS = Object.freeze({
  pump: 'Pompa',
  heater: 'Riscaldatore',
  none: 'Nessun ruolo',
});

let devices = [];

async function updateRole(deviceId, role) {
  const selects = [...document.querySelectorAll('.role-select')];
  selects.forEach((select) => { select.disabled = true; });
  statusElement.textContent = 'Salvataggio…';
  statusElement.className = 'status-message';
  try {
    const response = await fetch(`/api/device-roles/${encodeURIComponent(deviceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.assignments) throw new Error(payload.error || `HTTP ${response.status}`);
    devices = devices.map((device) => ({
      ...device,
      role: payload.assignments[device.id] || 'none',
    }));
    renderDevices();
    statusElement.textContent = 'Configurazione salvata';
    statusElement.className = 'status-message is-ok';
  } catch {
    renderDevices();
    statusElement.textContent = 'Salvataggio non riuscito. La configurazione precedente è invariata.';
    statusElement.className = 'status-message has-error';
  }
}

function roleCard(device) {
  const card = document.createElement('article');
  card.className = 'device-card settings-card';

  const identity = document.createElement('div');
  identity.className = 'physical-device';
  const deviceIcon = document.createElement('img');
  deviceIcon.className = 'physical-device-icon';
  deviceIcon.src = `/icons/${device.model.toLowerCase()}.svg`;
  deviceIcon.alt = '';
  deviceIcon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('h3');
  title.textContent = `Presa ${device.model}`;
  identity.append(deviceIcon, title);
  const select = document.createElement('select');
  select.className = 'role-select';
  select.setAttribute('aria-label', `Ruolo per presa ${device.model}`);
  for (const [value, text] of Object.entries(ROLE_LABELS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    option.selected = device.role === value;
    select.append(option);
  }
  select.addEventListener('change', () => updateRole(device.id, select.value));

  const assignment = document.createElement('div');
  assignment.className = 'role-assignment';
  assignment.append(select);

  card.append(identity, assignment);
  return card;
}

function renderDevices() {
  devicesElement.replaceChildren(...devices.map(roleCard));
}

async function loadSettings() {
  try {
    const response = await fetch('/api/devices', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.devices)) throw new Error('Risposta API non valida');
    devices = payload.devices;
    renderDevices();
    statusElement.textContent = 'Configurazione pronta';
    statusElement.className = 'status-message is-ok';
  } catch {
    statusElement.textContent = 'Impossibile caricare dispositivi e ruoli.';
    statusElement.className = 'status-message has-error';
  }
}

loadSettings();
