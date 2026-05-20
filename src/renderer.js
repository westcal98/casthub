'use strict';
const api = window.castHub;

// ── State ──────────────────────────────────────────────────────────
let queue      = [];    // { id, path, name, size }
let devices    = [];    // { name, host }
let castState  = null;
let activeIdx  = -1;
let seekDragging = false;

// ── Elements ───────────────────────────────────────────────────────
const queueList       = document.getElementById('queue-list');
const queueEmpty      = document.getElementById('queue-empty');
const deviceSelect    = document.getElementById('device-select');
const castBadge       = document.getElementById('cast-badge');
const castBadgeLabel  = document.getElementById('cast-badge-label');
const dropzone        = document.getElementById('dropzone');
const nowPlaying      = document.getElementById('now-playing');
const controlsBar     = document.getElementById('controls-bar');
const npTitle         = document.getElementById('np-title');
const npDevice        = document.getElementById('np-device');
const btnPlayPause    = document.getElementById('btn-playpause');
const seekBar         = document.getElementById('seek-bar');
const volBar          = document.getElementById('vol-bar');
const timeCurrent     = document.getElementById('time-current');
const timeTotal       = document.getElementById('time-total');
const mobileIPDisplay = document.getElementById('mobile-ip-display');

// ── Helpers ────────────────────────────────────────────────────────
function fmt(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1e9) return `${(bytes/1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes/1e6).toFixed(0)} MB`;
  return `${(bytes/1e3).toFixed(0)} KB`;
}

function uid() { return Math.random().toString(36).slice(2); }

// ── Queue ──────────────────────────────────────────────────────────
function addFiles(paths) {
  paths.forEach(p => {
    if (queue.find(q => q.path === p)) return;
    queue.push({ id: uid(), path: p, name: p.split(/[\\/]/).pop(), size: null });
  });
  renderQueue();
}

function renderQueue() {
  queueEmpty.style.display = queue.length ? 'none' : '';
  // Clear existing items
  [...queueList.querySelectorAll('.queue-item')].forEach(e => e.remove());

  queue.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'queue-item' + (i === activeIdx ? ' active' : '');
    el.dataset.idx = i;
    el.innerHTML = `
      <span class="qi-icon">🎬</span>
      <div class="qi-info">
        <div class="qi-name">${item.name}</div>
        ${item.size ? `<div class="qi-size">${fmtSize(item.size)}</div>` : ''}
      </div>
      <button class="qi-remove" data-idx="${i}" title="Remove">✕</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('qi-remove')) {
        removeFromQueue(parseInt(e.target.dataset.idx));
      } else {
        castItem(parseInt(el.dataset.idx));
      }
    });
    queueList.appendChild(el);
  });
}

function removeFromQueue(idx) {
  queue.splice(idx, 1);
  if (activeIdx === idx) activeIdx = -1;
  else if (activeIdx > idx) activeIdx--;
  renderQueue();
}

// ── Devices ────────────────────────────────────────────────────────
function renderDevices() {
  const prev = deviceSelect.value;
  deviceSelect.innerHTML = devices.length
    ? devices.map(d => `<option value="${d.host}">${d.name}</option>`).join('')
    : '<option value="">No devices found…</option>';
  if (prev && devices.find(d => d.host === prev)) deviceSelect.value = prev;
}

// ── Casting ────────────────────────────────────────────────────────
async function castItem(idx) {
  const device = deviceSelect.value;
  if (!device) return alert('No Chromecast selected.');
  if (!queue[idx]) return;

  activeIdx = idx;
  renderQueue();

  const result = await api.castFile({ filePath: queue[idx].path, deviceHost: device });
  if (!result.success) {
    alert(`Cast error: ${result.error}`);
    activeIdx = -1;
    renderQueue();
  }
}

function showCasting(state) {
  dropzone.style.display     = 'none';
  nowPlaying.style.display   = 'flex';
  controlsBar.style.display  = 'block';
  castBadge.style.display    = 'flex';
  npTitle.textContent        = state.title || 'Unknown';
  npDevice.textContent       = `Casting to ${state.deviceName || '—'}`;
  castBadgeLabel.textContent = `Casting · ${state.deviceName || ''}`;
}

function showIdle() {
  dropzone.style.display    = '';
  nowPlaying.style.display  = 'none';
  controlsBar.style.display = 'none';
  castBadge.style.display   = 'none';
}

function applyState(state) {
  castState = state;
  if (!state || state.status === 'idle' || !state.connected) { showIdle(); return; }
  showCasting(state);

  btnPlayPause.textContent  = state.status === 'playing' ? '⏸' : '▶';
  if (!seekDragging) {
    seekBar.max   = state.duration || 100;
    seekBar.value = state.currentTime || 0;
  }
  timeCurrent.textContent = fmt(state.currentTime);
  timeTotal.textContent   = fmt(state.duration);
  volBar.value            = state.muted ? 0 : (state.volume ?? 1);
}

// ── Control actions ────────────────────────────────────────────────
async function ctrl(action, value) {
  const res = await api.castControl({ action, value });
  if (!res.success) console.error('Control error:', res.error);
}

document.getElementById('btn-playpause').addEventListener('click', () => {
  ctrl(castState?.status === 'playing' ? 'pause' : 'play');
});
document.getElementById('btn-stop').addEventListener('click', () => ctrl('stop'));
document.getElementById('btn-fwd').addEventListener('click',  () => ctrl('seek', (castState?.currentTime || 0) + 30));
document.getElementById('btn-back').addEventListener('click', () => ctrl('seek', Math.max(0, (castState?.currentTime || 0) - 10)));

document.getElementById('btn-prev').addEventListener('click', () => {
  if (activeIdx > 0) castItem(activeIdx - 1);
});

seekBar.addEventListener('mousedown', () => { seekDragging = true; });
seekBar.addEventListener('mouseup',   () => { seekDragging = false; ctrl('seek', parseFloat(seekBar.value)); });
volBar.addEventListener('input',      () => ctrl('volume', parseFloat(volBar.value)));

// ── Drag & drop ────────────────────────────────────────────────────
const stage = document.getElementById('stage');
stage.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('over'); });
stage.addEventListener('dragleave', ()  => dropzone.classList.remove('over'));
stage.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('over');
  const paths = [...e.dataTransfer.files]
    .filter(f => /\.(mp4|mkv|avi|mov|hevc|ts|m4v|wmv|flv|webm)$/i.test(f.name))
    .map(f => f.path);
  if (paths.length) { addFiles(paths); castItem(queue.length - paths.length); }
});

// ── File picker ────────────────────────────────────────────────────
async function pickFiles() {
  const paths = await api.openFile();
  if (paths?.length) { addFiles(paths); if (activeIdx < 0) castItem(0); }
}
document.getElementById('btn-add-files').addEventListener('click', pickFiles);
document.getElementById('dz-btn-pick').addEventListener('click',  pickFiles);
dropzone.addEventListener('dblclick', pickFiles);

// ── Window controls ────────────────────────────────────────────────
document.getElementById('btn-close').addEventListener('click',    () => api.close());
document.getElementById('btn-minimize').addEventListener('click', () => api.minimize());
document.getElementById('btn-maximize').addEventListener('click', () => api.maximize());

// ── IPC listeners ─────────────────────────────────────────────────
api.onDevicesUpdated(d => { devices = d; renderDevices(); });
api.onCastState(s => applyState(s));

// ── Init ───────────────────────────────────────────────────────────
(async () => {
  const ip    = await api.getLocalIP();
  const state = await api.getCastState();
  // Mobile PWA hosted on Cloudflare — show connection address in sidebar
  mobileIPDisplay.innerHTML = `<span style="opacity:.6">ws://</span>${ip}:8766`;
  mobileIPDisplay.title     = 'WebSocket address — enter this in the mobile app settings';
  applyState(state);
})();
