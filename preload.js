// Tells the BillTrix page it is running inside the Windows app; print helper, offline retry and the shop Hub.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('billtrixDesktop', {
  isDesktop: true,
  platform: process.platform,
  restartAgent: () => ipcRenderer.invoke('bt:agent-restart'),
  retry: () => ipcRenderer.invoke('bt:retry'),
  hubStatus: () => ipcRenderer.invoke('bt:hub-status'),
  hubEnable: (a) => ipcRenderer.invoke('bt:hub-enable', a),
  hubDisable: (a) => ipcRenderer.invoke('bt:hub-disable', a),
  setServer: (u) => ipcRenderer.invoke('bt:set-server', u),
});
