const { app, BrowserWindow, ipcMain, dialog, Menu, Tray } = require('electron');
const path = require('path');
const { startFileServer, stopFileServer, getLocalIP } = require('./server/fileServer');
const { startWSServer, stopWSServer, broadcast, onMobileCommand } = require('./server/wsServer');
const CastManager = require('./server/cast');

let mainWindow;
const castManager = new CastManager();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 660,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: '#09090f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('src/index.html');

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

app.whenReady().then(async () => {
  await startFileServer();
  startWSServer();
  createWindow();

  castManager.startDiscovery((devices) => {
    mainWindow?.webContents.send('devices-updated', devices);
    broadcast({ type: 'devices', devices });
  });

  // Handle mobile commands (controls + file casting from phone)
  onMobileCommand(async (cmd) => {
    try {
      if (cmd.action === 'cast') {
        const ip = getLocalIP();
        const url = `http://${ip}:8765/file?path=${encodeURIComponent(cmd.filePath)}`;
        const state = castManager.getState();
        await castManager.castURL(state.deviceHost, url, path.basename(cmd.filePath));
      } else {
        await castManager.control(cmd.action, cmd.value);
      }
      const state = castManager.getState();
      broadcast({ type: 'state', ...state });
      mainWindow?.webContents.send('cast-state', state);
    } catch (err) {
      broadcast({ type: 'error', message: err.message });
    }
  });
});

app.on('before-quit', () => {
  stopFileServer();
  stopWSServer();
});

// Window controls
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win-close',    () => mainWindow?.hide());

// File picker
ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mp4','mkv','avi','mov','hevc','ts','m4v','wmv','flv','webm'] }]
  });
  return result.filePaths;
});

ipcMain.handle('get-local-ip', () => getLocalIP());

ipcMain.handle('cast-file', async (_, { filePath, deviceHost }) => {
  try {
    const ip = getLocalIP();
    const url = `http://${ip}:8765/file?path=${encodeURIComponent(filePath)}`;
    await castManager.castURL(deviceHost, url, path.basename(filePath));
    const state = castManager.getState();
    broadcast({ type: 'state', ...state });
    mainWindow?.webContents.send('cast-state', state);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('cast-control', async (_, { action, value }) => {
  try {
    await castManager.control(action, value);
    const state = castManager.getState();
    broadcast({ type: 'state', ...state });
    mainWindow?.webContents.send('cast-state', state);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-cast-state', () => castManager.getState());
