'use strict';

let ws = null, castState = null, seekDragging = false, pathStack = [];
const browseCallbacks = {};
const STORAGE_KEY = 'casthub_ws_addr';

const $ = id => document.getElementById(id);
const connDot     = $('conn-dot'),    connLabel   = $('conn-label');
const wsInput     = $('ws-input'),    btnConnect  = $('btn-connect');
const setupStatus = $('setup-status');
const npIdle      = $('np-idle'),     npActive    = $('np-active');
const mobTitle    = $('mob-title'),   mobDevice   = $('mob-device');
const mobCurrent  = $('mob-current'), mobTotal    = $('mob-total');
const mobSeek     = $('mob-seek'),    mobVol      = $('mob-vol');
const mobPlayPause= $('mob-playpause');
const fileList    = $('file-list'),   breadcrumb  = $('breadcrumb');

function fmt(s) {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function fmtSize(b) {
  if (!b) return '';
  if (b > 1e9) return `${(b/1e9).toFixed(1)} GB`;
  if (b > 1e6) return `${(b/1e6).toFixed(0)} MB`;
  return `${Math.round(b/1e3)} KB`;
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('page-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'files' && ws?.readyState === 1)
      browseTo(pathStack[pathStack.length - 1] || '');
  });
});

function connect(addr) {
  const url = addr.startsWith('ws://') ? addr : `ws://${addr}`;
  setupStatus.className = 'status-msg';
  setupStatus.textContent = 'Connecting…';
  if (ws) { try { ws.close(); } catch {} }
  ws = new WebSocket(url);

  ws.onopen = () => {
    localStorage.setItem(STORAGE_KEY, addr);
    connDot.classList.add('connected');
    connLabel.textContent = 'Connected';
    setupStatus.textContent = '✓ Connected!';
    browseTo('');
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state')  { applyState(msg); return; }
      if (msg.type === 'browse') {
        const cb = browseCallbacks[msg.requestId];
        if (cb) { delete browseCallbacks[msg.requestId]; cb(msg); }
        return;
      }
    } catch {}
  };

  ws.onclose = () => {
    connDot.classList.remove('connected');
    connLabel.textContent = 'Disconnected';
    setupStatus.className = 'status-msg error';
    setupStatus.textContent = 'Connection lost. Retrying…';
    setTimeout(() => { const s = localStorage.getItem(STORAGE_KEY); if (s) connect(s); }, 3000);
  };

  ws.onerror = () => {
    setupStatus.className = 'status-msg error';
    setupStatus.textContent = 'Could not connect. Check the address.';
  };
}

function send(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }

btnConnect.addEventListener('click', () => { const v = wsInput.value.trim(); if (v) connect(v); });
wsInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnConnect.click(); });

function applyState(state) {
  castState = state;
  const active = state.connected && state.status !== 'idle';
  npIdle.style.display   = active ? 'none'  : '';
  npActive.style.display = active ? 'block' : 'none';
  if (!active) return;
  mobTitle.textContent     = state.title || 'Unknown';
  mobDevice.textContent    = `Casting to ${state.deviceName || '—'}`;
  mobPlayPause.textContent = state.status === 'playing' ? '⏸' : '▶';
  if (!seekDragging) { mobSeek.max = state.duration || 100; mobSeek.value = state.currentTime || 0; }
  mobCurrent.textContent = fmt(state.currentTime);
  mobTotal.textContent   = fmt(state.duration);
  mobVol.value           = state.muted ? 0 : (state.volume ?? 1);
}

mobPlayPause.addEventListener('click', () => send({ action: castState?.status === 'playing' ? 'pause' : 'play' }));
$('mob-stop').addEventListener('click', () => send({ action: 'stop' }));
$('mob-fwd').addEventListener('click',  () => send({ action: 'seek', value: (castState?.currentTime||0) + 30 }));
$('mob-back').addEventListener('click', () => send({ action: 'seek', value: Math.max(0,(castState?.currentTime||0) - 10) }));
$('mob-prev').addEventListener('click', () => send({ action: 'prev' }));

mobSeek.addEventListener('touchstart', () => { seekDragging = true; });
mobSeek.addEventListener('touchend',   () => { seekDragging = false; send({ action: 'seek', value: parseFloat(mobSeek.value) }); });
mobSeek.addEventListener('mousedown',  () => { seekDragging = true; });
mobSeek.addEventListener('mouseup',    () => { seekDragging = false; send({ action: 'seek', value: parseFloat(mobSeek.value) }); });
mobVol.addEventListener('change', () => send({ action: 'volume', value: parseFloat(mobVol.value) }));

function browseTo(dirPath) {
  if (ws?.readyState !== 1) { fileList.innerHTML = '<li class="loading-msg">Not connected.</li>'; return; }
  fileList.innerHTML = '<li class="loading-msg">Loading…</li>';
  const requestId = Date.now().toString() + Math.random();
  const timeout = setTimeout(() => { delete browseCallbacks[requestId]; fileList.innerHTML = '<li class="loading-msg" style="color:var(--danger)">Request timed out.</li>'; }, 6000);
  browseCallbacks[requestId] = (data) => {
    clearTimeout(timeout);
    if (data.error) { fileList.innerHTML = `<li class="loading-msg" style="color:var(--danger)">Error: ${data.error}</li>`; return; }
    if (dirPath === '') pathStack = [''];
    else if (!pathStack.includes(dirPath)) pathStack.push(dirPath);
    renderBreadcrumb(data.path, data.parent);
    renderFiles(data.entries);
  };
  send({ action: 'browse', path: dirPath, requestId });
}

function renderBreadcrumb(currentPath, parent) {
  breadcrumb.innerHTML = '';
  if (!currentPath || currentPath === 'drives') { breadcrumb.textContent = 'My PC'; return; }
  if (parent != null) {
    const back = document.createElement('button');
    back.textContent = '‹ Back';
    back.onclick = () => { pathStack.pop(); browseTo(parent); };
    breadcrumb.appendChild(back);
    breadcrumb.appendChild(document.createTextNode(' · '));
  }
  const parts = currentPath.replace(/\\/g, '/').split('/').filter(Boolean);
  breadcrumb.appendChild(document.createTextNode(parts[parts.length-1] || currentPath));
}

function renderFiles(entries) {
  fileList.innerHTML = '';
  if (!entries?.length) { fileList.innerHTML = '<li class="loading-msg">Empty folder</li>'; return; }
  entries.forEach(entry => {
    const li = document.createElement('li');
    li.className = 'file-item';
    const isDir = entry.type === 'dir' || entry.type === 'drive';
    li.innerHTML = `
      <span class="fi-icon">${isDir ? '📁' : '🎬'}</span>
      <div class="fi-info">
        <div class="fi-name">${entry.name}</div>
        ${entry.size ? `<div class="fi-size">${fmtSize(entry.size)}</div>` : ''}
      </div>
      ${isDir ? '<span class="fi-arrow">›</span>' : '<button class="fi-cast-btn">Cast</button>'}`;
    if (isDir) {
      li.addEventListener('click', () => browseTo(entry.path));
    } else {
      li.querySelector('.fi-cast-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        send({ action: 'cast', filePath: entry.path });
        document.querySelector('[data-tab="np"]').click();
      });
    }
    fileList.appendChild(li);
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

window.addEventListener('load', () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) { wsInput.value = saved; connect(saved); }
});
