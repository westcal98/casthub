const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { startFileServer, stopFileServer, getLocalIP, browseDirectory, getStreamInfo, TRANSCODE_EXTS, generateSession, stopSession, startSegmentSession, stopSegmentSession, stopAllSegmentSessions } = require('./server/fileServer');
const { startWSServer, stopWSServer, broadcast, onMobileCommand, onBrowseRequest, setStateGetter } = require('./server/wsServer');
const CastManager = require('./server/cast');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'NetworkServiceInProcess');

let mainWindow;
const castManager = new CastManager();

// Broadcast state to renderer + mobile whenever cast state changes

// Broadcast state to renderer + mobile whenever cast state changes
castManager._onStateChange = (state) => {
  if (currentSessionId && state.segmentIndex != null) {
    // Segmented sessions: adjust currentTime by segment offset so the UI shows absolute position
    state = { ...state,
      currentTime: currentSeekOffset + state.segmentIndex * 10 + state.currentTime,
      duration:    liveDuration || state.duration };
  } else if (currentFileIsLive) {
    // LIVE remux: Chromecast reports currentTime:0 — use local timer instead
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
let currentSessionId   = null;   // active segmented MKV session
let currentHlsSessionId = null;  // active HLS session
let currentSeekOffset  = 0;      // seek position the current session started from
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width:960, height:660, minWidth:760, minHeight:520,
    frame:false, backgroundColor:'#09090f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation:true, nodeIntegration:false }
  });
  mainWindow.loadFile('src/index.html');
}

app.whenReady().then(async () => {
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
      } else if (cmd.action === 'seek' && (currentFileIsLive || currentSessionId || currentHlsSessionId)) {
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
      if (currentSessionId)    { stopSegmentSession(currentSessionId); currentSessionId = null; }
      const sessionId = generateSession(filePath, seek);
      currentHlsSessionId = sessionId;
      currentSeekOffset   = seek;
      currentFileIsLive   = true;
      if (duration) liveDuration = duration;
      startLiveTimer(seek, duration);
      return `http://${getLocalIP()}:8765/hls/${sessionId}/master.m3u8`;
    }
  }
  if (currentHlsSessionId) { stopSession(currentHlsSessionId); currentHlsSessionId = null; }
  currentFileIsLive = false;
  currentSessionId  = null;
  currentSeekOffset = 0;
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
    try { await castManager.reloadURL(url, state.title, { duration: liveDuration }); }
    catch { await castManager.castURL(state.deviceHost, url, state.title, { duration: liveDuration }); }
    startLiveTimer(seekTo, liveDuration);
  } else if (currentSessionId) {
    const { sessionId, firstSegmentUrl } = await startSegmentSession(currentFilePath, seekTo);
    currentSessionId  = sessionId;
    currentSeekOffset = seekTo;
    try { await castManager.reloadURL(firstSegmentUrl, state.title, { duration: liveDuration }); }
    catch { await castManager.castURL(state.deviceHost, firstSegmentUrl, state.title, { duration: liveDuration }); }
  } else {
    const url = `http://${getLocalIP()}:8765/remux?path=${encodeURIComponent(currentFilePath)}&seek=${seekTo}`;
    await castManager.castURL(state.deviceHost, url, state.title, { duration: liveDuration });
    if (currentFileIsLive) startLiveTimer(seconds, liveDuration);
  }
}

app.on('before-quit', (e) => {
  stopAllSegmentSessions();
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
    stopLiveTimer();
    if (currentSessionId)    { stopSegmentSession(currentSessionId); currentSessionId = null; }
    if (currentHlsSessionId) { stopSession(currentHlsSessionId); currentHlsSessionId = null; }
    currentFilePath   = null;
    currentFileIsLive = false;
    currentSeekOffset = 0;
    livePausedAt      = null;
    await castManager.stopMedia();
    return { success: true };
  } catch(err) { return { success:false, error:err.message }; }
});

ipcMain.handle('disconnect', async () => {
  try {
    stopLiveTimer();
    if (currentSessionId)    { stopSegmentSession(currentSessionId); currentSessionId = null; }
    if (currentHlsSessionId) { stopSession(currentHlsSessionId); currentHlsSessionId = null; }
    currentFilePath   = null;
    currentFileIsLive = false;
    currentSeekOffset = 0;
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

ipcMain.handle('cast-file', async (_, { filePath, deviceHost }) => {
  try {
    const url   = await buildCastURL(filePath, 0);
    const title = path.basename(filePath);
    lastDeviceHost = deviceHost;
    // If receiver is already running, reloadURL skips TCP reconnect + receiver relaunch
    // Falls back to full castURL if reload fails (e.g. first cast, or after Stop)
    const alreadyConnected = castManager.getState().connected ||
                             (castManager.client != null);
    const opts = { duration: liveDuration };
    if (alreadyConnected) {
      try {
        await castManager.reloadURL(url, title, opts);
      } catch {
        await castManager.castURL(deviceHost, url, title, opts);
      }
    } else {
      await castManager.castURL(deviceHost, url, title, opts);
    }
    const state = castManager.getState();
    broadcast({ type:'state', ...state });
    mainWindow?.webContents.send('cast-state', state);
    return { success:true };
  } catch (err) { return { success:false, error:err.message }; }
});

ipcMain.handle('cast-control', async (_, { action, value }) => {
  try {
    // ── Segmented session seek ─────────────────────────────────────
    if (currentSessionId && currentFilePath && action === 'seek') {
      const seekTo = Math.floor(value);
      const st     = castManager.getState();
      const { sessionId, firstSegmentUrl } = await startSegmentSession(currentFilePath, seekTo);
      currentSessionId  = sessionId;
      currentSeekOffset = seekTo;
      try { await castManager.reloadURL(firstSegmentUrl, st.title, { duration: liveDuration }); }
      catch { await castManager.castURL(st.deviceHost, firstSegmentUrl, st.title, { duration: liveDuration }); }
      const ns = { ...castManager.getState() };
      broadcast({ type:'state', ...ns });
      mainWindow?.webContents.send('cast-state', ns);
      return { success: true };
    }

    // ── HLS session controls ──────────────────────────────────────────
    if (currentHlsSessionId && currentFilePath) {
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
        stopSession(currentHlsSessionId);
        const sessionId = generateSession(currentFilePath, Math.floor(resumeAt));
        currentHlsSessionId = sessionId;
        const url = `http://${getLocalIP()}:8765/hls/${sessionId}/master.m3u8`;
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
        stopSession(currentHlsSessionId);
        const sessionId = generateSession(currentFilePath, seekTo);
        currentHlsSessionId = sessionId;
        const url = `http://${getLocalIP()}:8765/hls/${sessionId}/master.m3u8`;
        try { await castManager.reloadURL(url, st.title, { duration: liveDuration }); }
        catch { await castManager.castURL(st.deviceHost, url, st.title, { duration: liveDuration }); }
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
      if (currentSessionId)    { stopSegmentSession(currentSessionId); currentSessionId = null; }
      if (currentHlsSessionId) { stopSession(currentHlsSessionId); currentHlsSessionId = null; }
      currentFilePath = null; currentFileIsLive = false; currentSeekOffset = 0; stopLiveTimer();
    }
    await castManager.control(action, value);
    const state = castManager.getState();
    broadcast({ type:'state', ...state });
    mainWindow?.webContents.send('cast-state', state);
    return { success:true };
  } catch (err) { return { success:false, error:err.message }; }
});
