const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('castHub', {
  openFile:     ()       => ipcRenderer.invoke('open-file'),
  getLocalIP:   ()       => ipcRenderer.invoke('get-local-ip'),
  castFile:     (params) => ipcRenderer.invoke('cast-file', params),
  castControl:  (params) => ipcRenderer.invoke('cast-control', params),
  getCastState: ()       => ipcRenderer.invoke('get-cast-state'),
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
  onDevicesUpdated: (cb) => ipcRenderer.on('devices-updated', (_, d) => cb(d)),
  onCastState:      (cb) => ipcRenderer.on('cast-state',      (_, s) => cb(s)),
});
