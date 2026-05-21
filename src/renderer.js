'use strict';
const api = window.castHub;

let queue = [], devices = [], castState = null, activeIdx = -1, seekDragging = false, isCasting = false, autoPlay = false;

const $ = id => document.getElementById(id);
const queueList       = $('queue-list'),    queueEmpty    = $('queue-empty');
const deviceSelect    = $('device-select'), castBadge     = $('cast-badge');
const castBadgeLabel  = $('cast-badge-label'), btnDisconnect = $('btn-disconnect');
const dropzone        = $('dropzone'),      nowPlaying    = $('now-playing');
const controlsBar     = $('controls-bar'), npTitle        = $('np-title');
const npDevice        = $('np-device'),    btnPlayPause   = $('btn-playpause');
const seekBar         = $('seek-bar'),     volBar         = $('vol-bar');
const timeCurrent     = $('time-current'), timeTotal      = $('time-total');
const mobileIPDisplay = $('mobile-ip-display');

function fmt(s) {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function uid() { return Math.random().toString(36).slice(2); }

function addFiles(paths) {
  paths.forEach(p => { if (!queue.find(q => q.path === p)) queue.push({ id:uid(), path:p, name:p.split(/[\\/]/).pop() }); });
  saveQueue();
  renderQueue();
}

function toggleAutoPlay() {
  autoPlay = !autoPlay;
  const btn = $('btn-autoplay');
  if (btn) btn.textContent = autoPlay ? '🔁 Auto-play ON' : '🔁 Auto-play';
}

function saveQueue() {
  const data = queue.map(i => ({ id:i.id, path:i.path, name:i.name }));
  try { localStorage.setItem('casthub_queue', JSON.stringify(data)); } catch(e) {}
  try { api.saveQueue(data); } catch(e) {}
}

function renderQueue() {
  queueEmpty.style.display = queue.length ? 'none' : '';
  [...queueList.querySelectorAll('.queue-item')].forEach(e => e.remove());
  queue.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'queue-item' + (i === activeIdx ? ' active' : '');
    el.dataset.idx = i;
    el.innerHTML = `<span class="qi-icon">🎬</span><div class="qi-info"><div class="qi-name">${item.name}</div></div><button class="qi-remove" data-idx="${i}" title="Remove">✕</button>`;
    el.addEventListener('click', e => {
      if (e.target.classList.contains('qi-remove')) removeFromQueue(+e.target.dataset.idx);
      else selectItem(+el.dataset.idx);
    });
    queueList.appendChild(el);
  });
}

function removeFromQueue(idx) {
  queue.splice(idx, 1);
  if (activeIdx === idx) activeIdx = -1; else if (activeIdx > idx) activeIdx--;
  saveQueue();
  renderQueue();
}

function renderDevices() {
  const prev = deviceSelect.value;
  deviceSelect.innerHTML = devices.length
    ? devices.map(d => `<option value="${d.host}">${d.name}</option>`).join('')
    : '<option value="">No devices found…</option>';
  if (prev && devices.find(d => d.host === prev)) deviceSelect.value = prev;
}

function selectItem(idx) {
  activeIdx = idx;
  renderQueue();
  // Show a "ready to play" state without actually casting
  const device = deviceSelect.value;
  if (queue[idx]) {
    npTitle.textContent  = queue[idx].name;
    npDevice.textContent = device ? `Ready to cast to ${devices.find(d=>d.host===device)?.name||device}` : 'Select a device above';
    dropzone.style.display   = 'none';
    nowPlaying.style.display = 'flex';
    controlsBar.style.display = 'block';
    btnPlayPause.textContent = '▶';
  }
}

async function castItem(idx) {
  const device = deviceSelect.value;
  if (!device) return alert('No Chromecast selected.');
  if (!queue[idx]) return;
  activeIdx = idx; renderQueue();
  applyState({ connected:true, status:'buffering', title:queue[idx].name,
    deviceName: devices.find(d => d.host === device)?.name || device,
    currentTime:0, duration:0, volume:1, muted:false });
  const result = await api.castFile({ filePath: queue[idx].path, deviceHost: device });
  if (!result.success) {
    alert(`Cast error: ${result.error}`);
    activeIdx = -1; renderQueue();
    applyState({ connected:false, status:'idle' });
  }
}

function showCasting(state) {
  btnDisconnect.classList.remove('hidden');
  castBadge.style.display   = 'flex';
  dropzone.style.display    = 'none';
  nowPlaying.style.display  = 'flex';
  controlsBar.style.display = 'block';
  npTitle.textContent       = state.title || 'Unknown';
  npDevice.textContent      = `Casting to ${state.deviceName || '—'}`;
  castBadgeLabel.textContent = `Casting · ${state.deviceName || ''}`;
}

function showIdle() {
  isCasting = false;
  btnDisconnect.classList.add('hidden');
  castBadge.style.display   = 'none';
  dropzone.style.display    = '';
  nowPlaying.style.display  = 'none';
  controlsBar.style.display = 'none';
}

function applyState(state) {
  castState = state;
  if (!state || state.status === 'idle' || !state.connected) { showIdle(); return; }
  isCasting = true;
  showCasting(state);
  btnPlayPause.textContent = state.status === 'playing' ? '⏸' : '▶';
  if (state.status === 'paused') btnPlayPause.textContent = '▶';
  if (!seekDragging) { seekBar.max = state.duration || 100; seekBar.value = state.currentTime || 0; }
  timeCurrent.textContent = fmt(state.currentTime);
  timeTotal.textContent   = fmt(state.duration);
  volBar.value            = state.muted ? 0 : (state.volume ?? 1);
}

async function ctrl(action, value) {
  const r = await api.castControl({ action, value });
  if (!r.success) console.error('Control error:', r.error);
}

btnDisconnect.addEventListener('click', () => { isCasting = false; ctrl('stop'); showIdle(); });
$('btn-playpause').addEventListener('click', () => {
  if (isCasting) {
    // Already casting — toggle play/pause
    ctrl(castState?.status === 'playing' ? 'pause' : 'play');
  } else if (activeIdx >= 0) {
    // Not casting — start playing selected item
    castItem(activeIdx);
  }
});
$('btn-stop').addEventListener('click',  () => { isCasting = false; ctrl('stop'); showIdle(); });
$('btn-fwd').addEventListener('click',   () => ctrl('seek', (castState?.currentTime||0) + 30));
$('btn-back').addEventListener('click',  () => ctrl('seek', Math.max(0, (castState?.currentTime||0) - 10)));
$('btn-prev').addEventListener('click', () => { if (activeIdx > 0) castItem(activeIdx - 1); });
$('btn-next').addEventListener('click', () => { if (activeIdx < queue.length - 1) castItem(activeIdx + 1); });

// Auto-play: when status goes IDLE and autoPlay is on, play next
api.onCastState(s => {
  if (s.status === 'idle' && isCasting && autoPlay && activeIdx >= 0 && activeIdx < queue.length - 1) {
    setTimeout(() => castItem(activeIdx + 1), 1000);
  }
  applyState(s);
});

seekBar.addEventListener('mousedown', () => { seekDragging = true; });
seekBar.addEventListener('mouseup',   () => { seekDragging = false; ctrl('seek', parseFloat(seekBar.value)); });
volBar.addEventListener('input', () => ctrl('volume', parseFloat(volBar.value)));

const stage = $('stage');
stage.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('over'); });
stage.addEventListener('dragleave', () => dropzone.classList.remove('over'));
stage.addEventListener('drop', e => {
  e.preventDefault(); dropzone.classList.remove('over');
  const paths = [...e.dataTransfer.files]
    .filter(f => /\.(mp4|mkv|avi|mov|hevc|ts|m4v|wmv|flv|webm)$/i.test(f.name))
    .map(f => f.path);
  if (paths.length) { addFiles(paths); }
});

async function pickFiles() {
  const paths = await api.openFile();
  if (paths?.length) { addFiles(paths); }
}
$('btn-add-files').addEventListener('click', pickFiles);
$('dz-btn-pick').addEventListener('click',   pickFiles);
dropzone.addEventListener('dblclick', pickFiles);

$('btn-close').addEventListener('click',    () => api.close());
$('btn-minimize').addEventListener('click', () => api.minimize());
$('btn-maximize').addEventListener('click', () => api.maximize());

api.onDevicesUpdated(d => { devices = d; renderDevices(); });

// Restore queue from last session
try {
  const saved = JSON.parse(localStorage.getItem('casthub_queue') || '[]');
  if (saved.length) { queue = saved; renderQueue(); }
} catch {}

(async () => {
  const [ip, existingDevices, state, savedQueue] = await Promise.all([
    api.getLocalIP(), api.getDevices(), api.getCastState(), api.loadQueue()
  ]);
  mobileIPDisplay.innerHTML = `<span style="opacity:.6">ws://</span>${ip}:8766`;
  if (existingDevices?.length) { devices = existingDevices; renderDevices(); }
  if (savedQueue?.length) { queue = savedQueue; renderQueue(); }
  applyState(state);
})();
