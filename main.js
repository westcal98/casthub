const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { startFileServer, stopFileServer, getLocalIP, browseDirectory, getStreamInfo, TRANSCODE_EXTS } = require('./server/fileServer');
const { startWSServer, stopWSServer, broadcast, onMobileCommand, onBrowseRequest, setStateGetter } = require('./server/wsServer');
const CastManager = require('./server/cast');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'NetworkServiceInProcess');

let mainWindow;
const castManager = new CastManager();

// Broadcast state to renderer + mobile whenever cast state changes
castManager._onStateChange = (state) => {
  mainWindow?.webContents.send('cast-state', state);
  broadcast({ type: 'state', ...state });
};

// Broadcast state to renderer + mobile whenever cast state changes
castManager._onStateChange = (state) => {
  mainWindow?.webContents.send('cast-state', state);
  broadcast({ type: 'state', ...state });
};
let currentHLSSession = null;
let currentFilePath   = null;
let currentFileIsLive = false;

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
      } else if (cmd.action === 'seek' && currentHLSSession) {
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
    const { hasEAC3, hasSSA } = await getStreamInfo(filePath);
    if (hasEAC3 || hasSSA) {
      console.log(`[CastHub] Needs remux — EAC3: ${hasEAC3}, SSA: ${hasSSA}`);
      currentFileIsLive = true;
      return `http://${getLocalIP()}:8765/remux?path=${encodeURIComponent(filePath)}&seek=${seek}`;
    }
  }
  currentFileIsLive = false;
  return `http://${getLocalIP()}:8765/transcode?path=${encodeURIComponent(filePath)}`;
}

async function handleTSSeek(seconds) {
  if (!currentFilePath) return;
  const url = `http://${getLocalIP()}:8765/transcode?path=${encodeURIComponent(currentFilePath)}&seek=${Math.floor(seconds)}`;
  const state = castManager.getState();
  await castManager.castURL(state.deviceHost, url, state.title);
}

app.on('before-quit', () => {
  if (currentHLSSession) { stopSession(currentHLSSession); currentHLSSession = null; }
  try { castManager.control('stop'); } catch {}
  stopFileServer(); stopWSServer();
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

ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile','multiSelections'],
    filters: [{ name:'Video', extensions:['mp4','mkv','avi','mov','hevc','ts','m4v','wmv','flv','webm'] }]
  });
  return result.filePaths;
});

ipcMain.handle('cast-file', async (_, { filePath, deviceHost }) => {
  try {
    const url = await buildCastURL(filePath, 0);
    await castManager.castURL(deviceHost, url, path.basename(filePath));
    const state = castManager.getState();
    broadcast({ type:'state', ...state });
    mainWindow?.webContents.send('cast-state', state);
    return { success:true };
  } catch (err) { return { success:false, error:err.message }; }
});

ipcMain.handle('cast-control', async (_, { action, value }) => {
  try {
    if (action === 'seek' && currentFileIsLive && currentFilePath) {
      const url = `http://${getLocalIP()}:8765/remux?path=${encodeURIComponent(currentFilePath)}&seek=${Math.floor(value)}`;
      const state = castManager.getState();
      await castManager.castURL(state.deviceHost, url, state.title);
      const ns = castManager.getState();
      broadcast({ type:'state', ...ns });
      mainWindow?.webContents.send('cast-state', ns);
      return { success: true };
    }
    if (action === 'stop') { currentFilePath = null; currentFileIsLive = false; }
    await castManager.control(action, value);
    const state = castManager.getState();
    broadcast({ type:'state', ...state });
    mainWindow?.webContents.send('cast-state', state);
    return { success:true };
  } catch (err) { return { success:false, error:err.message }; }
});
