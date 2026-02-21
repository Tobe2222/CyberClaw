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
  wizard: {
    check: (what) => ipcRenderer.invoke('wizard:check', what),
    install: (pkg) => ipcRenderer.invoke('wizard:install', pkg),
    run: (cmd) => ipcRenderer.invoke('wizard:run', cmd),
    saveApiKey: (key) => ipcRenderer.invoke('wizard:save-apikey', key),
    createAgent: (opts) => ipcRenderer.invoke('wizard:create-agent', opts),
    configureChannel: (opts) => ipcRenderer.invoke('wizard:configure-channel', opts),
    startGateway: () => ipcRenderer.invoke('wizard:start-gateway'),
    launch: () => ipcRenderer.invoke('wizard:launch'),
  },
};
