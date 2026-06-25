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
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    save: (provider) => ipcRenderer.invoke('providers:save', provider),
    delete: (id) => ipcRenderer.invoke('providers:delete', id),
  },
  openclaw: {
    readConfig: () => ipcRenderer.invoke('openclaw:read-config'),
    listProviders: () => ipcRenderer.invoke('openclaw:list-providers'),
    upsertProvider: (provider) => ipcRenderer.invoke('openclaw:upsert-provider', provider),
    deleteProvider: (id) => ipcRenderer.invoke('openclaw:delete-provider', id),
    listAgents: () => ipcRenderer.invoke('openclaw:list-agents'),
    createAgent: (agent) => ipcRenderer.invoke('openclaw:create-agent', agent),
    updateAgent: (id, updates) => ipcRenderer.invoke('openclaw:update-agent', id, updates),
    deleteAgent: (id) => ipcRenderer.invoke('openclaw:delete-agent', id),
    setAgentModel: (agentId, model, fallbacks) => ipcRenderer.invoke('agent:set-model', { agentId, model, fallbacks }),
    // v3.1.36: wake-phrase training pipeline. Phone records
    // samples locally, sends paths to desktop, desktop trains
    // via openWakeWord Python + RTX 2070, streams progress
    // events back via 'wake-training-progress' channel.
    trainWakePhrase: (agentId, phrase, samplePaths) =>
      ipcRenderer.invoke('agent:train-wake-phrase', { agentId, phrase, samplePaths }),
    readWakeModel: (tflitePath) =>
      ipcRenderer.invoke('agent:read-wake-model', { tflitePath }),
  },
  // v3.1.33: user-managed LLM endpoints. Each endpoint is
  // an OpenAI-compatible HTTP server (Ollama, LM Studio,
  // llama.cpp server, Jan.ai, vLLM, etc.) that exposes
  // /v1/models + /v1/chat/completions. CyberClaw probes
  // the endpoint to discover its available models.
  llm: {
    endpoints: {
      list: () => ipcRenderer.invoke('llm:endpoints:list'),
      add: (ep) => ipcRenderer.invoke('llm:endpoints:add', ep),
      delete: (id) => ipcRenderer.invoke('llm:endpoints:delete', id),
      probe: (id) => ipcRenderer.invoke('llm:endpoints:probe', id),
      detectOllama: () => ipcRenderer.invoke('llm:endpoints:detect-ollama'),
    },
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
