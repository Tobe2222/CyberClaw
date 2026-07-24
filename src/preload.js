const { ipcRenderer } = require('electron');

// Expose ipcRenderer directly to window for use in renderer
window.ipcRenderer = ipcRenderer;

// Expose API on window for renderer scripts
window.cyberclaw = {
  // v3.2.21: listener for OpenClaw-session-tailing chat
  // messages. The main process watches the OpenClaw
  // session JSONL files for Discord-routed agent runs
  // and pushes the assistant replies here so the
  // renderer's chat history stays in sync. The handler
  // in app.js (around line 2xxx — see comment on
  // openclaw-session-tail.js) adds the message to
  // chatHistoryByAgent + chatHistory so it's visible
  // on subsequent request_chat_history pulls.
  onSessionChatMessage: (cb) =>
    ipcRenderer.on('openclaw-session-chat-message', (_, payload) => cb(payload)),
  onSessionTyping: (cb) =>
    ipcRenderer.on('openclaw-session-typing', (_, payload) => cb(payload)),
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
    // v3.1.50: active-quest management. The "active" quest is the
    // one the companion is currently working on. Exactly one is
    // active at a time; passing null to setActive clears all.
    setActive: (id) => ipcRenderer.invoke('quests:set-active', id),
    getActive: () => ipcRenderer.invoke('quests:get-active'),
    // v3.1.50: append a change to the active quest's journal.
    // Called by the agent (via the renderer's structured-output
    // parser) when it does something worth logging.
    appendChange: (id, text) => ipcRenderer.invoke('quests:append-change', id, text),
    // v3.1.50: toggle a goal's completed flag by index. Returns
    // the updated quest or null if the id/index is invalid.
    markGoalDone: (id, goalIndex, completed) => ipcRenderer.invoke('quests:mark-goal-done', id, goalIndex, completed),
    // v3.2.30: per-quest project instructions file. Read/write the
    // markdown file associated with a quest (default:
    // <quest.directory>/INSTRUCTIONS.md). The file content
    // is injected into the chat prompt as a per-quest
    // "project instructions" context block, so the LLM sees
    // project-specific instructions before generating
    // a reply. Read returns { ok, content, path }.
    readProjectInstructions: (id) => ipcRenderer.invoke('quests:read-project-instructions', id),
    saveProjectInstructions: (id, content) => ipcRenderer.invoke('quests:save-project-instructions', id, content),
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
    // samples locally and ships the base64-encoded audio
    // (NOT paths — the desktop can't reach the phone's
    // filesystem). The desktop decodes them and runs
    // openWakeWord training on the RTX 2070, streaming
    // progress events back via 'wake-training-progress'.
    trainWakePhrase: (agentId, phrase, samples) =>
      ipcRenderer.invoke('agent:train-wake-phrase', { agentId, phrase, samples }),
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
