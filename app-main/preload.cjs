// preload.cjs
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webstack', {

  openSite: (siteId) => {
    return ipcRenderer.invoke('open-site', siteId);
  },

  registerTab: (tabInfo) => {
    ipcRenderer.send('register-tab', tabInfo);
  }
});

// Report network status to main process so menu can show Online / Offline
window.addEventListener('online', () => {
  ipcRenderer.send('online-status-changed', navigator.onLine);
});

window.addEventListener('offline', () => {
  ipcRenderer.send('online-status-changed', navigator.onLine);
});

// Send initial status once preload runs
ipcRenderer.send('online-status-changed', navigator.onLine);
