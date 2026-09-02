const statusElement = document.querySelector('#settings-status');
const dialog = document.querySelector('#hardware-dialog');
const form = document.querySelector('#hardware-form');
const formStatus = document.querySelector('#hardware-form-status');
const saveButton = document.querySelector('#hardware-save');
const CONTAINERS = Object.freeze({
  plugs: document.querySelector('#plug-devices'),
  sensors: document.querySelector('#sensor-devices'),
  cameras: document.querySelector('#camera-devices'),
});
const EMPTY_LABELS = Object.freeze({ plugs: 'Nessuna presa configurata', sensors: 'Nessun sensore configurato', cameras: 'Nessuna telecamera configurata' });
const KIND_LABELS = Object.freeze({ plugs: 'PRESA', sensors: 'SENSORE', cameras: 'TELECAMERA' });
const ROLE_LABELS = Object.freeze({
  none: 'Nessun ruolo', pump: 'Pompa Filtro', heater: 'Riscaldatore',
  pond_temperature: 'Temperatura Acqua', pond_camera: 'Telecamera Pond',
});
let hardware = { plugs: [], sensors: [], cameras: [], roles: {} };
let adding = false;
let formVerified = false;
let editingDevice = null;

function textRow(label, value, className = '') {
  const row = document.createElement('div');
  row.className = 'hardware-detail-row';
  const key = document.createElement('span'); key.textContent = label;
  const content = document.createElement('strong'); content.className = className; content.textContent = value || 'Non disponibile';
  row.append(key, content);
  return row;
}

function roleOptions(kind, selected, { runtimeActive = true } = {}) {
  const fragment = document.createDocumentFragment();
  const availableRoles = !runtimeActive
    ? (selected === 'none' ? ['none'] : [selected, 'none'])
    : hardware.roles[kind] || ['none'];
  for (const role of availableRoles) {
    const option = document.createElement('option');
    option.value = role; option.textContent = ROLE_LABELS[role] || role; option.selected = role === selected;
    fragment.append(option);
  }
  return fragment;
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function updateRole(kind, device, role) {
  await request(`/api/hardware/${kind}/${encodeURIComponent(device.id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }),
  });
  await loadHardware('Ruolo aggiornato');
}

function actionButton(label, action, className = '') {
  const button = document.createElement('button');
  button.type = 'button'; button.className = `settings-action-button ${className}`.trim(); button.textContent = label;
  button.addEventListener('click', () => Promise.resolve(action()).catch(showError));
  return button;
}

function hardwareCard(kind, device) {
  const card = document.createElement('article'); card.className = 'device-card settings-card hardware-card';
  const heading = document.createElement('div'); heading.className = 'hardware-card-heading';
  const identity = document.createElement('div');
  const alias = document.createElement('h3'); alias.textContent = device.alias;
  const model = document.createElement('p');
  model.textContent = kind === 'sensors'
    ? `${device.type}${device.provider ? ` · ${device.provider}` : ''}`
    : device.model;
  identity.append(alias, model);
  heading.append(identity);
  const verification = document.createElement('span'); verification.className = `hardware-badge is-${device.verificationStatus}`;
  verification.textContent = device.verificationStatus === 'verified' ? 'VERIFICATA' : 'DA VERIFICARE';
  heading.append(verification);
  const role = document.createElement('select'); role.className = 'role-select'; role.setAttribute('aria-label', `Ruolo per ${device.alias}`);
  role.append(roleOptions(kind, device.role || 'none', device));
  role.addEventListener('change', () => updateRole(kind, device, role.value).catch(showError));
  const details = document.createElement('div'); details.className = 'hardware-details';
  const statusRow = textRow('Stato', device.online ? 'ONLINE' : 'OFFLINE', device.online ? 'online-text' : 'offline-text');
  const connectionRows = kind === 'sensors' && device.connectionType === 'cloud'
    ? [textRow('Connessione', 'CLOUD'), statusRow]
    : [
      textRow('IP', device.ip, 'mono'), textRow('MAC', device.mac || 'Non configurato', 'mono'),
      textRow('Protocollo', device.protocol), statusRow,
      textRow('RSSI', typeof device.rssi === 'number' ? `${device.rssi} dBm` : 'Non disponibile'),
    ];
  details.append(...connectionRows,
    textRow('Configurazione', device.configurationStatus === 'complete' ? 'COMPLETA' : 'INCOMPLETA'),
    ...(kind === 'plugs' ? [textRow('Runtime', device.runtimeActive ? 'OPERATIVA' : 'NON ATTIVA')] : []));
  const actions = document.createElement('div'); actions.className = 'settings-card-actions';
  actions.append(actionButton('Modifica', () => openForm(kind, device)));
  actions.append(actionButton('Verifica', () => verifySaved(kind, device)));
  actions.append(actionButton('Rimuovi', () => removeDevice(kind, device), 'is-danger'));
  card.append(heading, role, details, actions);
  return card;
}

function renderKind(kind) {
  const records = hardware[kind] || [];
  if (records.length) return CONTAINERS[kind].replaceChildren(...records.map((device) => hardwareCard(kind, device)));
  const card = document.createElement('article'); card.className = 'device-card settings-card';
  const empty = document.createElement('p'); empty.className = 'empty-assignment'; empty.textContent = EMPTY_LABELS[kind];
  card.append(empty); CONTAINERS[kind].replaceChildren(card);
}

function renderHardware() { Object.keys(CONTAINERS).forEach(renderKind); }
function showError(error) { statusElement.textContent = error.message || 'Operazione non riuscita.'; statusElement.className = 'status-message has-error'; }

async function loadHardware(message = 'Configurazione pronta') {
  hardware = await request('/api/hardware', { cache: 'no-store' }); renderHardware();
  statusElement.textContent = message; statusElement.className = 'status-message is-ok';
}

function formPayload() {
  const kind = document.querySelector('#hardware-kind').value;
  const modelOrType = document.querySelector('#hardware-model').value.trim();
  const common = {
    alias: document.querySelector('#hardware-alias').value.trim(),
    model: modelOrType,
    ip: document.querySelector('#hardware-ip').value.trim(), mac: document.querySelector('#hardware-mac').value.trim(),
    role: document.querySelector('#hardware-role').value,
  };
  return kind === 'sensors' ? { ...common, tuyaDeviceId: document.querySelector('#hardware-tuya-id').value.trim() } : common;
}

function updateConnectionFields() {
  const kind = document.querySelector('#hardware-kind').value;
  const sensor = kind === 'sensors';
  document.querySelector('#hardware-model-select-field').hidden = false;
  document.querySelector('#hardware-model-text-field').hidden = true;
  document.querySelector('#hardware-model').required = true;
  document.querySelector('#hardware-model-text').required = false;
  document.querySelector('#hardware-connection-field').hidden = true;
  document.querySelector('#hardware-provider-field').hidden = true;
  document.querySelector('#hardware-ip-field').hidden = sensor;
  document.querySelector('#hardware-mac-field').hidden = sensor;
  document.querySelector('#hardware-tuya-id-field').hidden = !sensor;
  document.querySelector('#hardware-tuya-id').required = sensor;
  document.querySelector('#hardware-ip').required = !sensor;
  document.querySelector('#hardware-mac').required = !sensor;
  document.querySelector('#hardware-verify').hidden = false;
}

function populateModelOptions(kind, device) {
  const field = document.querySelector('#hardware-model');
  const catalog = { plugs: 'supportedPlugModels', sensors: 'supportedSensorModels', cameras: 'supportedCameraModels' }[kind];
  const values = (hardware[catalog] || []).map(({ model }) => model);
  field.replaceChildren(...[...new Set(values.filter(Boolean))].map((value) => {
    const option = document.createElement('option'); option.value = value; option.textContent = value; return option;
  }));
}

function openForm(kind, device = null) {
  adding = !device; editingDevice = device; formVerified = false; form.reset();
  document.querySelector('#hardware-kind').value = kind; document.querySelector('#hardware-id').value = device?.id || '';
  document.querySelector('#hardware-form-kind').textContent = KIND_LABELS[kind];
  document.querySelector('#hardware-form-title').textContent = device ? `Modifica ${device.alias}` : `Aggiungi ${KIND_LABELS[kind].toLowerCase()}`;
  document.querySelector('#hardware-alias').value = device?.alias || '';
  populateModelOptions(kind, device);
  document.querySelector('#hardware-model').value = device?.model || '';
  document.querySelector('#hardware-model-text').value = kind === 'sensors' ? device?.type || device?.model || '' : device?.model || '';
  document.querySelector('#hardware-ip').value = device?.ip || ''; document.querySelector('#hardware-mac').value = device?.mac || '';
  document.querySelector('#hardware-tuya-id').value = device?.tuyaDeviceId || '';
  document.querySelector('#hardware-connection').value = device?.connectionType || 'lan';
  document.querySelector('#hardware-provider').value = device?.provider || (kind === 'sensors' ? device?.protocol || '' : '');
  updateConnectionFields();
  const role = document.querySelector('#hardware-role');
  role.replaceChildren(roleOptions(kind, device?.role || 'none', { runtimeActive: Boolean(device?.runtimeActive) }));
  formStatus.className = 'status-message';
  formStatus.textContent = kind === 'plugs' && !device?.runtimeActive
      ? 'Salvare la presa e completare la verifica read-only prima di assegnare un ruolo operativo.'
      : '';
  saveButton.disabled = false; dialog.showModal();
}

async function verifyForm() {
  const kind = document.querySelector('#hardware-kind').value;
  formStatus.textContent = 'Verifica read-only in corso…';
  try {
    const result = await request(`/api/hardware/${kind}/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formPayload()),
    });
    formVerified = result.verified; saveButton.disabled = !formVerified;
    formStatus.textContent = `Verifica riuscita: ${result.detected.model}`; formStatus.className = 'status-message is-ok';
  } catch (error) {
    formVerified = false; saveButton.disabled = adding; formStatus.textContent = error.message; formStatus.className = 'status-message has-error';
  }
}

async function saveForm(event) {
  event.preventDefault();
  const kind = document.querySelector('#hardware-kind').value; const id = document.querySelector('#hardware-id').value;
  await request(id ? `/api/hardware/${kind}/${encodeURIComponent(id)}` : `/api/hardware/${kind}`, {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formPayload()),
  });
  dialog.close(); await loadHardware('Configurazione salvata');
}

async function verifySaved(kind, device) {
  await request(`/api/hardware/${kind}/${encodeURIComponent(device.id)}/verify`, { method: 'POST' });
  await loadHardware('Dispositivo verificato in sola lettura');
}

async function removeDevice(kind, device) {
  if (!window.confirm(`Rimuovere ${device.alias}?`)) return;
  await request(`/api/hardware/${kind}/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
  await loadHardware('Dispositivo rimosso dalla configurazione');
}

document.querySelectorAll('[data-add-kind]').forEach((button) => button.addEventListener('click', () => openForm(button.dataset.addKind)));
document.querySelector('[data-close-dialog]').addEventListener('click', () => dialog.close());
document.querySelector('#hardware-verify').addEventListener('click', verifyForm);
document.querySelector('#hardware-connection').addEventListener('change', updateConnectionFields);
form.addEventListener('input', () => {
  formVerified = false;
});
form.addEventListener('submit', (event) => saveForm(event).catch((error) => {
  event.preventDefault(); formStatus.textContent = error.message; formStatus.className = 'status-message has-error';
}));
loadHardware().catch(showError);
