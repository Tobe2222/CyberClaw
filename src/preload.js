const { ipcRenderer } = require('electron');

// Expose ipcRenderer directly to window for use in renderer
window.ipcRenderer = ipcRenderer;

// Expose API on window for renderer scripts
window.cyberclaw = {
  // Listener for OpenClaw-session-tailing chat messages.
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
  // Screenshot.
  screenshot: ({ target, windowName } = {}) =>
    ipcRenderer.invoke('screenshot:capture', { target, windowName }),
  chat: {
    // Accept optional attachments array for multimodal (text + image) content.
    sendMessage: (agentId, message, attachments) => ipcRenderer.invoke('chat:send-message', { agentId, message, attachments }),
    saveAttachment: (data, mimeType, fileName) => ipcRenderer.invoke('chat:save-attachment', { data, mimeType, fileName }),
    // Silent variant of sendMessage.
    sendSilentMessage: (agentId, message) => ipcRenderer.invoke('chat:send-message', { agentId, message, attachments: null, silent: true }),
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
    // v3.4.5: companion export / import bundles
    pickCompanionFolder: (purpose) => ipcRenderer.invoke('companions:pick-folder', purpose),
    exportCompanions: (ids, dir) => ipcRenderer.invoke('companions:export', ids, dir),
    importCompanions: (dir) => ipcRenderer.invoke('companions:import', dir),
    saveSpriteConfig: (agentId, config) => ipcRenderer.invoke('companion:save-sprite', agentId, config),
    saveAvatar: (agentId, dataUrl) => ipcRenderer.invoke('companion:save-avatar', agentId, dataUrl),
    listSkills: () => ipcRenderer.invoke('openclaw:list-skills'),
    addXP: (agentId, skill, amount) => ipcRenderer.invoke('companion:add-xp', agentId, skill, amount),
    // Companion soul + memory.
    getSoul: (agentId) => ipcRenderer.invoke('companion:get-soul', agentId),
    saveSoul: (agentId, content) => ipcRenderer.invoke('companion:save-soul', agentId, content),
    applySoulPreset: (agentId, presetKey) => ipcRenderer.invoke('companion:apply-soul-preset', agentId, presetKey),
    getMemory: (agentId) => ipcRenderer.invoke('companion:get-memory', agentId),
    rememberMemory: (agentId, line) => ipcRenderer.invoke('companion:remember-memory', agentId, line),
    clearMemory: (agentId) => ipcRenderer.invoke('companion:clear-memory', agentId),
    // v3.3.0: per-companion enabled-skills toggles
    getEnabledSkills: (agentId) => ipcRenderer.invoke('companion:get-enabled-skills', agentId),
    setEnabledSkills: (agentId, skillIds) => ipcRenderer.invoke('companion:set-enabled-skills', agentId, skillIds),
  },
  // v3.3.0: user-managed Skill library — browse, create, edit,
  // delete process-specific skill markdown files.
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    read: (skillId) => ipcRenderer.invoke('skills:read', skillId),
    create: (payload) => ipcRenderer.invoke('skills:create', payload),
    update: (skillId, payload) => ipcRenderer.invoke('skills:update', skillId, payload),
    delete: (skillId) => ipcRenderer.invoke('skills:delete', skillId),
    seedStarters: () => ipcRenderer.invoke('skills:seed-starters'),
  },
  system: {
    // v3.2.32: overarching CYBERCLAW.md prompt shared by
    // all companions. User-editable; "reset" deletes the
    // file so the next read returns the default.
    getCyberclaw: () => ipcRenderer.invoke('system:get-cyberclaw'),
    saveCyberclaw: (content) => ipcRenderer.invoke('system:save-cyberclaw', content),
    resetCyberclaw: () => ipcRenderer.invoke('system:reset-cyberclaw'),
  },
  doctorWindow: {
    close: () => ipcRenderer.send('doctor:close'),
  },
  arena: {
    popout: (state) => ipcRenderer.invoke('arena:popout', state),
  },
  // v3.5.0: user-editable paths
  voice: { status: () => ipcRenderer.invoke('voice:status'), install: () => ipcRenderer.invoke('voice:install'), setModel: (t) => ipcRenderer.invoke('voice:set-model', t) },
  paths: {
    get: () => ipcRenderer.invoke('paths:get'),
    set: (patch) => ipcRenderer.invoke('paths:set', patch),
    pick: (title) => ipcRenderer.invoke('paths:pick', title),
  },
  quests: {
    readQuestMemory: (id) => ipcRenderer.invoke('quests:read-quest-memory', id),
    writeQuestSummary: (id, text) => ipcRenderer.invoke('quests:write-summary', id, text),
    appendQuestDecision: (id, text) => ipcRenderer.invoke('quests:append-decision', id, text),
    list: () => ipcRenderer.invoke('quests:list'),
    create: (quest) => ipcRenderer.invoke('quests:create', quest),
    update: (id, updates) => ipcRenderer.invoke('quests:update', id, updates),
    delete: (id) => ipcRenderer.invoke('quests:delete', id),
    pickDirectory: () => ipcRenderer.invoke('quests:pick-directory'),
    detectVersion: (dir) => ipcRenderer.invoke('quests:detect-version', dir),
    scanProjects: () => ipcRenderer.invoke('quests:scan-projects'),
    autoDetect: () => ipcRenderer.invoke('quests:auto-detect'),
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
    // Per-quest project instructions file.
    readQuestInstructions: (id) => ipcRenderer.invoke('quests:read-quest-instructions', id),
    saveQuestInstructions: (id, content) => ipcRenderer.invoke('quests:save-quest-instructions', id, content),
    // Companion-side note append.
    appendQuestInstructions: (id, text) => ipcRenderer.invoke('quests:append-quest-instructions', id, text),
    // Per-quest conversation log IPCs.
    appendConversationLog: (id, role, text, agentId, agentName) => ipcRenderer.invoke('quests:append-conversation-log', id, role, text, agentId, agentName),
    getConversationLog: (id) => ipcRenderer.invoke('quests:get-conversation-log', id),
    clearConversationLog: (id) => ipcRenderer.invoke('quests:clear-conversation-log', id),
    // v3.4.4: raw quest/CONVERSATION.md — hydrates the quest chat view.
    getConversationFile: (id) => ipcRenderer.invoke('quests:get-conversation-file', id),
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
    // Wake-phrase training pipeline.
    trainWakePhrase: (agentId, phrase, samples) =>
      ipcRenderer.invoke('agent:train-wake-phrase', { agentId, phrase, samples }),
    readWakeModel: (tflitePath) =>
      ipcRenderer.invoke('agent:read-wake-model', { tflitePath }),
  },
  // User-managed LLM endpoints.
  llm: {
    endpoints: {
      list: () => ipcRenderer.invoke('llm:endpoints:list'),
      add: (ep) => ipcRenderer.invoke('llm:endpoints:add', ep),
      delete: (id) => ipcRenderer.invoke('llm:endpoints:delete', id),
      probe: (id) => ipcRenderer.invoke('llm:endpoints:probe', id),
      detectOllama: () => ipcRenderer.invoke('llm:endpoints:detect-ollama'),
    },
    ollama: {
      status: (model) => ipcRenderer.invoke('llm:ollama-status', { model }),
      warm: (model) => ipcRenderer.invoke('llm:ollama-warm', { model }),
      unload: (model) => ipcRenderer.invoke('llm:ollama-unload', { model }),
      start: () => ipcRenderer.invoke('llm:ollama-start'),
      resolveLocal: (model) => ipcRenderer.invoke('llm:resolve-local', { model }),
      probeAllLocal: () => ipcRenderer.invoke('llm:probe-all-local'),
      // v3.3.5: mobile-initiated actions. The phone can trigger
      // warm/unload/start via this RPC; the desktop runs the
      // action and re-broadcasts the new status.
      action: (model, action) => ipcRenderer.invoke('llm:ollama-action', { model, action }),
    },
  },
  // v3.3.5: desktop → mobile broadcast helpers. The renderer
  // calls these when local-LLM pill state changes, so the phone
  // sees the same status without re-querying.
  sync: {
    broadcastLlmStatus: (status) => ipcRenderer.invoke('sync-broadcast-llm-status', status),
  },
  wizard: {
    check: (what) => ipcRenderer.invoke('wizard:check', what),
    // Scan a user-picked directory.
    scanDirectory: (dir) => ipcRenderer.invoke('wizard:scan-directory', dir),
    // v3.3.37: scan a user-chosen parent directory for
    // project subdirectories. Used by the wizard's
    // "Default directory" feature on the import steps.
    scanProjectsDir: (dir) => ipcRenderer.invoke('wizard:scan-projects-dir', dir),
    install: (pkg) => ipcRenderer.invoke('wizard:install', pkg),
    run: (cmd) => ipcRenderer.invoke('wizard:run', cmd),
    saveApiKey: (key) => ipcRenderer.invoke('wizard:save-apikey', key),
    createAgent: (opts) => ipcRenderer.invoke('wizard:create-agent', opts),
    configureChannel: (opts) => ipcRenderer.invoke('wizard:configure-channel', opts),
    startGateway: () => ipcRenderer.invoke('wizard:start-gateway'),
    launch: () => ipcRenderer.invoke('wizard:launch'),
    listOpenclawAgents: () => ipcRenderer.invoke('wizard:list-openclaw-agents'),
    getVersion: () => ipcRenderer.invoke('wizard:get-version'),
  },
};
