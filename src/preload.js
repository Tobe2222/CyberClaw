const { ipcRenderer } = require('electron');

// Expose ipcRenderer directly to window for use in renderer
window.ipcRenderer = ipcRenderer;

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
    sendMessage: (agentId, message) => ipcRenderer.invoke('chat:send-message', { agentId, message }),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    openExternal: (url) => ipcRenderer.send('window:open-external', url),
  },
  agents: {
    discover: () => ipcRenderer.invoke('openclaw:discover'),
    systemInfo: () => ipcRenderer.invoke('openclaw:system-info'),
    openDoctor: () => ipcRenderer.invoke('openclaw:doctor'),
    getStats: (agentId) => ipcRenderer.invoke('companion:stats', agentId),
    getSpriteConfig: (agentId) => ipcRenderer.invoke('companion:get-sprite', agentId),
    saveSpriteConfig: (agentId, config) => ipcRenderer.invoke('companion:save-sprite', agentId, config),
    saveAvatar: (agentId, dataUrl) => ipcRenderer.invoke('companion:save-avatar', agentId, dataUrl),
    listSkills: () => ipcRenderer.invoke('openclaw:list-skills'),
    addXP: (agentId, skill, amount) => ipcRenderer.invoke('companion:add-xp', agentId, skill, amount),
  },
  doctorWindow: {
    close: () => ipcRenderer.send('doctor:close'),
  },
  arena: {
    popout: (state) => ipcRenderer.invoke('arena:popout', state),
  },
  quests: {
    list: () => ipcRenderer.invoke('quests:list'),
    create: (quest) => ipcRenderer.invoke('quests:create', quest),
    update: (id, updates) => ipcRenderer.invoke('quests:update', id, updates),
    delete: (id) => ipcRenderer.invoke('quests:delete', id),
    pickDirectory: () => ipcRenderer.invoke('quests:pick-directory'),
    detectVersion: (dir) => ipcRenderer.invoke('quests:detect-version', dir),
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
