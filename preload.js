// Tells the BillTrix page it is running inside the Windows app, and lets the offline page retry.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('billtrixDesktop', {
  isDesktop: true,
  platform: process.platform,
  restartAgent: () => ipcRenderer.invoke('bt:agent-restart'),
  retry: () => ipcRenderer.invoke('bt:retry'),
});
