'use strict';

// ── State ──────────────────────────────────────────────────────────
let ws           = null;
let castState    = null;
let desktopIP    = null;    // just the IP (e.g. 192.168.1.100)
let seekDragging = false;
let pathStack    = [];      // breadcrumb history

const STORAGE_KEY = 'casthub_ws_addr';

// ── Elements ───────────────────────────────────────────────────────
const connDot       = document.getElementById('conn-dot');
const connLabel     = document.getElementById('conn-label');
const wsInput       = document.getElementById('ws-input');
const btnConnect    = document.getElementById('btn-connect');
const setupStatus   = document.getElementById('setup-status');
const npIdle        = document.getElementById('np-idle');
const npActive      = document.getElementById('np-active');
const mobTitle      = document.getElementById('mob-title');
const mobDevice     = document.getElementById('mob-device');
const mobCurrent    = document.getElementById('mob-current');
const mobTotal      = document.getElementById('mob-total');
const mobSeek       = document.getElementById('mob-seek');
const mobVol        = document.getElementById('mob-vol');
const mobPlayPause  = document.getElementById('mob-playpause');
const fileList      = document.getElementById('file-list');
const breadcrumb    = document.getElementById('breadcrumb');

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
  return `${Math.round(bytes/1e3)} KB`;
}

// ── Tabs ───────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('page-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'files' && ws?.readyState === 1) browseTo(pathStack[pathStack.length-1] || '');
  });
});

// ── WebSocket ──────────────────────────────────────────────────────
function connect(addr) {
  const url = addr.startsWith('ws://') ? addr : `ws://${addr}`;
  // Extract IP for HTTP file browsing
  desktopIP = addr.replace(/^ws:\/\//,'').split(':')[0];

  setupStatus.className = 'status-msg';
  setupStatus.textContent = 'Connecting…';

  if (ws) { try { ws.close(); } catch {} }

  ws = new WebSocket(url);

  ws.onopen = () => {
    localStorage.setItem(STORAGE_KEY, addr);
    connDot.classList.add('connected');
    connLabel.textContent = 'Connected';
    setupStatus.textContent = '✓ Connected!';
    // Immediately load file browser default
    browseTo('');
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') applyState(msg);
    } catch {}
  };

  ws.onclose = () => {
    connDot.classList.remove('connected');
    connLabel.textContent = 'Disconnected';
    setupStatus.className = 'status-msg error';
    setupStatus.textContent = 'Connection lost. Reconnecting…';
    setTimeout(() => { if (localStorage.getItem(STORAGE_KEY)) connect(localStorage.getItem(STORAGE_KEY)); }, 3000);
  };

  ws.onerror = () => {
    setupStatus.className = 'status-msg error';
    setupStatus.textContent = 'Failed to connect. Check the address.';
  };
}

function send(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

btnConnect.addEventListener('click', () => {
  const val = wsInput.value.trim();
  if (val) connect(val);
});
wsInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnConnect.click(); });

// ── Cast state ─────────────────────────────────────────────────────
function applyState(state) {
  castState = state;
  const active = state.connected && state.status !== 'idle';
  npIdle.style.display   = active ? 'none' : '';
  npActive.style.display = active ? 'block' : 'none';
  if (!active) return;

  mobTitle.textContent    = state.title || 'Unknown';
  mobDevice.textContent   = `Casting to ${state.deviceName || '—'}`;
  mobPlayPause.textContent = state.status === 'playing' ? '⏸' : '▶';
  if (!seekDragging) {
    mobSeek.max   = state.duration || 100;
    mobSeek.value = state.currentTime || 0;
  }
  mobCurrent.textContent = fmt(state.currentTime);
  mobTotal.textContent   = fmt(state.duration);
  mobVol.value           = state.muted ? 0 : (state.volume ?? 1);
}

// ── Controls ───────────────────────────────────────────────────────
mobPlayPause.addEventListener('click', () => send({ action: castState?.status === 'playing' ? 'pause' : 'play' }));
document.getElementById('mob-stop').addEventListener('click', () => send({ action: 'stop' }));
document.getElementById('mob-fwd').addEventListener('click',  () => send({ action: 'seek', value: (castState?.currentTime||0)+30 }));
document.getElementById('mob-back').addEventListener('click', () => send({ action: 'seek', value: Math.max(0,(castState?.currentTime||0)-10) }));
document.getElementById('mob-prev').addEventListener('click', () => send({ action: 'prev' }));

mobSeek.addEventListener('touchstart', () => { seekDragging = true; });
mobSeek.addEventListener('touchend',   () => { seekDragging = false; send({ action: 'seek', value: parseFloat(mobSeek.value) }); });
mobSeek.addEventListener('mousedown',  () => { seekDragging = true; });
mobSeek.addEventListener('mouseup',    () => { seekDragging = false; send({ action: 'seek', value: parseFloat(mobSeek.value) }); });
mobVol.addEventListener('change', () => send({ action: 'volume', value: parseFloat(mobVol.value) }));

// ── File browser ───────────────────────────────────────────────────
async function browseTo(dirPath) {
  if (!desktopIP) return;
  fileList.innerHTML = '<li class="loading-msg">Loading…</li>';

  try {
    const url = `http://${desktopIP}:8765/browse?path=${encodeURIComponent(dirPath)}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error('Server error');
    const data = await res.json();

    // Update path stack for breadcrumb
    if (dirPath === '') {
      pathStack = [''];
    } else if (!pathStack.includes(dirPath)) {
      pathStack.push(dirPath);
    }
    renderBreadcrumb(data.path, data.parent);
    renderFiles(data.entries, data.parent);
  } catch (err) {
    fileList.innerHTML = `<li class="loading-msg" style="color:var(--danger)">Error: ${err.message}</li>`;
  }
}

function renderBreadcrumb(currentPath, parent) {
  breadcrumb.innerHTML = '';
  if (currentPath === '' || currentPath === 'drives') {
    breadcrumb.textContent = 'My PC';
    return;
  }
  const parts = currentPath.replace(/\\/g, '/').split('/').filter(Boolean);
  // Back button
  if (parent != null) {
    const back = document.createElement('button');
    back.textContent = '‹ Back';
    back.onclick = () => browseTo(parent);
    breadcrumb.appendChild(back);
    breadcrumb.appendChild(document.createTextNode(' · '));
  }
  breadcrumb.appendChild(document.createTextNode(parts[parts.length-1] || currentPath));
}

function renderFiles(entries, parent) {
  fileList.innerHTML = '';

  if (!entries.length) {
    fileList.innerHTML = '<li class="loading-msg">Empty folder</li>';
    return;
  }

  entries.forEach(entry => {
    const li = document.createElement('li');
    li.className = 'file-item';

    const isDir   = entry.type === 'dir' || entry.type === 'drive';
    const icon    = isDir ? '📁' : '🎬';

    li.innerHTML = `
      <span class="fi-icon">${icon}</span>
      <div class="fi-info">
        <div class="fi-name">${entry.name}</div>
        ${entry.size ? `<div class="fi-size">${fmtSize(entry.size)}</div>` : ''}
      </div>
      ${isDir
        ? '<span class="fi-arrow">›</span>'
        : `<button class="fi-cast-btn" data-path="${entry.path}">Cast</button>`}
    `;

    if (isDir) {
      li.addEventListener('click', () => browseTo(entry.path));
    } else {
      li.querySelector('.fi-cast-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        send({ action: 'cast', filePath: entry.path });
        // Switch to now playing tab
        document.querySelector('[data-tab="np"]').click();
      });
    }

    fileList.appendChild(li);
  });
}

// ── PWA service worker ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── Auto-reconnect on load ─────────────────────────────────────────
window.addEventListener('load', () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    wsInput.value = saved;
    connect(saved);
  }
});
