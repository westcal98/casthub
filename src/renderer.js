'use strict';
const api = window.castHub;

let queue = [], devices = [], castState = null, activeIdx = -1, seekDragging = false, isCasting = false, autoPlay = false, disconnecting = false, idleTimer = null, currentFilePath = null, resumeDismissTimer = null, thumbDebounceTimer = null;

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
const resumeNotice    = $('resume-notice'), resumeLabel = $('resume-label');
const thumbImg        = $('thumb-img'),     thumbIcon   = $('thumb-icon'),  thumbOverlay = $('thumb-overlay');

function fmt(s) {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function uid() { return Math.random().toString(36).slice(2); }

function showResumeNotice(pos) {
  resumeLabel.textContent = `Resume from ${fmt(pos)}?`;
  resumeNotice.style.display = 'flex';
  if (resumeDismissTimer) clearTimeout(resumeDismissTimer);
  resumeDismissTimer = setTimeout(hideResumeNotice, 5000);
}
function hideResumeNotice() {
  if (resumeDismissTimer) { clearTimeout(resumeDismissTimer); resumeDismissTimer = null; }
  resumeNotice.style.display = 'none';
}

function loadThumb(filePath, t) {
  if (!filePath) return;
  thumbImg.onerror = () => { thumbImg.style.display = 'none'; thumbIcon.style.display = ''; };
  thumbImg.onload  = () => { thumbImg.style.display = 'block'; thumbIcon.style.display = 'none'; };
  thumbImg.src = `http://localhost:8765/thumbnail?path=${encodeURIComponent(filePath)}&t=${Math.max(0, Math.floor(t))}`;
}
function clearThumb() {
  thumbImg.removeAttribute('src');
  thumbImg.style.display = 'none'; thumbIcon.style.display = '';
  thumbOverlay.style.display = 'none'; thumbOverlay.textContent = '';
}
function showThumbOverlay(text) { thumbOverlay.textContent = text; thumbOverlay.style.display = 'block'; }
function hideThumbOverlay()     { thumbOverlay.style.display = 'none'; }

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
    el.addEventListener('dblclick', e => {
      if (!e.target.classList.contains('qi-remove')) castItem(+el.dataset.idx);
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
  const device = deviceSelect.value;
  if (queue[idx]) {
    currentFilePath = queue[idx].path;
    npTitle.textContent  = queue[idx].name;
    npDevice.textContent = device ? `Ready to cast to ${devices.find(d=>d.host===device)?.name||device}` : 'Select a device above';
    dropzone.style.display   = 'none';
    nowPlaying.style.display = 'flex';
    controlsBar.style.display = 'block';
    btnPlayPause.textContent = '▶';
    loadThumb(currentFilePath, 0);
  }
}

async function castItem(idx) {
  const device = deviceSelect.value;
  if (!device) return alert('No Chromecast selected.');
  if (!queue[idx]) return;
  activeIdx = idx; renderQueue();
  hideResumeNotice();
  currentFilePath = queue[idx].path;

  let seekSeconds = 0;
  try {
    const saved = await api.getPosition(queue[idx].path);
    if (saved && saved.pos > 60 && (!saved.dur || saved.pos / saved.dur < 0.95)) {
      seekSeconds = saved.pos;
      showResumeNotice(saved.pos);
    }
  } catch {}

  loadThumb(currentFilePath, seekSeconds);
  applyState({ connected:true, status:'buffering', title:queue[idx].name,
    deviceName: devices.find(d => d.host === device)?.name || device,
    currentTime: seekSeconds, duration: 0, volume:1, muted:false });
  const result = await api.castFile({ filePath: queue[idx].path, deviceHost: device, seekSeconds });
  if (!result.success) {
    alert(`Cast error: ${result.error}`);
    activeIdx = -1; renderQueue();
    disconnecting = true; fullStop(); disconnecting = false;
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
// Full cleanup only on an explicit user-initiated stop — NOT on transient idle debounce
function fullStop() {
  hideResumeNotice();
  clearThumb();
  currentFilePath = null;
  showIdle();
}

function applyState(state) {
  if (disconnecting) return;
  if (!state || state.status === 'idle' || !state.connected) {
    // Debounce idle: seeks cause transient IDLE INTERRUPTED/CANCELLED — don't reset UI immediately
    if (isCasting && !idleTimer) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (isCasting) { castState = state; showIdle(); }
      }, 2500);
    }
    return;
  }
  // Non-idle state: cancel any pending idle transition and update UI
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  castState = state;
  if (!isCasting) {
    // Only run full showCasting on idle→casting transition
    isCasting = true;
    showCasting(state);
  } else {
    // Already casting — only update text that may have changed
    if (state.title)      npTitle.textContent      = state.title;
    if (state.deviceName) npDevice.textContent     = `Casting to ${state.deviceName}`;
    if (state.deviceName) castBadgeLabel.textContent = `Casting · ${state.deviceName}`;
  }
  btnPlayPause.textContent = state.status === 'playing' ? '⏸' : '▶';
  if (!seekDragging) {
    seekBar.max   = state.duration || 100;
    seekBar.value = state.currentTime || 0;
    const pct = state.duration ? Math.min(100, (state.currentTime || 0) / state.duration * 100) : 0;
    seekBar.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--card) ${pct}%)`;
  }
  timeCurrent.textContent = fmt(state.currentTime);
  timeTotal.textContent   = fmt(state.duration);
  volBar.value            = state.muted ? 0 : (state.volume ?? 1);
}

async function ctrl(action, value) {
  const r = await api.castControl({ action, value });
  if (!r.success) console.error('Control error:', r.error);
}

btnDisconnect.addEventListener('click', async () => {
  disconnecting = true;
  isCasting = false;
  fullStop();
  await api.disconnect();
  disconnecting = false;
});
$('btn-playpause').addEventListener('click', () => {
  if (isCasting) {
    // Already casting — toggle play/pause
    ctrl(castState?.status === 'playing' ? 'pause' : 'play');
  } else if (activeIdx >= 0) {
    // Not casting — start playing selected item
    castItem(activeIdx);
  }
});
$('btn-stop').addEventListener('click', async () => {
  disconnecting = true;
  isCasting = false;
  fullStop();
  await api.softStop();
  disconnecting = false;
});
$('btn-fwd').addEventListener('click',   () => ctrl('seek', (castState?.currentTime||0) + 30));
$('btn-back').addEventListener('click',  () => ctrl('seek', Math.max(0, (castState?.currentTime||0) - 10)));
$('btn-restart').addEventListener('click', () => ctrl('seek', 0));
$('btn-prev').addEventListener('click', () => { if (activeIdx > 0) castItem(activeIdx - 1); });
$('btn-next').addEventListener('click', () => { if (activeIdx < queue.length - 1) castItem(activeIdx + 1); });
$('btn-start-over').addEventListener('click', () => { hideResumeNotice(); ctrl('seek', 0); });
$('btn-resume-dismiss').addEventListener('click', hideResumeNotice);

// Auto-play: when status goes IDLE and autoPlay is on, play next
api.onCastState(s => {
  if (s.status === 'idle' && isCasting && autoPlay && activeIdx >= 0 && activeIdx < queue.length - 1) {
    // Delay to confirm idle is genuine (not transient seek-induced INTERRUPTED/CANCELLED)
    setTimeout(() => { if (castState?.status === 'idle') castItem(activeIdx + 1); }, 2000);
  }
  applyState(s);
});

seekBar.addEventListener('mousedown', () => { seekDragging = true; });
seekBar.addEventListener('mouseup', () => {
  seekDragging = false;
  const t = parseFloat(seekBar.value);
  hideThumbOverlay();
  if (currentFilePath) loadThumb(currentFilePath, t);
  ctrl('seek', t);
});
// Show time + thumbnail while dragging
seekBar.addEventListener('input', () => {
  if (!seekDragging || !currentFilePath) return;
  const t = parseFloat(seekBar.value);
  const pct = parseFloat(seekBar.max) ? t / parseFloat(seekBar.max) * 100 : 0;
  seekBar.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--card) ${pct}%)`;
  showThumbOverlay(fmt(t));
  if (thumbDebounceTimer) clearTimeout(thumbDebounceTimer);
  thumbDebounceTimer = setTimeout(() => loadThumb(currentFilePath, t), 150);
});
// Show time + thumbnail while hovering (not dragging)
seekBar.addEventListener('mousemove', e => {
  if (!isCasting || !currentFilePath || !(castState?.duration > 0)) return;
  const rect = seekBar.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const t    = pct * parseFloat(seekBar.max || '100');
  showThumbOverlay(fmt(t));
  if (!seekDragging) {
    if (thumbDebounceTimer) clearTimeout(thumbDebounceTimer);
    thumbDebounceTimer = setTimeout(() => loadThumb(currentFilePath, t), 150);
  }
});
seekBar.addEventListener('mouseleave', () => {
  if (seekDragging) return;
  hideThumbOverlay();
  if (thumbDebounceTimer) { clearTimeout(thumbDebounceTimer); thumbDebounceTimer = null; }
  if (currentFilePath && castState?.currentTime != null) loadThumb(currentFilePath, castState.currentTime);
});
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

// ── Queue context menu & keyboard removal ──────────────────────────
const ctxMenu = $('ctx-menu');
let ctxTargetIdx = -1;

queueList.addEventListener('contextmenu', e => {
  const item = e.target.closest('.queue-item');
  if (!item) return;
  e.preventDefault();
  ctxTargetIdx = +item.dataset.idx;
  // Keep menu inside window
  const mw = 170, mh = 40;
  ctxMenu.style.left = Math.min(e.clientX, window.innerWidth  - mw) + 'px';
  ctxMenu.style.top  = Math.min(e.clientY, window.innerHeight - mh) + 'px';
  ctxMenu.style.display = 'block';
});
document.addEventListener('click',       () => { ctxMenu.style.display = 'none'; });
document.addEventListener('contextmenu', e => { if (!e.target.closest('#queue-list')) ctxMenu.style.display = 'none'; });
$('ctx-remove').addEventListener('click', () => {
  if (ctxTargetIdx >= 0) { removeFromQueue(ctxTargetIdx); ctxTargetIdx = -1; }
  ctxMenu.style.display = 'none';
});

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'SELECT') return;
  switch (e.key) {
    case 'Delete':
      if (activeIdx >= 0 && !isCasting) removeFromQueue(activeIdx);
      break;
    case ' ':
      e.preventDefault();
      if (isCasting) ctrl(castState?.status === 'playing' ? 'pause' : 'play');
      else if (activeIdx >= 0) castItem(activeIdx);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (isCasting) ctrl('seek', Math.max(0, (castState?.currentTime || 0) - 10));
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (isCasting) ctrl('seek', (castState?.currentTime || 0) + 30);
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (activeIdx > 0) castItem(activeIdx - 1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (activeIdx < queue.length - 1) castItem(activeIdx + 1);
      break;
  }
});

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
