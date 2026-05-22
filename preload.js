const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('castHub', {
  openFile:     ()  => ipcRenderer.invoke('open-file'),
  getLocalIP:   ()  => ipcRenderer.invoke('get-local-ip'),
  getDevices:   ()  => ipcRenderer.invoke('get-devices'),
  castFile:     (p) => ipcRenderer.invoke('cast-file', p),
  castControl:  (p) => ipcRenderer.invoke('cast-control', p),
  getCastState:  ()  => ipcRenderer.invoke('get-cast-state'),
  disconnect:    ()  => ipcRenderer.invoke('disconnect'),
  softStop:      ()  => ipcRenderer.invoke('soft-stop'),
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
  probeFile:  (p) => ipcRenderer.invoke('probe-file', p),
  saveQueue: (q) => ipcRenderer.invoke('save-queue', q),
  loadQueue: ()  => ipcRenderer.invoke('load-queue'),
  onDevicesUpdated: (cb) => ipcRenderer.on('devices-updated', (_, d) => cb(d)),
  onCastState:      (cb) => ipcRenderer.on('cast-state',      (_, s) => cb(s)),
});
