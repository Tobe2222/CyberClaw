const { ipcRenderer } = require('electron');

// Expose API on window for renderer scripts
window.cyberclaw = {
  terminal: {
    spawn: (opts) => ipcRenderer.invoke('terminal:spawn', opts),
    onData: (cb) => ipcRenderer.on('terminal:data', (_, data) => cb(data)),
    onExit: (cb) => ipcRenderer.on('terminal:exit', (_, code) => cb(code)),
    write: (data) => ipcRenderer.send('terminal:input', data),
    resize: (cols, rows) => ipcRenderer.send('terminal:resize', { cols, rows }),
  },
  chat: {
    spawn: (opts) => ipcRenderer.invoke('chat:spawn', opts),
    onData: (cb) => ipcRenderer.on('chat:data', (_, data) => cb(data)),
    write: (data) => ipcRenderer.send('chat:input', data),
    resize: (cols, rows) => ipcRenderer.send('chat:resize', { cols, rows }),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  agents: {
    discover: () => ipcRenderer.invoke('openclaw:discover'),
  },
};
