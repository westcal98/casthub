process.on('uncaughtException', (err) => {
  console.error('[CastHub] Uncaught exception (caught):', err.message);
  // Don't crash — log and continue
});
process.on('unhandledRejection', (reason) => {
  console.error('[CastHub] Unhandled rejection (caught):', reason);
});

require('./logger');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { startFileServer, stopFileServer, getLocalIP, browseDirectory, getStreamInfo, TRANSCODE_EXTS, generateSession, stopSession } = require('./server/fileServer');
const { startWSServer, stopWSServer, broadcast, onMobileCommand, onBrowseRequest, setStateGetter } = require('./server/wsServer');
const CastManager = require('./server/cast');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'NetworkServiceInProcess');

let mainWindow;
const castManager = new CastManager();

// ── Resume position store ──────────────────────────────────────────
let POSITIONS_FILE = null; // set after app.whenReady (app.getPath needs app to be ready)
function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } catch { return {}; }
}
function savePosition(filePath, pos, dur) {
  if (!POSITIONS_FILE || !filePath || pos < 60) return;
  const positions = loadPositions();
  const key = crypto.createHash('md5').update(filePath).digest('hex');
  positions[key] = { pos: Math.floor(pos), dur: Math.floor(dur || liveDuration || 0), ts: Date.now() };
  try { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions)); } catch {}
}
function getPositionFor(filePath) {
  if (!POSITIONS_FILE || !filePath) return null;
  const positions = loadPositions();
  const key = crypto.createHash('md5').update(filePath).digest('hex');
  const saved = positions[key];
  if (!saved || saved.pos < 60) return null;
  if (saved.dur > 0 && saved.pos / saved.dur > 0.95) return null; // near end — don't resume
  return saved;
}

let positionSaveInterval = null;
function startPositionSave() {
  if (positionSaveInterval) clearInterval(positionSaveInterval);
  positionSaveInterval = setInterval(() => {
    if (currentFilePath && currentHlsSessionId) savePosition(currentFilePath, getLiveTime(), liveDuration);
  }, 30000);
}
function stopPositionSave() {
  if (positionSaveInterval) { clearInterval(positionSaveInterval); positionSaveInterval = null; }
}

// ── State change handler ───────────────────────────────────────────
castManager._onStateChange = (state) => {
  // Reconnect on dropped TCP connection during active playback
  if (state._connectionLost && currentFilePath && currentHlsSessionId) {
    const seekTo = Math.floor(getLiveTime());
    console.log(`[CastHub] Connection lost — reconnecting in 5s at ${seekTo}s`);
    stopLiveTimer(); stopPositionSave();
    setTimeout(async () => {
      try {
        if (currentHlsSessionId) stopSession(currentHlsSessionId);
        const sessionId = generateSession(currentFilePath, seekTo);
        currentHlsSessionId = sessionId;
        const url = `http://${getLocalIP()}:8765/hls/${sessionId}/master.m3u8`;
        isSeeking = true;
        try {
          await castManager.castURL(lastDeviceHost, url,
            castManager.getState().title || path.basename(currentFilePath),
            { duration: liveDuration, seekOffset: seekTo });
        } finally { isSeeking = false; }
        applyPendingSeek();
        startLiveTimer(seekTo, liveDuration);
        startPositionSave();
        console.log('[CastHub] Reconnected successfully at', seekTo, 's');
      } catch (err) { console.error('[CastHub] Reconnect failed:', err.message); }
    }, 5000);
    return;
  }

  // Suppress IDLE INTERRUPTED from reaching renderer during seek (debounce would flash dropzone)
  if (isSeeking && state.status === 'idle') return;

  if (currentFileIsLive) {
    if (livePausedAt !== null) {
      state = { ...state, status:'paused', currentTime:livePausedAt,
                duration:liveDuration || state.duration, connected:true };
    } else if (liveStartedAt !== null) {
      state = { ...state, currentTime:getLiveTime(),
                duration:liveDuration || state.duration };
    }
  }
  mainWindow?.webContents.send('cast-state', state);
  broadcast({ type: 'state', ...state });
};
let currentFilePath    = null;
let currentFileIsLive  = false;
let currentHlsSessionId = null;  // active HLS session
let isSeeking          = false;  // suppress idle events to renderer during HLS session switches
let pendingHlsSeek     = null;   // seek queued while isSeeking=true; applied after connection completes
let lastDeviceHost     = null;   // persists after disconnect for before-quit

// ── Live stream time tracking ──────────────────────────────────────
let liveTimer     = null;
let liveSeekBase  = 0;
let liveStartedAt = null;
let livePausedAt  = null;
let liveDuration  = 0;

function getLiveTime() {
  if (livePausedAt !== null) return livePausedAt;
  if (!liveStartedAt) return liveSeekBase;
  return liveSeekBase + (Date.now() - liveStartedAt) / 1000;
}

function startLiveTimer(seekOffset, duration) {
  liveSeekBase  = seekOffset || 0;
  liveStartedAt = Date.now();
  livePausedAt  = null;
  if (duration) liveDuration = duration;
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    if (isSeeking) return;
    if (!currentFileIsLive || !castManager.getState().connected) return;
    const t = getLiveTime();
    const s = { ...castManager.getState(), currentTime: t,
                duration: liveDuration || castManager.getState().duration };
    mainWindow?.webContents.send('cast-state', s);
    broadcast({ type: 'state', ...s });
  }, 500);
}

function stopLiveTimer() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  liveStartedAt = null;
  // livePausedAt intentionally NOT cleared here — managed by pause/resume actions
}

function applyPendingSeek() {
  if (pendingHlsSeek === null) return;
  const seekTo = pendingHlsSeek;
  pendingHlsSeek = null;
  setImmediate(() => handleTSSeek(seekTo).catch(err => console.error('[CastHub] pendingSeek error:', err.message)));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width:960, height:660, minWidth:760, minHeight:520,
    frame:false, backgroundColor:'#09090f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation:true, nodeIntegration:false }
  });
  mainWindow.loadFile('src/index.html');
}

app.whenReady().then(async () => {
  POSITIONS_FILE = path.join(app.getPath('userData'), 'casthub_positions.json');
  await startFileServer();
  setStateGetter(() => castManager.getState());
  startWSServer();
  createWindow();

  castManager.startDiscovery(devices => {
    mainWindow?.webContents.send('devices-updated', devices);
    broadcast({ type:'devices', devices });
  });

  onBrowseRequest((cmd, reply) => { reply(browseDirectory(cmd.path || '')); });

  onMobileCommand(async cmd => {
    try {
      if (cmd.action === 'cast') {
        const url = await buildCastURL(cmd.filePath, 0);
        await castManager.castURL(castManager.getState().deviceHost, url, path.basename(cmd.filePath));
      } else if (cmd.action === 'seek' && (currentFileIsLive || currentHlsSessionId)) {
        await handleTSSeek(cmd.value);
      } else {
        await castManager.control(cmd.action, cmd.value);
      }
      const state = castManager.getState();
      broadcast({ type:'state', ...state });
      mainWindow?.webContents.send('cast-state', state);
    } catch (err) { broadcast({ type:'error', message:err.message }); }
  });
});

async function buildCastURL(filePath, seekSeconds) {
  const ext  = path.extname(filePath).toLowerCase().slice(1);
  const seek = seekSeconds || 0;
  currentFilePath = filePath;

  if (TRANSCODE_EXTS.has(ext)) {
    const { hasEAC3, hasSSA, duration } = await getStreamInfo(filePath);
    if (hasEAC3 || hasSSA) {
      console.log(`[CastHub] Using HLS — EAC3: ${hasEAC3}, SSA: ${hasSSA}`);
      if (currentHlsSessionId) { stopSession(currentHlsSessionId); currentHlsSessionId = null; }
      const sessionId = generateSession(filePath, seek);
      currentHlsSessionId = sessionId;
      currentFileIsLive   = true;
      if (duration) liveDuration = duration;
      startLiveTimer(seek, duration);
      return `http://${getLocalIP()}:8765/hls/${sessionId}/master.m3u8`;
    }
  }
  if (currentHlsSessionId) { stopSession(currentHlsSessionId); currentHlsSessionId = null; }
  currentFileIsLive = false;
  return `http://${getLocalIP()}:8765/transcode?path=${encodeURIComponent(filePath)}`;
}

async function handleTSSeek(seconds) {
  if (!currentFilePath) return;
  const state  = castManager.getState();
  const seekTo = Math.floor(seconds);
  if (currentHlsSessionId) {
    stopSession(currentHlsSessionId);
    const sessionId = generateSession(currentFilePath, seekTo);
    currentHlsSessionId = sessionId;
    livePausedAt = null;
    const url = `http://${getLocalIP()}:8765/hls/${sessionId}/master.m3u8`;
    isSeeking = true;
    try {
      try { await castManager.reloadURL(url, state.title, { duration: liveDuration, seekOffset: seekTo }); }
      catch { await castManager.castURL(lastDeviceHost || state.deviceHost, url, state.title, { duration: liveDuration, seekOffset: seekTo }); }
    } finally { isSeeking = false; }
    applyPendingSeek();
    startLiveTimer(seekTo, liveDuration);
  } else {
    const url = `http://${getLocalIP()}:8765/remux?path=${encodeURIComponent(currentFilePath)}&seek=${seekTo}`;
    await castManager.castURL(state.deviceHost, url, state.title, { duration: liveDuration });
    if (currentFileIsLive) startLiveTimer(seconds, liveDuration);
  }
}

app.on('before-quit', (e) => {
  if (currentHlsSessionId) { stopSession(currentHlsSessionId); currentHlsSessionId = null; }
  // Dismiss receiver if we ever connected — even if user already clicked Stop
  if (!lastDeviceHost && !castManager.getState().connected) {
    stopFileServer(); stopWSServer();
    return;
  }
  e.preventDefault();
  stopLiveTimer();
  castManager.disconnect().finally(() => {
    stopFileServer();
    stopWSServer();
    lastDeviceHost = null;
    app.exit(0);
  });
});

ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win-close',    () => app.quit());

ipcMain.handle('get-devices',    () => castManager.devices);

const QUEUE_FILE = path.join(app.getPath('userData'), 'casthub_queue.json');
ipcMain.handle('save-queue', (_, queue) => {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue)); console.log('[CastHub] Queue saved:', queue.length, 'items to', QUEUE_FILE); } catch(e) { console.error('[CastHub] Queue save error:', e.message); }
});
ipcMain.handle('load-queue', () => {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
});
ipcMain.handle('get-local-ip',   () => getLocalIP());
ipcMain.handle('get-cast-state', () => castManager.getState());

ipcMain.handle('soft-stop', async () => {
  try {
    savePosition(currentFilePath, getLiveTime(), liveDuration);
    stopLiveTimer(); stopPositionSave();
    if (currentHlsSessionId) { stopSession(currentHlsSessionId); currentHlsSessionId = null; }
    currentFilePath   = null;
    currentFileIsLive = false;
    livePausedAt      = null;
    await castManager.stopMedia();
    return { success: true };
  } catch(err) { return { success:false, error:err.message }; }
});

ipcMain.handle('disconnect', async () => {
  try {
    savePosition(currentFilePath, getLiveTime(), liveDuration);
    stopLiveTimer(); stopPositionSave();
    if (currentHlsSessionId) { stopSession(currentHlsSessionId); currentHlsSessionId = null; }
    currentFilePath   = null;
    currentFileIsLive = false;
    await castManager.disconnect();
    lastDeviceHost = null;
    const state = castManager.getState();
    mainWindow?.webContents.send('cast-state', state);
    broadcast({ type:'state', ...state });
    return { success: true };
  } catch(err) { return { success:false, error:err.message }; }
});

ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile','multiSelections'],
    filters: [{ name:'Video', extensions:['mp4','mkv','avi','mov','hevc','ts','m4v','wmv','flv','webm'] }]
  });
  return result.filePaths;
});

ipcMain.handle('get-position', (_, filePath) => getPositionFor(filePath));

ipcMain.handle('cast-file', async (_, { filePath, deviceHost, seekSeconds }) => {
  try {
    const url   = await buildCastURL(filePath, seekSeconds || 0);
    const title = path.basename(filePath);
    lastDeviceHost = deviceHost;
    // If receiver is already running, reloadURL skips TCP reconnect + receiver relaunch
    // Falls back to full castURL if reload fails (e.g. first cast, or after Stop)
    const alreadyConnected = castManager.getState().connected ||
                             (castManager.client != null);
    const opts = { duration: liveDuration, seekOffset: seekSeconds || 0 };
    isSeeking = true;
    try {
      if (alreadyConnected) {
        try { await castManager.reloadURL(url, title, opts); }
        catch { await castManager.castURL(deviceHost, url, title, opts); }
      } else {
        await castManager.castURL(deviceHost, url, title, opts);
      }
    } finally { isSeeking = false; }
    applyPendingSeek();
    startPositionSave();
    const state = castManager.getState();
    broadcast({ type:'state', ...state });
    mainWindow?.webContents.send('cast-state', state);
    return { success:true };
  } catch (err) { return { success:false, error:err.message }; }
});

ipcMain.handle('cast-control', async (_, { action, value }) => {
  try {
    // ── HLS session controls ──────────────────────────────────────────
    if (currentHlsSessionId && currentFilePath) {
      const st = castManager.getState();

      if (action === 'pause') {
        livePausedAt = getLiveTime();
        stopLiveTimer();
        savePosition(currentFilePath, livePausedAt, liveDuration);
        try { await castManager.control('pause'); }
        catch { await castManager.softStop(); } // fallback if native pause rejected
        const ps = { ...castManager.getState(), status:'paused',
                     currentTime:livePausedAt, duration:liveDuration, connected:true };
        mainWindow?.webContents.send('cast-state', ps);
        broadcast({ type:'state', ...ps });
        return { success: true };
      }

      if (action === 'play') {
        const resumeAt = livePausedAt !== null ? livePausedAt : getLiveTime();
        livePausedAt = null;
        await castManager.control('play');
        startLiveTimer(resumeAt, liveDuration);
        startPositionSave();
        const ns = { ...castManager.getState(), currentTime:resumeAt, duration:liveDuration };
        broadcast({ type:'state', ...ns });
        mainWindow?.webContents.send('cast-state', ns);
        return { success: true };
      }

      if (action === 'seek') {
        const seekTo = Math.floor(value);
        // If a cast/seek is already in-flight, queue this seek instead of racing with it
        if (isSeeking) { pendingHlsSeek = seekTo; return { success: true }; }
        savePosition(currentFilePath, getLiveTime(), liveDuration);
        livePausedAt = null;
        stopSession(currentHlsSessionId);
        const sessionId = generateSession(currentFilePath, seekTo);
        currentHlsSessionId = sessionId;
        const url = `http://${getLocalIP()}:8765/hls/${sessionId}/master.m3u8`;
        isSeeking = true;
        try {
          try { await castManager.reloadURL(url, st.title, { duration: liveDuration, seekOffset: seekTo }); }
          catch { await castManager.castURL(lastDeviceHost || st.deviceHost, url, st.title, { duration: liveDuration, seekOffset: seekTo }); }
        } finally { isSeeking = false; }
        applyPendingSeek();
        startLiveTimer(seekTo, liveDuration);
        const ns = { ...castManager.getState(), currentTime:seekTo, duration:liveDuration };
        broadcast({ type:'state', ...ns });
        mainWindow?.webContents.send('cast-state', ns);
        return { success: true };
      }
    }

    if (currentFileIsLive && currentFilePath) {
      const st = castManager.getState();

      if (action === 'pause') {
        livePausedAt = getLiveTime();
        stopLiveTimer();
        await castManager.softStop();
        const ps = { ...castManager.getState(), status:'paused',
                     currentTime:livePausedAt, duration:liveDuration, connected:true };
        mainWindow?.webContents.send('cast-state', ps);
        broadcast({ type:'state', ...ps });
        return { success: true };
      }

      if (action === 'play') {
        const resumeAt = livePausedAt !== null ? livePausedAt : getLiveTime();
        livePausedAt = null;
        const url = `http://${getLocalIP()}:8765/remux?path=${encodeURIComponent(currentFilePath)}&seek=${Math.floor(resumeAt)}`;
        try { await castManager.reloadURL(url, st.title); }
        catch { await castManager.castURL(st.deviceHost, url, st.title); }
        startLiveTimer(resumeAt, liveDuration);
        const ns = { ...castManager.getState(), currentTime:resumeAt, duration:liveDuration };
        broadcast({ type:'state', ...ns });
        mainWindow?.webContents.send('cast-state', ns);
        return { success: true };
      }

      if (action === 'seek') {
        const seekTo = Math.floor(value);
        livePausedAt = null;
        const url = `http://${getLocalIP()}:8765/remux?path=${encodeURIComponent(currentFilePath)}&seek=${seekTo}`;
        try { await castManager.reloadURL(url, st.title, { duration: liveDuration }); }
        catch { await castManager.castURL(st.deviceHost, url, st.title, { duration: liveDuration }); }
        startLiveTimer(seekTo, liveDuration);
        const ns = { ...castManager.getState(), currentTime:seekTo, duration:liveDuration };
        broadcast({ type:'state', ...ns });
        mainWindow?.webContents.send('cast-state', ns);
        return { success: true };
      }
    }
    if (action === 'stop') {
      if (currentHlsSessionId) { stopSession(currentHlsSessionId); currentHlsSessionId = null; }
      currentFilePath = null; currentFileIsLive = false; stopLiveTimer();
    }
    await castManager.control(action, value);
    const state = castManager.getState();
    broadcast({ type:'state', ...state });
    mainWindow?.webContents.send('cast-state', state);
    return { success:true };
  } catch (err) { return { success:false, error:err.message }; }
});
