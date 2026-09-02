const FRAME_REFRESH_MS = 400;
const LIVE_STATUS_REFRESH_MS = 5000;

export function formatCameraTimestamp(value) {
  if (!value) return 'Nessuna immagine disponibile';
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value));
}

export function initCameraCard(container, fetchImpl = fetch) {
  if (!container) return null;
  const image = container.querySelector('#camera-image');
  const status = container.querySelector('#camera-status');
  const updatedAt = container.querySelector('#camera-updated-at');
  const button = container.querySelector('#camera-live-toggle');
  const buttonState = container.querySelector('#camera-live-state');
  const identity = container.querySelector('#camera-identity');
  let live = false;
  let pending = false;
  let frameTimer = null;
  let statusTimer = null;

  function stopLocalRefresh() {
    clearInterval(frameTimer);
    clearInterval(statusTimer);
    frameTimer = null;
    statusTimer = null;
  }

  function refreshFrame(version = Date.now()) {
    image.src = `/api/camera/image?v=${version}`;
  }

  function applyState(camera) {
    identity.textContent = camera.alias
      ? [camera.alias, camera.model].filter(Boolean).join(' · ')
      : 'Nessuna telecamera assegnata';
    live = Boolean(camera.live);
    container.classList.toggle('is-live', live);
    status.textContent = camera.status === 'LIVE'
      ? 'LIVE'
      : camera.status === 'READY'
        ? 'PRONTA'
        : camera.status === 'NOT_CONFIGURED'
          ? 'NON CONFIGURATA'
          : camera.status === 'ERROR'
            ? `ERRORE${camera.errorCode ? ` · ${camera.errorCode}` : ''}`
            : 'AVVIO…';
    updatedAt.textContent = camera.status === 'ERROR' && camera.error
      ? camera.error
      : `Ultima immagine: ${formatCameraTimestamp(camera.updatedAt)}`;
    button.disabled = pending || !camera.configured;
    button.setAttribute('aria-pressed', String(live));
    buttonState.textContent = live ? 'ON' : 'OFF';
    if (camera.imageAvailable) refreshFrame(camera.imageVersion || Date.now());
    else { image.removeAttribute('src'); container.classList.add('image-unavailable'); }

    stopLocalRefresh();
    if (live) {
      frameTimer = setInterval(() => refreshFrame(), FRAME_REFRESH_MS);
      statusTimer = setInterval(() => void refreshStatus(), LIVE_STATUS_REFRESH_MS);
    }
  }

  async function refreshStatus() {
    try {
      const response = await fetchImpl('/api/camera/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      applyState(await response.json());
    } catch {
      stopLocalRefresh();
      live = false;
      status.textContent = 'NON RAGGIUNGIBILE';
      buttonState.textContent = 'OFF';
      button.setAttribute('aria-pressed', 'false');
    }
  }

  async function toggleLive() {
    if (pending) return;
    pending = true;
    button.disabled = true;
    try {
      const response = await fetchImpl('/api/camera/live', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !live }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Comando telecamera non riuscito');
      applyState(result);
    } catch (toggleError) {
      status.textContent = toggleError.message || 'ERRORE';
    } finally {
      pending = false;
      button.disabled = false;
      await refreshStatus();
    }
  }

  button.addEventListener('click', toggleLive);
  window.addEventListener('pagehide', () => {
    stopLocalRefresh();
    if (!live) return;
    void fetchImpl('/api/camera/live', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
      keepalive: true,
    });
  });
  image.addEventListener('error', () => container.classList.add('image-unavailable'));
  image.addEventListener('load', () => container.classList.remove('image-unavailable'));
  void refreshStatus();
  return { refreshStatus, toggleLive, stopLocalRefresh };
}
