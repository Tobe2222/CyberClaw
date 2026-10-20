/** CyberClaw Sync Server Secure WebSocket server (WSS) for mobile companion app sync. */

const WebSocket = require('ws');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const EventEmitter = require('events');

const CYBERCLAW_DIR = path.join(os.homedir(), '.openclaw', 'cyberclaw');
const SYNC_CONFIG_FILE = path.join(CYBERCLAW_DIR, 'sync-config.json');
const CERT_DIR = path.join(CYBERCLAW_DIR, 'certs');
const CERT_FILE = path.join(CERT_DIR, 'sync-cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'sync-key.pem');

class SyncServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 9247;
    this.wss = null;
    this.httpsServer = null;
    this.clients = new Map();  // ws → { id, name, authenticated }
    this.pairingCode = null;
    this.pairingExpiry = 0;
    this.mainWindow = options.mainWindow || null;
    this.onChatMessage = options.onChatMessage || null;
    this.onVoiceTranscript = options.onVoiceTranscript || null;
    this.onAudioInput = options.onAudioInput || null;
    // Per-agent chat history.
    this.onRequestAgentHistory = options.onRequestAgentHistory || null;
    // Image / file attachment upload handler.
    this.onAttachment = options.onAttachment || null;

    // Wire the four missing mobile-side callbacks (onMobileWakeAgent, onMobileActivityPing, onArenaTreatPlaced, onArenaTreatEaten) onto `this`.
    this.onMobileWakeAgent = options.onMobileWakeAgent || null;
    this.onMobileActivityPing = options.onMobileActivityPing || null;
    this.onArenaTreatPlaced = options.onArenaTreatPlaced || null;
    this.onArenaTreatEaten = options.onArenaTreatEaten || null;

    // Quest-related callbacks.
    this.onSetQuestActive = options.onSetQuestActive || null;
    this.onUpdateQuest = options.onUpdateQuest || null;
    this.onDeleteQuest = options.onDeleteQuest || null;
    this.onMarkQuestGoalDone = options.onMarkQuestGoalDone || null;
    this.onCreateQuest = options.onCreateQuest || null;
    this.onListQuests = options.onListQuests || null;
    this.onRequestQuestsList = options.onRequestQuestsList || null;
    // TTS voice picker mirror.
    this.onGetTtsSettings = options.onGetTtsSettings || null;
    this.onSetTtsVoice = options.onSetTtsVoice || null;
    // Same bug class as onRequestAgentHistory above.
    this.onRequestChatHistory = options.onRequestChatHistory || null;
    // Per-quest project instructions file read.
    this.onReadQuestInstructions = options.onReadQuestInstructions || null;
    // Write counterpart for the read above.
    this.onSaveQuestInstructions = options.onSaveQuestInstructions || null;
    // Phone-side companion edit.
    this.onListSkills = options.onListSkills || null;
    this.onReadSkill = options.onReadSkill || null;
    this.onCreateSkill = options.onCreateSkill || null;
    this.onUpdateSkill = options.onUpdateSkill || null;
    this.onDeleteSkill = options.onDeleteSkill || null;
    this.onSeedStarterSkills = options.onSeedStarterSkills || null;
    this.onGetEnabledSkills = options.onGetEnabledSkills || null;
    this.onSetEnabledSkills = options.onSetEnabledSkills || null;
    this.onSaveSpriteConfig = options.onSaveSpriteConfig || null;
    // Companion soul + memory read/clear from mobile.
    this.onReadCompanionSoul = options.onReadCompanionSoul || null;
    this.onReadCompanionMemory = options.onReadCompanionMemory || null;
    this.onClearCompanionMemory = options.onClearCompanionMemory || null;

    // Per-quest conversation log access from mobile.
    this.onGetQuestConversationLog = options.onGetQuestConversationLog || null;
    this.onGetQuestConversationFile = options.onGetQuestConversationFile || null;
    this.onClearQuestConversationLog = options.onClearQuestConversationLog || null;

    // CYBERCLAW.md (overarching system prompt) access from mobile.
    this.onGetCyberclawSystem = options.onGetCyberclawSystem || null;
    this.onSaveCyberclawSystem = options.onSaveCyberclawSystem || null;
    this.onResetCyberclawSystem = options.onResetCyberclawSystem || null;

    // Track the most recent wake_training_progress per agent so a phone that lost its WebSocket mid-training (and reconnected) can pick up where…
    this._lastWakeProgress = new Map();  // agentId → { stage, percent, message, ts }

    // Rate limiting for pairing
    this.pairingAttempts = 0;
    this.pairingLockoutUntil = 0;
    this.MAX_PAIRING_ATTEMPTS = 3;
    this.LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

    // Load or generate persistent config
    this.config = this._loadConfig();
  }

  _loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(SYNC_CONFIG_FILE, 'utf8'));
    } catch {
      const config = {
        deviceKey: crypto.randomBytes(32).toString('hex'),
        pairedDevices: [],
        allowedOrigins: ['cyberclaw-mobile']
      };
      fs.mkdirSync(CYBERCLAW_DIR, { recursive: true });
      fs.writeFileSync(SYNC_CONFIG_FILE, JSON.stringify(config, null, 2));
      return config;
    }
  }

  _saveConfig() {
    fs.mkdirSync(CYBERCLAW_DIR, { recursive: true });
    fs.writeFileSync(SYNC_CONFIG_FILE, JSON.stringify(this.config, null, 2));
  }

  /**
   * Generate self-signed TLS certificate if not exists
   */
  _ensureCerts() {
    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
      return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
    }

    console.log('[SyncServer] Generating self-signed TLS certificate...');
    fs.mkdirSync(CERT_DIR, { recursive: true });

    // Try OpenSSL first
    try {
      execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" -days 3650 -nodes -subj "/CN=CyberClaw Sync"`, { stdio: 'pipe' });
      console.log('[SyncServer] TLS certificate generated with OpenSSL');
      return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
    } catch {
      // Fallback: generate with Node.js crypto (requires Node 15+)
      try {
        const { generateKeyPairSync, createCertificate } = require('crypto');
        // Node doesn't have built-in cert generation, use forge-like approach
        // For now, fall back to non-TLS with a warning
        console.warn('[SyncServer] OpenSSL not available, falling back to ws:// (not wss://)');
        return null;
      } catch {
        console.warn('[SyncServer] Cannot generate TLS cert, falling back to ws://');
        return null;
      }
    }
  }

  /**
   * Generate a 6-digit pairing code, valid for 5 minutes
   */
  generatePairingCode() {
    if (Date.now() < this.pairingLockoutUntil) {
      const remaining = Math.ceil((this.pairingLockoutUntil - Date.now()) / 1000);
      return { error: `Too many attempts. Try again in ${remaining}s` };
    }
    this.pairingCode = String(Math.floor(100000 + Math.random() * 900000));
    this.pairingExpiry = Date.now() + 5 * 60 * 1000;
    this.pairingAttempts = 0;
    return this.pairingCode;
  }

  /**
   * Start the WebSocket server (WSS with TLS, fallback to WS)
   */
  start() {
    if (this.wss) return;

    // Plain WS for maximum compatibility (Android rejects self-signed TLS certs)
    // Security is handled by: pairing codes, HMAC tokens, rate limiting, auth timeout
    this.wss = new WebSocket.Server({ port: this.port }, () => {
      console.log(`[SyncServer] Listening on ws://0.0.0.0:${this.port}`);
    });

    this.wss.on('connection', (ws, req) => {
      const clientId = crypto.randomBytes(8).toString('hex');
      const clientInfo = {
        id: clientId,
        name: 'Unknown',
        authenticated: false,
        ip: req.socket.remoteAddress,
        connectedAt: Date.now(),
        authTimeout: null
      };
      this.clients.set(ws, clientInfo);
      console.log(`[SyncServer] Client connected: ${clientId} from ${clientInfo.ip}`);

      // Auto-drop unauthenticated connections after 30 seconds
      clientInfo.authTimeout = setTimeout(() => {
        if (!clientInfo.authenticated) {
          console.log(`[SyncServer] Dropping unauthenticated client: ${clientId}`);
          ws.close(4003, 'Authentication timeout');
        }
      }, 30000);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Per-message log (ping excluded).
          if (msg && msg.type && msg.type !== 'ping') {
            console.log(`[SyncServer] msg type=${msg.type} from ${clientInfo.name}`);
          }
          this._handleMessage(ws, msg);
        } catch (e) {
          console.error('[SyncServer] Bad message:', e.message);
        }
      });

      ws.on('close', () => {
        if (clientInfo.authTimeout) clearTimeout(clientInfo.authTimeout);
        const info = this.clients.get(ws);
        console.log(`[SyncServer] Client disconnected: ${info?.id || 'unknown'}`);
        this.clients.delete(ws);
        this._notifyMainWindow('mobile-disconnected', { clientId: info?.id });
      });

      ws.on('error', (err) => {
        if (clientInfo.authTimeout) clearTimeout(clientInfo.authTimeout);
        console.error('[SyncServer] Client error:', err.message);
      });

      // Send hello
      this._send(ws, {
        type: 'hello',
        version: '1.0.0',
        requiresAuth: true
      });
    });

    this.wss.on('error', (err) => {
      console.error('[SyncServer] Server error:', err.message);
    });
  }

  /**
   * Stop the server
   */
  stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.clients.clear();
  }

  /**
   * Handle incoming messages from mobile clients
   */
  async _handleMessage(ws, msg) {
    const client = this.clients.get(ws);
    if (!client) return;

    switch (msg.type) {
      case 'pair': {
        // Check lockout
        if (Date.now() < this.pairingLockoutUntil) {
          const remaining = Math.ceil((this.pairingLockoutUntil - Date.now()) / 1000);
          this._send(ws, { type: 'pair_result', success: false, error: `Locked out. Try again in ${remaining}s` });
          return;
        }

        if (!this.pairingCode || Date.now() > this.pairingExpiry) {
          this._send(ws, { type: 'pair_result', success: false, error: 'No active pairing code' });
          return;
        }
        if (msg.code !== this.pairingCode) {
          this.pairingAttempts++;
          if (this.pairingAttempts >= this.MAX_PAIRING_ATTEMPTS) {
            this.pairingLockoutUntil = Date.now() + this.LOCKOUT_DURATION_MS;
            this.pairingCode = null;
            this._send(ws, { type: 'pair_result', success: false, error: 'Too many wrong attempts. Locked for 5 minutes.' });
          } else {
            const left = this.MAX_PAIRING_ATTEMPTS - this.pairingAttempts;
            this._send(ws, { type: 'pair_result', success: false, error: `Wrong code (${left} attempt${left > 1 ? 's' : ''} left)` });
          }
          return;
        }

        // Generate device token (HMAC-signed)
        const tokenData = crypto.randomBytes(24).toString('hex');
        const hmac = crypto.createHmac('sha256', this.config.deviceKey).update(tokenData).digest('hex');
        const deviceToken = `cc.${tokenData}.${hmac}`;

        const deviceInfo = {
          token: deviceToken,
          name: msg.deviceName || 'Mobile',
          pairedAt: new Date().toISOString()
        };
        this.config.pairedDevices.push(deviceInfo);
        this._saveConfig();

        client.authenticated = true;
        client.name = deviceInfo.name;
        if (client.authTimeout) { clearTimeout(client.authTimeout); client.authTimeout = null; }
        this.pairingCode = null;
        this.pairingAttempts = 0;

        this._send(ws, { type: 'pair_result', success: true, token: deviceToken });
        this._notifyMainWindow('mobile-paired', { name: deviceInfo.name });
        console.log(`[SyncServer] Device paired: ${deviceInfo.name}`);
        break;
      }

      case 'auth': {
        // Verify HMAC-signed token
        const token = msg.token || '';
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== 'cc') {
          this._send(ws, { type: 'auth_result', success: false, error: 'Invalid token format' });
          return;
        }
        const [, data, providedHmac] = parts;
        const expectedHmac = crypto.createHmac('sha256', this.config.deviceKey).update(data).digest('hex');
        if (providedHmac !== expectedHmac) {
          this._send(ws, { type: 'auth_result', success: false, error: 'Invalid token' });
          return;
        }

        const device = this.config.pairedDevices.find(d => d.token === token);
        if (!device) {
          this._send(ws, { type: 'auth_result', success: false, error: 'Unknown device' });
          return;
        }
        client.authenticated = true;
        client.name = device.name;
        if (client.authTimeout) { clearTimeout(client.authTimeout); client.authTimeout = null; }
        this._send(ws, { type: 'auth_result', success: true, name: device.name });
        this._notifyMainWindow('mobile-connected', { name: device.name });
        console.log(`[SyncServer] Device authenticated: ${device.name}`);

        // v3.2.95: send the cached TTS settings on connect so
        // the mobile's voice picker reflects the current
        // desktop selection without an extra round trip.
        if (this._lastTtsSettings) {
          this._send(ws, this._lastTtsSettings.payload);
        }
        if (this._lastChatContext) this._send(ws, this._lastChatContext); // v3.4.12
        // v3.6.8: a phone that reconnects mid-reply sees the thinking bar again.
        if (this._lastTyping && this._lastTyping.active) this._send(ws, this._lastTyping);

        // Send current state and request chat history for this client
        this._sendFullState(ws);
        // Ask main window to send chat history to this client
        this._notifyMainWindow('mobile-request-chat-history', { ws: null });
        // Store ws reference so main can reply
        client._wsForHistory = ws;
        if (this.onRequestChatHistory) this.onRequestChatHistory(ws);
        break;
      }

      case 'chat': {
        if (!client.authenticated) {
          // Log dropped chats so they're visible in the desktop log.
          console.warn(`[SyncServer] chat dropped for ${client.id} (${client.name || 'no-name'}): not authenticated yet (text="${(msg.text || '').substring(0, 60)}")`);
          return;
        }
        if (this.onChatMessage) {
          const deviceTag = client.name && client.name !== 'Desktop' ? `[From: ${client.name}] ` : '';
          this.onChatMessage(deviceTag + msg.text, msg.agentId || 'companion', {
            ws,
            deviceName: client.name,
            deviceType: msg.deviceType || 'mobile',
          });
        }
        break;
      }

      case 'set_chat_context': {
        // v3.4.12: phone toggled casual ↔ active quest. The quest stays
        // active; the desktop switches its chat context (same as its own
        // ↔ toggle) and re-broadcasts chat_context to every client.
        if (!client.authenticated) return;
        this._notifyMainWindow('mobile-set-chat-context', { casual: !!msg.casual });
        break;
      }

      case 'mobile_wake_agent': {
        // Mobile-initiated companion wake.
        if (!client.authenticated) return;
        if (this.onMobileWakeAgent) {
          this.onMobileWakeAgent(msg.agentId || 'companion', {
            ws,
            deviceName: client.name,
          });
        }
        break;
      }

      case 'mobile_activity_ping': {
        // Mobile-initiated activity heartbeat.
        if (!client.authenticated) return;
        if (this.onMobileActivityPing) {
          this.onMobileActivityPing(msg.agentId || 'companion', {
            ws,
            deviceName: client.name,
          });
        }
        break;
      }

      case 'llm_action': {
        // Mobile-initiated LLM pill action.
        if (!client.authenticated) return;
        if (typeof msg.action !== 'string' || typeof msg.model !== 'string') return;
        const validActions = ['start', 'warm', 'unload'];
        if (!validActions.includes(msg.action)) return;
        if (this.onLlmAction) {
          this.onLlmAction(msg.model, msg.action, {
            ws,
            deviceName: client.name,
          });
        }
        break;
      }
      case 'arena_treat_placed': {
        // Mobile dropped a treat on the arena.
        if (!client.authenticated) return;
        if (this.onArenaTreatPlaced) {
          this.onArenaTreatPlaced(msg.treat || 'apple', {
            ws,
            deviceName: client.name,
            ...(msg.companionId ? { companionId: msg.companionId } : {}),
          });
        }
        break;
      }
      case 'arena_treat_eaten': {
        // Companion ate a treat.
        if (!client.authenticated) return;
        if (this.onArenaTreatEaten) {
          this.onArenaTreatEaten(msg.treat || 'apple', {
            ws,
            deviceName: client.name,
            ...(msg.companionId ? { companionId: msg.companionId } : {}),
          });
        }
        break;
      }
      case 'audio_input': {
        if (!client.authenticated) return;
        if (this.onAudioInput) {
          this.onAudioInput(msg.audioBase64, msg.mimeType || 'audio/wav', ws, {
            source: 'mobile',
            deviceName: client.name,
            transcript: typeof msg.transcript === 'string' ? msg.transcript : null,
          });
        }
        break;
      }

      // v3.6.1: end-of-turn check. The phone sends what it has recorded so
      // far after a short pause; we transcribe it and say whether the
      // sentence sounds finished.
      case 'voice_peek': {
        if (!client.authenticated) return;
        if (this.onVoicePeek) this.onVoicePeek(msg, ws);
        break;
      }

      // Attachment (image) upload from mobile.
      case 'attachment': {
        if (!client.authenticated) return;
        if (this.onAttachment) {
          this.onAttachment(msg.data, msg.mimeType || 'image/jpeg', msg.fileName || 'attachment', ws, {
            source: 'mobile',
            deviceName: client.name,
            agentId: msg.agentId || null,
          });
        }
        break;
      }

      case 'voice_transcript': {
        if (!client.authenticated) return;
        if (this.onVoiceTranscript) {
          this.onVoiceTranscript(msg.transcript, msg.context || '', {
            source: 'mobile',
            deviceName: client.name,
            lookbackMinutes: msg.lookbackMinutes || 0
          });
        }
        break;
      }

      case 'request_chat_history': {
        if (!client.authenticated) return;
        if (this.onRequestChatHistory) this.onRequestChatHistory(ws);
        break;
      }

      case 'request_agent_history': {
        if (!client.authenticated) return;
        const aid = msg.agentId;
        if (!aid) return;
        if (this.onRequestAgentHistory) this.onRequestAgentHistory(ws, aid);
        break;
      }

      case 'request_state': {
        if (!client.authenticated) return;
        console.log(`[SyncServer] Mobile requested full state (name=${client.name})`);
        this._sendFullState(ws);
        break;
      }

      // Explicit agents-list refresh.
      case 'request_agents_list': {
        if (!client.authenticated) return;
        console.log(`[SyncServer] Mobile requested agents list refresh (name=${client.name})`);
        if (this._lastAgentsList) {
          this._send(ws, this._lastAgentsList.payload);
        } else if (this.onRequestAgentsList) {
          try { this.onRequestAgentsList(); } catch (e) { console.log('[SyncServer] onRequestAgentsList failed:', e?.message); }
        }
        break;
      }

      // Explicit quests-list refresh.
      case 'request_quests_list': {
        if (!client.authenticated) return;
        console.log(`[SyncServer] Mobile requested quests list refresh (name=${client.name})`);
        if (this.onRequestQuestsList) {
          try { this.onRequestQuestsList(); } catch (e) { console.log('[SyncServer] onRequestQuestsList failed:', e?.message); }
        } else if (this._lastQuestsList) {
          // Cache fallback path — tag the replay so the
          // mobile can distinguish it from a fresh
          // broadcast (see v3.3.16).
          const replayPayload = {
            ...this._lastQuestsList.payload,
            source: 'cache_replay',
          };
          this._send(ws, replayPayload);
        }
        break;
      }

      case 'request_quest_instructions': {
        // Mobile requests the markdown content of a quest's project instructions file.
        if (!client.authenticated) return;
        const questId = msg.questId;
        if (!questId) {
          this._send(ws, { type: 'quest_instructions', questId: null, ok: false, error: 'questId required', ts: Date.now() });
          return;
        }
        if (!this.onReadQuestInstructions) {
          // Desktop doesn't have v3.2.30 wired yet (or this
          // is running against an older sync-server). Tell
          // the mobile gracefully.
          this._send(ws, {
            type: 'quest_instructions', questId, ok: false,
            error: 'Desktop does not support quest project instructions yet',
            ts: Date.now(),
          });
          return;
        }
        try {
          const result = this.onReadQuestInstructions(questId);
          if (result && typeof result.then === 'function') {
            result.then((res) => {
              this._send(ws, {
                type: 'quest_instructions',
                questId,
                ok: !!(res && res.ok),
                content: res?.content || '',
                path: res?.path || null,
                error: res?.ok ? undefined : (res?.error || 'unknown error'),
                ts: Date.now(),
              });
            }).catch((e) => {
              this._send(ws, { type: 'quest_instructions', questId, ok: false, error: e?.message || String(e), ts: Date.now() });
            });
          } else {
            const res = result || {};
            this._send(ws, {
              type: 'quest_instructions',
              questId,
              ok: !!(res && res.ok),
              content: res?.content || '',
              path: res?.path || null,
              error: res?.ok ? undefined : (res?.error || 'unknown error'),
              ts: Date.now(),
            });
          }
        } catch (e) {
          this._send(ws, { type: 'quest_instructions', questId, ok: false, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }

      case 'save_quest_instructions': {
        // Mobile saves the quest instructions file (used by the mobile's quest editor).
        if (!client.authenticated) return;
        const questId = msg.questId;
        const content = msg.content || '';
        if (!questId) {
          this._send(ws, { type: 'quest_instructions_saved', questId: null, ok: false, error: 'questId required', ts: Date.now() });
          return;
        }
        if (!this.onSaveQuestInstructions) {
          this._send(ws, {
            type: 'quest_instructions_saved', questId, ok: false,
            error: 'Desktop does not support quest project instructions yet',
            ts: Date.now(),
          });
          return;
        }
        try {
          const result = this.onSaveQuestInstructions(questId, content);
          if (result && typeof result.then === 'function') {
            result.then((res) => {
              this._send(ws, {
                type: 'quest_instructions_saved',
                questId,
                ok: !!(res && res.ok),
                path: res?.path || null,
                bytes: res?.bytes,
                error: res?.ok ? undefined : (res?.error || 'unknown error'),
                ts: Date.now(),
              });
            }).catch((e) => {
              this._send(ws, { type: 'quest_instructions_saved', questId, ok: false, error: e?.message || String(e), ts: Date.now() });
            });
          } else {
            const res = result || {};
            this._send(ws, {
              type: 'quest_instructions_saved',
              questId,
              ok: !!(res && res.ok),
              path: res?.path || null,
              bytes: res?.bytes,
              error: res?.ok ? undefined : (res?.error || 'unknown error'),
              ts: Date.now(),
            });
          }
        } catch (e) {
          this._send(ws, { type: 'quest_instructions_saved', questId, ok: false, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }

      // Mobile requests the per-quest conversation log (the JSON array, used by buildActiveQuestContext for LLM context).
      case 'request_quest_conversation_log': {
        if (!client.authenticated) return;
        const questId = msg.questId;
        if (!questId) {
          this._send(ws, { type: 'quest_conversation_log', questId: null, ok: false, error: 'questId required', ts: Date.now() });
          return;
        }
        if (!this.onGetQuestConversationLog) {
          this._send(ws, {
            type: 'quest_conversation_log', questId, ok: false,
            error: 'Desktop does not support quest conversation log yet',
            ts: Date.now(),
          });
          return;
        }
        try {
          const res = await this.onGetQuestConversationLog(questId);
          this._send(ws, {
            type: 'quest_conversation_log',
            questId,
            ok: !!(res && res.ok),
            log: res?.log || [],
            filePath: res?.filePath || null,
            questName: res?.questName || '',
            error: res?.ok ? undefined : (res?.error || 'unknown error'),
            ts: Date.now(),
          });
        } catch (e) {
          this._send(ws, { type: 'quest_conversation_log', questId, ok: false, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }

      // Mobile requests the raw per-quest conversation file content (the canonical markdown store at <quest.directory>/CONVERSATION.md).
      case 'request_quest_conversation_file': {
        if (!client.authenticated) return;
        const questId = msg.questId;
        if (!questId) {
          this._send(ws, { type: 'quest_conversation_file', questId: null, ok: false, error: 'questId required', ts: Date.now() });
          return;
        }
        if (!this.onGetQuestConversationFile) {
          this._send(ws, {
            type: 'quest_conversation_file', questId, ok: false,
            error: 'Desktop does not support quest conversation file yet',
            ts: Date.now(),
          });
          return;
        }
        try {
          const res = await this.onGetQuestConversationFile(questId);
          this._send(ws, {
            type: 'quest_conversation_file',
            questId,
            ok: !!(res && res.ok),
            content: res?.content || '',
            path: res?.path || null,
            error: res?.ok ? undefined : (res?.error || 'unknown error'),
            ts: Date.now(),
          });
        } catch (e) {
          this._send(ws, { type: 'quest_conversation_file', questId, ok: false, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }

      // v3.2.61: mobile asks the desktop to clear the
      // conversation log (JSON + file). Renderer-side
      // equivalent: cyberclaw.quests.clearConversationLog().
      case 'clear_quest_conversation_log': {
        if (!client.authenticated) return;
        const questId = msg.questId;
        if (!questId) {
          this._send(ws, { type: 'quest_conversation_log_cleared', questId: null, ok: false, error: 'questId required', ts: Date.now() });
          return;
        }
        if (!this.onClearQuestConversationLog) {
          this._send(ws, {
            type: 'quest_conversation_log_cleared', questId, ok: false,
            error: 'Desktop does not support quest conversation log clear yet',
            ts: Date.now(),
          });
          return;
        }
        try {
          await this.onClearQuestConversationLog(questId);
          this._send(ws, { type: 'quest_conversation_log_cleared', questId, ok: true, ts: Date.now() });
        } catch (e) {
          this._send(ws, { type: 'quest_conversation_log_cleared', questId, ok: false, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }

      // Mobile asks for the CYBERCLAW.md content (the overarching system prompt).
        case 'request_cyberclaw_system': {
          if (!client.authenticated) return;
          if (!this.onGetCyberclawSystem) {
            this._send(ws, {
              type: 'cyberclaw_system', ok: false,
              error: 'Desktop does not support CYBERCLAW.md yet',
              ts: Date.now(),
            });
            return;
          }
          try {
            const res = await this.onGetCyberclawSystem();
            this._send(ws, {
              type: 'cyberclaw_system',
              ok: !!(res && res.ok),
              content: res?.content || '',
              defaultContent: res?.defaultContent || '',
              path: res?.path || null,
              error: res?.ok ? undefined : (res?.error || 'unknown error'),
              ts: Date.now(),
            });
          } catch (e) {
            this._send(ws, { type: 'cyberclaw_system', ok: false, error: e?.message || String(e), ts: Date.now() });
          }
          break;
        }

        // v3.2.62: mobile writes a new CYBERCLAW.md
        // content. We forward to main.js's
        // `system:save-cyberclaw` IPC equivalent.
        case 'save_cyberclaw_system': {
          if (!client.authenticated) return;
          const content = typeof msg.content === 'string' ? msg.content : '';
          if (!this.onSaveCyberclawSystem) {
            this._send(ws, {
              type: 'cyberclaw_system_saved', ok: false,
              error: 'Desktop does not support CYBERCLAW.md save yet',
              ts: Date.now(),
            });
            return;
          }
          try {
            const res = await this.onSaveCyberclawSystem(content);
            if (res && typeof res.then === 'function') {
              await res;
            } else if (res && res.ok === false) {
              this._send(ws, {
                type: 'cyberclaw_system_saved',
                ok: false,
                error: res?.error || 'unknown error',
                ts: Date.now(),
              });
              return;
            }
            this._send(ws, { type: 'cyberclaw_system_saved', ok: true, ts: Date.now() });
          } catch (e) {
            this._send(ws, { type: 'cyberclaw_system_saved', ok: false, error: e?.message || String(e), ts: Date.now() });
          }
          break;
        }

        // Mobile resets CYBERCLAW.md to the default.
        case 'reset_cyberclaw_system': {
          if (!client.authenticated) return;
          if (!this.onResetCyberclawSystem) {
            this._send(ws, {
              type: 'cyberclaw_system_reset', ok: false,
              error: 'Desktop does not support CYBERCLAW.md reset yet',
              ts: Date.now(),
            });
            return;
          }
          try {
            const res = await this.onResetCyberclawSystem();
            if (res && typeof res.then === 'function') await res;
            this._send(ws, { type: 'cyberclaw_system_reset', ok: true, ts: Date.now() });
            // Push the post-reset content so the mobile
            // updates its textbox without an extra round-trip.
            const after = await this.onGetCyberclawSystem();
            this._send(ws, {
              type: 'cyberclaw_system',
              ok: !!(after && after.ok),
              content: after?.content || '',
              defaultContent: after?.defaultContent || '',
              path: after?.path || null,
              ts: Date.now(),
            });
          } catch (e) {
            this._send(ws, { type: 'cyberclaw_system_reset', ok: false, error: e?.message || String(e), ts: Date.now() });
          }
          break;
        }

      // Mobile requests a companion's soul.md.
      case 'read_companion_soul': {
        if (!client.authenticated) return;
        const agentId = msg.agentId;
        if (!agentId) {
          this._send(ws, { type: 'companion_soul', agentId: null, ok: false, error: 'agentId required', ts: Date.now() });
          return;
        }
        if (!this.onReadCompanionSoul) {
          this._send(ws, {
            type: 'companion_soul', agentId, ok: false,
            error: 'Desktop does not support companion soul yet',
            ts: Date.now(),
          });
          return;
        }
        try {
          const result = this.onReadCompanionSoul(agentId);
          if (result && typeof result.then === 'function') {
            result.then((res) => {
              this._send(ws, {
                type: 'companion_soul',
                agentId,
                ok: !!(res && res.ok),
                content: res?.content || '',
                presets: res?.presets || null,
                error: res?.ok ? undefined : (res?.error || 'unknown error'),
                ts: Date.now(),
              });
            }).catch((e) => {
              this._send(ws, { type: 'companion_soul', agentId, ok: false, error: e?.message || String(e), ts: Date.now() });
            });
          } else {
            const res = result || {};
            this._send(ws, {
              type: 'companion_soul',
              agentId,
              ok: !!(res && res.ok),
              content: res?.content || '',
              presets: res?.presets || null,
              error: res?.ok ? undefined : (res?.error || 'unknown error'),
              ts: Date.now(),
            });
          }
        } catch (e) {
          this._send(ws, { type: 'companion_soul', agentId, ok: false, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }

      // v3.2.35: mobile requests a companion's memory.md.
      // Read-only — the desktop's Companion Forge viewer is the
      // canonical display; the mobile mirrors the content.
      case 'read_companion_memory': {
        if (!client.authenticated) return;
        const agentId = msg.agentId;
        if (!agentId) {
          this._send(ws, { type: 'companion_memory', agentId: null, ok: false, error: 'agentId required', ts: Date.now() });
          return;
        }
        if (!this.onReadCompanionMemory) {
          this._send(ws, {
            type: 'companion_memory', agentId, ok: false,
            error: 'Desktop does not support companion memory yet',
            ts: Date.now(),
          });
          return;
        }
        try {
          const result = this.onReadCompanionMemory(agentId);
          if (result && typeof result.then === 'function') {
            result.then((res) => {
              this._send(ws, {
                type: 'companion_memory',
                agentId,
                ok: !!(res && res.ok),
                content: res?.content || '',
                error: res?.ok ? undefined : (res?.error || 'unknown error'),
                ts: Date.now(),
              });
            }).catch((e) => {
              this._send(ws, { type: 'companion_memory', agentId, ok: false, error: e?.message || String(e), ts: Date.now() });
            });
          } else {
            const res = result || {};
            this._send(ws, {
              type: 'companion_memory',
              agentId,
              ok: !!(res && res.ok),
              content: res?.content || '',
              error: res?.ok ? undefined : (res?.error || 'unknown error'),
              ts: Date.now(),
            });
          }
        } catch (e) {
          this._send(ws, { type: 'companion_memory', agentId, ok: false, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }

      // Mobile asks the desktop to clear a companion's memory.md.
      case 'clear_companion_memory': {
        if (!client.authenticated) return;
        const agentId = msg.agentId;
        if (!agentId) {
          this._send(ws, { type: 'companion_memory_cleared', agentId: null, ok: false, error: 'agentId required', ts: Date.now() });
          return;
        }
        if (!this.onClearCompanionMemory) {
          this._send(ws, {
            type: 'companion_memory_cleared', agentId, ok: false,
            error: 'Desktop does not support clearing companion memory yet',
            ts: Date.now(),
          });
          return;
        }
        try {
          const result = this.onClearCompanionMemory(agentId);
          if (result && typeof result.then === 'function') {
            result.then((res) => {
              this._send(ws, {
                type: 'companion_memory_cleared',
                agentId,
                ok: !!(res && res.ok),
                content: res?.content || '',
                error: res?.ok ? undefined : (res?.error || 'unknown error'),
                ts: Date.now(),
              });
            }).catch((e) => {
              this._send(ws, { type: 'companion_memory_cleared', agentId, ok: false, error: e?.message || String(e), ts: Date.now() });
            });
          } else {
            const res = result || {};
            this._send(ws, {
              type: 'companion_memory_cleared',
              agentId,
              ok: !!(res && res.ok),
              content: res?.content || '',
              error: res?.ok ? undefined : (res?.error || 'unknown error'),
              ts: Date.now(),
            });
          }
        } catch (e) {
          this._send(ws, { type: 'companion_memory_cleared', agentId, ok: false, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }

      // Phone-side quest edit.
      case 'set_quest_active': {
        if (!client.authenticated) return;
        const { id } = msg;
        // Debug log so we can see if the mobile's click is actually sending the WS message.
        console.log(`[SyncServer] set_quest_active received from ${client.name}: id=${id}`);
        try {
          if (this.onSetQuestActive) this.onSetQuestActive(id);
        } catch (e) {
          console.log('[SyncServer] onSetQuestActive failed:', e?.message);
          this._send(ws, { type: 'quests_update_failed', action: 'set_quest_active', id, error: e?.message });
        }
        break;
      }
      case 'update_quest': {
        if (!client.authenticated) return;
        const { id, updates } = msg;
        try {
          const ok = this.onUpdateQuest ? this.onUpdateQuest(id, updates || {}) : null;
          if (!ok) {
            // Include the full list of available quests (with id + name) in the error response.
            const available = this.onListQuests ? (this.onListQuests() || []) : [];
            console.log('[SyncServer] update_quest: id not found. requested:', id, 'available:', JSON.stringify(available));
            this._send(ws, {
              type: 'quests_update_failed',
              action: 'update_quest',
              id,
              error: 'quest not found',
              available,
              wantedName: updates && updates.name ? String(updates.name).trim() : null,
            });
          }
        } catch (e) {
          console.log('[SyncServer] onUpdateQuest failed:', e?.message);
          this._send(ws, { type: 'quests_update_failed', action: 'update_quest', id, error: e?.message });
        }
        break;
      }
      case 'delete_quest': {
        if (!client.authenticated) return;
        const { id } = msg;
        try {
          const ok = this.onDeleteQuest ? this.onDeleteQuest(id) : false;
          if (!ok) {
            this._send(ws, { type: 'quests_update_failed', action: 'delete_quest', id, error: 'quest not found' });
          }
        } catch (e) {
          console.log('[SyncServer] onDeleteQuest failed:', e?.message);
          this._send(ws, { type: 'quests_update_failed', action: 'delete_quest', id, error: e?.message });
        }
        break;
      }
      case 'mark_quest_goal_done': {
        if (!client.authenticated) return;
        const { id, goalIndex, completed } = msg;
        try {
          const ok = this.onMarkQuestGoalDone ? this.onMarkQuestGoalDone(id, goalIndex, completed) : null;
          if (!ok) {
            this._send(ws, { type: 'quests_update_failed', action: 'mark_quest_goal_done', id, error: 'quest or goal not found' });
          }
        } catch (e) {
          console.log('[SyncServer] onMarkQuestGoalDone failed:', e?.message);
          this._send(ws, { type: 'quests_update_failed', action: 'mark_quest_goal_done', id, error: e?.message });
        }
        break;
      }
      case 'create_quest': {
        if (!client.authenticated) return;
        const { quest } = msg;
        try {
          const created = this.onCreateQuest ? this.onCreateQuest(quest || {}) : null;
          if (!created) {
            this._send(ws, { type: 'quests_update_failed', action: 'create_quest', error: 'create failed' });
          }
        } catch (e) {
          console.log('[SyncServer] onCreateQuest failed:', e?.message);
          this._send(ws, { type: 'quests_update_failed', action: 'create_quest', error: e?.message });
        }
        break;
      }

      case 'companion_interaction': {
        if (!client.authenticated) return;
        this._notifyMainWindow('mobile-companion-action', msg.action);
        break;
      }

      case 'set_companion_id': {
        if (!client.authenticated) return;
        const companionId = msg.companionId;
        console.log(`[SyncServer] Mobile requesting companion change to: ${companionId}`);
        // Notify main window (Electron process) to actually change it
        this._notifyMainWindow('mobile-set-companion', { companionId });
        // Wait a moment for the IPC handler to update MEMORY
        setTimeout(() => {
          console.log(`[SyncServer] Broadcasting companion change after IPC`);
          this._broadcast({ type: 'companion_id', companionId, ts: Date.now() });
          this._send(ws, { type: 'companion_id', companionId, ts: Date.now() });
        }, 100);
        break;
      }

      case 'sprite_config_sync': {
        // Phone-side companion edit (Personalize screen).
        if (!client.authenticated) return;
        if (!this.onSaveSpriteConfig) {
          console.warn('[SyncServer] sprite_config_sync: no onSaveSpriteConfig callback wired');
          this._send(ws, { type: 'sprite_config_sync_failed', reason: 'no_callback', error: 'sprite_config_sync not supported on this desktop version', ts: Date.now() });
          return;
        }
        const agentId = msg.agentId;
        const patch = msg.config || {};
        if (!agentId) {
          this._send(ws, { type: 'sprite_config_sync_failed', reason: 'missing_agentId', error: 'agentId required', ts: Date.now() });
          return;
        }
        // Whitelist of accepted fields.
        const ALLOWED = ['pixelCompanionId', 'spiritId', 'customName', 'focusSkills', 'traits', 'primaryModel', 'secondaryModel', 'scale', 'chattiness'];
        const sanitized = {};
        for (const k of ALLOWED) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) {
            sanitized[k] = patch[k];
          }
        }
        // v3.2.26: chattiness comes in as a number 1–5 from
        // the mobile slider. Clamp before forwarding so a
        // bad value can't disable the scheduler.
        if (typeof sanitized.chattiness === 'number') {
          sanitized.chattiness = Math.max(1, Math.min(5, Math.round(sanitized.chattiness)));
        }
        // v3.2.26: scale must be 1–8 (matches the desktop slider).
        if (typeof sanitized.scale === 'number') {
          sanitized.scale = Math.max(1, Math.min(8, Math.round(sanitized.scale)));
        }
        const ok = this.onSaveSpriteConfig(agentId, sanitized);
        if (ok && ok.ok !== false) {
          // Ack explicit success so the mobile can show a "Saved" toast and stop its spinner.
          this._send(ws, { type: 'sprite_config_sync_ok', agentId, ts: Date.now() });
        } else {
          this._send(ws, { type: 'sprite_config_sync_failed', agentId, reason: ok?.reason || 'unknown', error: ok?.error || 'save failed', ts: Date.now() });
        }
        break;
      }

      case 'ping': {
        this._send(ws, { type: 'pong', ts: Date.now() });
        break;
      }

      case 'provider_save': {
        // Mobile sends an API key for a provider.
        if (!client.authenticated) return;
        const provider = msg.provider;
        if (!provider || typeof provider !== 'object') {
          this._send(ws, { type: 'provider_save_failed', reason: 'missing_provider', error: 'provider object required', ts: Date.now() });
          return;
        }
        if (!provider.apiKey || typeof provider.apiKey !== 'string') {
          this._send(ws, { type: 'provider_save_failed', reason: 'missing_apiKey', error: 'apiKey required', ts: Date.now() });
          return;
        }
        if (!this.onSaveProvider) {
          console.warn('[SyncServer] provider_save: no onSaveProvider callback wired');
          this._send(ws, { type: 'provider_save_failed', reason: 'no_callback', error: 'provider_save not supported on this desktop version', ts: Date.now() });
          return;
        }
        try {
          const result = this.onSaveProvider(provider);
          if (result && result.ok !== false) {
            this._send(ws, { type: 'provider_save_ok', providerId: provider.id, ts: Date.now() });
          } else {
            this._send(ws, { type: 'provider_save_failed', reason: result?.reason || 'unknown', error: result?.error || 'save failed', ts: Date.now() });
          }
        } catch (e) {
          console.warn('[SyncServer] provider_save failed:', e?.message);
          this._send(ws, { type: 'provider_save_failed', reason: 'exception', error: e?.message, ts: Date.now() });
        }
        break;
      }

      case 'remote_tool_result': {
        if (!client.authenticated) return;
        // Emit so the remote-tool-bridge can resolve the pending promise
        this.emit('remote_tool_result', msg);
        break;
      }

      // Mobile asks the desktop to synthesize speech audio for the wake greeting phrase.
      case 'request_greeting_audio': {
        if (!client.authenticated) return;
        const text = (msg.text || '').trim();
        if (!text) {
          console.warn('[SyncServer] request_greeting_audio with empty text');
          return;
        }
        console.log(`[SyncServer] Greeting audio request: "${text.substring(0, 60)}"`);
        this._handleGreetingAudio(ws, text).catch((e) => {
          console.error('[SyncServer] Greeting audio synthesis failed:', e.message);
        });
        break;
      }

      // Mobile asks the desktop to synthesize the exit reply phrase.
      case 'request_working_audio': {
        if (!client.authenticated) return;
        const text = (msg.text || '').trim();
        if (!text) {
          console.warn('[SyncServer] request_working_audio with empty text');
          return;
        }
        console.log(`[SyncServer] Working speech audio request: "${text.substring(0, 60)}"`);
        this._handleWorkingAudio(ws, text).catch((e) => {
          console.error('[SyncServer] Working speech synthesis failed:', e.message);
        });
        break;
      }
      case 'request_exit_reply_audio': {
        if (!client.authenticated) return;
        const text = (msg.text || '').trim();
        if (!text) {
          console.warn('[SyncServer] request_exit_reply_audio with empty text');
          return;
        }
        console.log(`[SyncServer] Exit reply audio request: "${text.substring(0, 60)}"`);
        this._handleExitReplyAudio(ws, text).catch((e) => {
          console.error('[SyncServer] Exit reply audio synthesis failed:', e.message);
        });
        break;
      }

      // Mobile asks the desktop to start a custom openWakeWord training job.
      case 'request_wake_training': {
        if (!client.authenticated) return;
        // v3.1.38: `samples` is now [{name, data}] (base64 audio),
        // not file paths. See OpenWakeWordTrainer.tsx + main.js.
        if (!msg.agentId || !msg.phrase || !Array.isArray(msg.samples) || !msg.samples.length) {
          console.warn('[SyncServer] request_wake_training missing fields:', Object.keys(msg || {}));
          this._send(ws, { type: 'wake_training_result', ok: false, error: 'agentId, phrase, samples required' });
          return;
        }
        console.log(`[SyncServer] Wake training request: agent=${msg.agentId} phrase="${msg.phrase}" samples=${msg.samples.length}`);
        this.emit('wake_training_request', {
          ws,
          agentId: msg.agentId,
          phrase: msg.phrase,
          samples: msg.samples,
        });
        break;
      }

      // Mobile asks the desktop for the most recent wake-training result for an agent.
      case 'get_latest_wake_training_result': {
        console.log(`[SyncServer] get_latest_wake_training_result from ${client.name || '?'} agentId=${msg.agentId}`);
        if (!client.authenticated) return;
        if (!msg.agentId) {
          this._send(ws, { type: 'wake_training_result', ok: false, error: 'agentId required' });
          return;
        }
        // If main.js has cached a recent wake_training_progress for this agent, attach it to the reply.
        if (typeof this._getLastWakeProgress === 'function') {
          const latest = this._getLastWakeProgress(msg.agentId);
          if (latest && (Date.now() - (latest.ts || 0) < 5 * 60 * 1000)) {
            this._send(ws, { type: 'wake_training_progress', agentId: msg.agentId, ...latest });
          }
        }
        const cached = typeof this._getCachedWakeResult === 'function'
          ? this._getCachedWakeResult(msg.agentId)
          : null;
        if (cached) {
          console.log(`[SyncServer] Replaying cached wake result for ${msg.agentId}`);
          this._send(ws, cached);
        } else {
          // No cached result — be explicit so the phone can show
          // 'no training in progress' rather than hang on the
          // loading screen.
          this._send(ws, {
            type: 'wake_training_result',
            ok: false,
            agentId: msg.agentId,
            error: 'no recent wake training result for this agent',
            noResult: true,
          });
        }
        break;
      }

      // Mobile asks for the bytes of a previously-trained .tflite.
      case 'read_wake_model': {
        if (!client.authenticated) return;
        if (!msg.tflitePath) {
          this._send(ws, { type: 'wake_model_data', ok: false, error: 'tflitePath required' });
          return;
        }
        const fs = require('fs');
        if (!fs.existsSync(msg.tflitePath)) {
          this._send(ws, { type: 'wake_model_data', ok: false, error: 'file not found' });
          return;
        }
        try {
          const buf = fs.readFileSync(msg.tflitePath);
          this._send(ws, {
            type: 'wake_model_data',
            ok: true,
            base64: buf.toString('base64'),
            size: buf.length,
            tflitePath: msg.tflitePath,
          });
          console.log(`[SyncServer] Sent wake model (${buf.length} bytes) for ${msg.tflitePath}`);
        } catch (e) {
          this._send(ws, { type: 'wake_model_data', ok: false, error: e.message });
        }
        break;
      }

      // Exit-phrase training.
      case 'request_exit_training': {
        if (!client.authenticated) return;
        if (!msg.phrase || !Array.isArray(msg.samples) || !msg.samples.length) {
          console.warn('[SyncServer] request_exit_training missing fields:', Object.keys(msg || {}));
          this._send(ws, { type: 'exit_training_result', ok: false, error: 'phrase, samples required' });
          return;
        }
        console.log(`[SyncServer] Exit training request: phrase="${msg.phrase}" samples=${msg.samples.length}`);
        this.emit('exit_training_request', {
          ws,
          phrase: msg.phrase,
          samples: msg.samples,
        });
        break;
      }

      case 'get_latest_exit_training_result': {
        if (!client.authenticated) return;
        if (typeof this._getLastExitProgress === 'function') {
          const latest = this._getLastExitProgress();
          if (latest && (Date.now() - (latest.ts || 0) < 5 * 60 * 1000)) {
            this._send(ws, { type: 'exit_training_progress', ...latest });
          }
        }
        const cached = typeof this._getCachedExitResult === 'function'
          ? this._getCachedExitResult()
          : null;
        if (cached) {
          console.log('[SyncServer] Replaying cached exit result');
          this._send(ws, cached);
        } else {
          this._send(ws, {
            type: 'exit_training_result',
            ok: false,
            error: 'no recent exit training result',
            noResult: true,
          });
        }
        break;
      }

      case 'read_exit_model': {
        if (!client.authenticated) return;
        if (!msg.tflitePath) {
          this._send(ws, { type: 'exit_model_data', ok: false, error: 'tflitePath required' });
          return;
        }
        const fs = require('fs');
        if (!fs.existsSync(msg.tflitePath)) {
          this._send(ws, { type: 'exit_model_data', ok: false, error: 'file not found' });
          return;
        }
        try {
          const buf = fs.readFileSync(msg.tflitePath);
          this._send(ws, {
            type: 'exit_model_data',
            ok: true,
            base64: buf.toString('base64'),
            size: buf.length,
            tflitePath: msg.tflitePath,
          });
          console.log(`[SyncServer] Sent exit model (${buf.length} bytes) for ${msg.tflitePath}`);
        } catch (e) {
          this._send(ws, { type: 'exit_model_data', ok: false, error: e.message });
        }
        break;
      }

      // Send-word training.
      case 'request_send_training': {
        if (!client.authenticated) return;
        if (!msg.phrase || !Array.isArray(msg.samples) || !msg.samples.length) {
          console.warn('[SyncServer] request_send_training missing fields:', Object.keys(msg || {}));
          this._send(ws, { type: 'send_training_result', ok: false, error: 'phrase, samples required' });
          return;
        }
        console.log(`[SyncServer] Send training request: phrase="${msg.phrase}" samples=${msg.samples.length}`);
        this.emit('send_training_request', {
          ws,
          phrase: msg.phrase,
          samples: msg.samples,
        });
        break;
      }

      case 'get_latest_send_training_result': {
        if (!client.authenticated) return;
        if (typeof this._getLastSendProgress === 'function') {
          const latest = this._getLastSendProgress();
          if (latest && (Date.now() - (latest.ts || 0) < 5 * 60 * 1000)) {
            this._send(ws, { type: 'send_training_progress', ...latest });
          }
        }
        const cached = typeof this._getCachedSendResult === 'function'
          ? this._getCachedSendResult()
          : null;
        if (cached) {
          console.log('[SyncServer] Replaying cached send result');
          this._send(ws, cached);
        } else {
          this._send(ws, {
            type: 'send_training_result',
            ok: false,
            error: 'no recent send training result',
            noResult: true,
          });
        }
        break;
      }

      case 'read_send_model': {
        if (!client.authenticated) return;
        if (!msg.tflitePath) {
          this._send(ws, { type: 'send_model_data', ok: false, error: 'tflitePath required' });
          return;
        }
        const fs = require('fs');
        if (!fs.existsSync(msg.tflitePath)) {
          this._send(ws, { type: 'send_model_data', ok: false, error: 'file not found' });
          return;
        }
        try {
          const buf = fs.readFileSync(msg.tflitePath);
          this._send(ws, {
            type: 'send_model_data',
            ok: true,
            base64: buf.toString('base64'),
            size: buf.length,
            tflitePath: msg.tflitePath,
          });
          console.log(`[SyncServer] Sent send model (${buf.length} bytes) for ${msg.tflitePath}`);
        } catch (e) {
          this._send(ws, { type: 'send_model_data', ok: false, error: e.message });
        }
        break;
      }

      // Trainer manager wire protocol (wake).
      case 'list_wake_sets_from_desktop': {
        if (!client.authenticated) return;
        // Delegate to main.js which knows about the
        // ~/.openclaw/cyberclaw/wake-training/ tree.
        this.emit('list_wake_sets_from_desktop', { ws });
        break;
      }
      case 'import_wake_set_from_desktop': {
        if (!client.authenticated) return;
        if (!msg.setId || !msg.sourcePath) {
          this._send(ws, { type: 'wake_set_imported', ok: false, error: 'setId and sourcePath required' });
          return;
        }
        this.emit('import_wake_set_from_desktop', { ws, setId: msg.setId, sourcePath: msg.sourcePath });
        break;
      }
      case 'export_wake_set_to_desktop': {
        if (!client.authenticated) return;
        if (!msg.setId || !msg.base64 || !msg.phrase) {
          this._send(ws, { type: 'wake_set_exported', ok: false, error: 'setId, base64, phrase required' });
          return;
        }
        this.emit('export_wake_set_to_desktop', { ws, setId: msg.setId, base64: msg.base64, phrase: msg.phrase });
        break;
      }
      // Mobile asks the desktop for the piper voice list + the current selection.
      case 'request_tts_settings': {
        if (!client.authenticated) return;
        if (this.onGetTtsSettings) {
          try {
            const r = await this.onGetTtsSettings();
            this._send(ws, {
              type: 'tts_settings',
              ok: r.ok !== false,
              voices: r.voices || [],
              current: r.current || 'lessac',
              error: r.error || null,
              ts: Date.now(),
            });
          } catch (e) {
            this._send(ws, { type: 'tts_settings', ok: false, voices: [], current: 'lessac', error: e?.message || String(e), ts: Date.now() });
          }
        } else {
          // Desktop doesn't have v3.2.95 wired. Send a
          // minimal fallback so the mobile renders the
          // default voice at least.
          this._send(ws, {
            type: 'tts_settings', ok: false,
            voices: [{ id: 'lessac', label: 'Lessac (US, baseline)', group: 'Male' }],
            current: 'lessac',
            error: 'Desktop does not support TTS settings sync yet',
            ts: Date.now(),
          });
        }
        break;
      }
      // Mobile sets the desktop's piper voice.
      case 'set_tts_voice': {
        if (!client.authenticated) return;
        if (!msg.voice || typeof msg.voice !== 'string') {
          this._send(ws, { type: 'tts_voice_set', ok: false, error: 'voice id required', ts: Date.now() });
          return;
        }
        if (this.onSetTtsVoice) {
          try {
            const r = await this.onSetTtsVoice(msg.voice);
            this._send(ws, { type: 'tts_voice_set', ok: r.ok !== false, current: r.current || msg.voice, error: r.error || null, ts: Date.now() });
          } catch (e) {
            this._send(ws, { type: 'tts_voice_set', ok: false, error: e?.message || String(e), ts: Date.now() });
          }
        } else {
          this._send(ws, { type: 'tts_voice_set', ok: false, error: 'Desktop does not support set_tts_voice yet', ts: Date.now() });
        }
        break;
      }

      // v3.3.0: skills library (mirror of the desktop IPCs).
      // The phone can browse, create, update, delete, and
      // toggle skills just like the desktop's left sidebar.
      case 'request_skills_list': {
        if (!client.authenticated) return;
        try {
          const r = this.onListSkills ? this.onListSkills() : { ok: false, error: 'Desktop skills not wired' };
          this._send(ws, { type: 'skills_list', ok: !!(r && r.ok), skills: (r && r.skills) || [], error: r?.error || null, ts: Date.now() });
        } catch (e) {
          this._send(ws, { type: 'skills_list', ok: false, skills: [], error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }
      case 'request_skill_read': {
        if (!client.authenticated) return;
        const id = msg.skillId;
        if (!id) { this._send(ws, { type: 'skill_read', ok: false, error: 'skillId required', ts: Date.now() }); return; }
        try {
          const r = this.onReadSkill ? this.onReadSkill(id) : { ok: false, error: 'Desktop skills not wired' };
          this._send(ws, { type: 'skill_read', ok: !!(r && r.ok), skill: r?.skill || null, error: r?.ok ? null : (r?.error || 'unknown error'), ts: Date.now() });
        } catch (e) {
          this._send(ws, { type: 'skill_read', ok: false, skill: null, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }
      case 'create_skill': {
        if (!client.authenticated) return;
        try {
          const r = this.onCreateSkill ? this.onCreateSkill(msg.payload || {}) : { ok: false, error: 'Desktop skills not wired' };
          this._send(ws, { type: 'skill_create_result', ok: !!(r && r.ok), skill: r?.skill || null, validation: r?.validation || null, error: r?.ok ? null : (r?.error || 'unknown error'), ts: Date.now() });
          // Broadcast the updated list to every connected client so
          // the desktop UI refreshes too.
          if (r && r.ok) this._broadcastSkillsList();
        } catch (e) {
          this._send(ws, { type: 'skill_create_result', ok: false, skill: null, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }
      case 'update_skill': {
        if (!client.authenticated) return;
        const id = msg.skillId;
        if (!id) { this._send(ws, { type: 'skill_update_result', ok: false, error: 'skillId required', ts: Date.now() }); return; }
        try {
          const r = this.onUpdateSkill ? this.onUpdateSkill(id, msg.payload || {}) : { ok: false, error: 'Desktop skills not wired' };
          this._send(ws, { type: 'skill_update_result', ok: !!(r && r.ok), skill: r?.skill || null, validation: r?.validation || null, error: r?.ok ? null : (r?.error || 'unknown error'), ts: Date.now() });
          if (r && r.ok) this._broadcastSkillsList();
        } catch (e) {
          this._send(ws, { type: 'skill_update_result', ok: false, skill: null, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }
      case 'delete_skill': {
        if (!client.authenticated) return;
        const id = msg.skillId;
        if (!id) { this._send(ws, { type: 'skill_delete_result', ok: false, error: 'skillId required', ts: Date.now() }); return; }
        try {
          const r = this.onDeleteSkill ? this.onDeleteSkill(id) : { ok: false, error: 'Desktop skills not wired' };
          this._send(ws, { type: 'skill_delete_result', ok: !!(r && r.ok), error: r?.ok ? null : (r?.error || 'unknown error'), ts: Date.now() });
          if (r && r.ok) this._broadcastSkillsList();
        } catch (e) {
          this._send(ws, { type: 'skill_delete_result', ok: false, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }
      case 'seed_starter_skills': {
        if (!client.authenticated) return;
        try {
          const r = this.onSeedStarterSkills ? this.onSeedStarterSkills() : { ok: false, error: 'Desktop skills not wired' };
          this._send(ws, { type: 'skill_seed_result', ok: !!(r && r.ok), seeded: r?.seeded || [], error: r?.ok ? null : (r?.error || 'unknown error'), ts: Date.now() });
          if (r && r.ok) this._broadcastSkillsList();
        } catch (e) {
          this._send(ws, { type: 'skill_seed_result', ok: false, error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }
      case 'request_enabled_skills': {
        if (!client.authenticated) return;
        const agentId = msg.agentId;
        if (!agentId) { this._send(ws, { type: 'enabled_skills', ok: false, error: 'agentId required', ts: Date.now() }); return; }
        try {
          const r = this.onGetEnabledSkills ? this.onGetEnabledSkills(agentId) : { ok: false, error: 'Desktop skills not wired' };
          this._send(ws, { type: 'enabled_skills', agentId, ok: !!(r && r.ok), enabled: r?.enabled || [], error: r?.ok ? null : (r?.error || 'unknown error'), ts: Date.now() });
        } catch (e) {
          this._send(ws, { type: 'enabled_skills', agentId, ok: false, enabled: [], error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }
      case 'set_enabled_skills': {
        if (!client.authenticated) return;
        const agentId = msg.agentId;
        if (!agentId) { this._send(ws, { type: 'enabled_skills_set', ok: false, error: 'agentId required', ts: Date.now() }); return; }
        try {
          const r = this.onSetEnabledSkills ? this.onSetEnabledSkills(agentId, Array.isArray(msg.skillIds) ? msg.skillIds : []) : { ok: false, error: 'Desktop skills not wired' };
          this._send(ws, { type: 'enabled_skills_set', agentId, ok: !!(r && r.ok), enabled: r?.enabled || [], error: r?.ok ? null : (r?.error || 'unknown error'), ts: Date.now() });
        } catch (e) {
          this._send(ws, { type: 'enabled_skills_set', agentId, ok: false, enabled: [], error: e?.message || String(e), ts: Date.now() });
        }
        break;
      }
    }
  }

  // v3.3.0: broadcast the skills list to all connected clients.
  // Used after create/update/delete/seed so every client refreshes
  // its sidebar automatically without polling.
  _broadcastSkillsList() {
    try {
      if (!this.onListSkills) return;
      const r = this.onListSkills();
      const skills = (r && r.skills) || [];
      const payload = { type: 'skills_list_broadcast', skills, ts: Date.now() };
      for (const ws of this.wss.clients) {
        try { this._send(ws, payload); } catch {}
      }
    } catch (e) {
      console.log('[SyncServer] _broadcastSkillsList failed:', e?.message);
    }
  }

  // Synthesize greeting audio on the desktop and send back as an audio_response tagged so the phone can route it to the greeting cache instead…
  async _handleGreetingAudio(ws, text) {
    const localAI = require('./local-ai');
    const stripEmojis = (s) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    const cleanText = stripEmojis(text);
    if (!cleanText) {
      console.warn('[SyncServer] greeting text was all emojis, nothing to synthesize');
      return;
    }
    const resolvedVoice = await this._getTtsVoice();
    const audioBase64 = await localAI.synthesizeSpeech(cleanText, resolvedVoice);
    if (!audioBase64) {
      console.warn('[SyncServer] synthesizeSpeech returned empty for greeting');
      return;
    }
    // Tag the audio_response so the phone knows to cache it as the greeting (vs playing it immediately as an AI reply).
    const payload = {
      type: 'audio_response',
      audioBase64,
      mimeType: 'audio/wav',
      requestId: 'greeting',
      // Echo the source text so the phone can match the
      // audio to its cache key even if the phone's local
      // state has changed since the request.
      text: cleanText,
      // v3.2.96: echo the resolved piper voice so the
      // mobile's per-(phrase, voice) cache writes use the
      // exact key the desktop synthesized against.
      voice: resolvedVoice,
      ts: Date.now(),
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      this._send(ws, payload);
      console.log(`[SyncServer] Sent greeting audio (${audioBase64.length} chars) to mobile`);
    } else {
      // The original WS may have reconnected during the 2-5s synthesis window.
      let sent = false;
      for (const [clientWs, client] of this.clients) {
        if (client.authenticated && clientWs.readyState === WebSocket.OPEN) {
          this._send(clientWs, payload);
          console.log(`[SyncServer] Sent greeting audio (${audioBase64.length} chars) to reconnected mobile`);
          sent = true;
          break;
        }
      }
      if (!sent) console.warn('[SyncServer] greeting audio: no open client to send to');
    }
  }

  // Synthesize working speech audio on the desktop and send back as an audio_response tagged requestId='working_speech'.
  async _handleWorkingAudio(ws, text) {
    const localAI = require('./local-ai');
    const stripEmojis = (s) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    const cleanText = stripEmojis(text);
    if (!cleanText) {
      console.warn('[SyncServer] working speech text was all emojis, nothing to synthesize');
      return;
    }
    const resolvedVoice = await this._getTtsVoice();
    const audioBase64 = await localAI.synthesizeSpeech(cleanText, resolvedVoice);
    if (!audioBase64) {
      console.warn('[SyncServer] synthesizeSpeech returned empty for working speech');
      return;
    }
    const payload = {
      type: 'audio_response',
      audioBase64,
      mimeType: 'audio/wav',
      requestId: 'working_speech',
      text: cleanText,
      // v3.2.96: echo the resolved piper voice for the
      // mobile's per-(phrase, voice) cache key.
      voice: resolvedVoice,
    };
    this._send(ws, payload);
    console.log(`[SyncServer] Sent working speech audio (${audioBase64.length} chars)`);
  }

  // Synthesize exit reply audio on the desktop and send back as an audio_response tagged so the phone can route it to the exit-reply cache.
  async _handleExitReplyAudio(ws, text) {
    const localAI = require('./local-ai');
    const stripEmojis = (s) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    const cleanText = stripEmojis(text);
    if (!cleanText) {
      console.warn('[SyncServer] exit reply text was all emojis, nothing to synthesize');
      return;
    }
    const resolvedVoice = await this._getTtsVoice();
    const audioBase64 = await localAI.synthesizeSpeech(cleanText, resolvedVoice);
    if (!audioBase64) {
      console.warn('[SyncServer] synthesizeSpeech returned empty for exit reply');
      return;
    }
    // Tag the audio_response so the phone knows to cache it as the exit reply (vs the greeting, vs an AI reply).
    const payload = {
      type: 'audio_response',
      audioBase64,
      mimeType: 'audio/wav',
      requestId: 'exit_reply',
      text: cleanText,
      // v3.2.96: echo the resolved piper voice for the
      // mobile's per-(phrase, voice) cache key.
      voice: resolvedVoice,
      ts: Date.now(),
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      this._send(ws, payload);
      console.log(`[SyncServer] Sent exit reply audio (${audioBase64.length} chars) to mobile`);
    } else {
      // Same reconnection fallback as _handleGreetingAudio: the original WS may have reconnected during the 2-5s synthesis window.
      let sent = false;
      for (const [clientWs, client] of this.clients) {
        if (client.authenticated && clientWs.readyState === WebSocket.OPEN) {
          this._send(clientWs, payload);
          console.log(`[SyncServer] Sent exit reply audio (${audioBase64.length} chars) to reconnected mobile`);
          sent = true;
          break;
        }
      }
      if (!sent) console.warn('[SyncServer] exit reply audio: no open client to send to');
    }
  }

  _sendFullState(ws) {
    this._send(ws, { type: 'request_state_from_main' });
    // Replay the latest agents list so a reconnecting mobile can rebuild its companion tab bar.
    if (this._lastAgentsList) {
      console.log(`[SyncServer] Replaying recent agents_list (${this._lastAgentsList.payload.agents.length} agents) to reconnected client`);
      this._send(ws, this._lastAgentsList.payload);
    } else if (this.onRequestAgentsList) {
      console.log('[SyncServer] No cached agents_list — asking main process to refresh');
      try { this.onRequestAgentsList(); } catch (e) { console.log('[SyncServer] onRequestAgentsList failed:', e?.message); }
    }
    // Also replay quests list so a reconnecting mobile restores its quest cache without depending on the HomeScreen's own refresh loop.
    if (this.onRequestQuestsList) {
      // Always ask main.js for a fresh read on full-state replay, instead of using the cached `_lastQuestsList` payload.
      try { this.onRequestQuestsList(); } catch (e) { console.log('[SyncServer] onRequestQuestsList failed in _sendFullState:', e?.message); }
      // Belt-and-braces: also send the cache immediately so the mobile doesn't have to wait for the fresh-broadcast round-trip.
      if (this._lastQuestsList) {
        const replayPayload = {
          ...this._lastQuestsList.payload,
          source: 'cache_replay',
        };
        this._send(ws, replayPayload);
      }
    } else if (this._lastQuestsList) {
      // No fresh-read callback wired (defensive — main.js
      // always registers it). Fall back to the cache.
      console.log(`[SyncServer] Replaying recent quests_list (${this._lastQuestsList.payload.quests.length} quest(s)) to reconnected client (cache only — no onRequestQuestsList)`);
      this._send(ws, this._lastQuestsList.payload);
    }
    // Replay the recent AI messages buffer so a reconnecting mobile catches up on messages that landed during its disconnect.
    if (this._recentAiMessages && this._recentAiMessages.length > 0) {
      console.log(`[SyncServer] Replaying ${this._recentAiMessages.length} recent AI message(s) to reconnected client`);
      for (const entry of this._recentAiMessages) {
        // Tag the payload with replay:true so the mobile can suppress notifications for replays.
        this._send(ws, { ...entry.payload, replay: true });
      }
    }
    // Replay last audio response if it arrived while client was disconnected (60s window)
    if (this._lastAudioResponse && (Date.now() - this._lastAudioResponse.ts) < 60000) {
      console.log('[SyncServer] Replaying recent audio_response to reconnected client');
      this._send(ws, this._lastAudioResponse.payload);
      this._lastAudioResponse = null;
    }
  }

  broadcastState(state) {
    this._broadcast({ type: 'state_sync', ...state, ts: Date.now() });
  }

  broadcastChatMessage(agentId, text, isUser = false, agentName = null, activeQuestId = null, activeQuestName = null, attachments = null, extra = null) {
    // Include activeQuestId + activeQuestName on the realtime chat_message broadcast so the mobile's appendAgentMessage can route incoming…
    const payload = {
      type: 'chat_message',
      agentId,
      agentName,
      text,
      isUser,
      activeQuestId: (typeof activeQuestId === 'string' && activeQuestId) ? activeQuestId : null,
      activeQuestName: activeQuestName || null,
      // v3.3.20: forward attachments for image bubbles.
      // Shape: [{ uri, data, type, name, size }]. Same
      // shape the mobile renders for outbound attachments.
      attachments: (Array.isArray(attachments) && attachments.length > 0) ? attachments : null,
      // v3.6.13: the phone routes chatter to casual chat by forceNoQuest (it
      // never read 'ambient' for routing), so send both.
      ...(extra && extra.ambient ? { ambient: true, forceNoQuest: true } : {}),
      ts: Date.now(),
    };
    // Cache recent AI messages for reconnect replay.
    if (!isUser) {
      if (!this._recentAiMessages) this._recentAiMessages = [];
      this._recentAiMessages.push({ payload, ts: Date.now() });
      if (this._recentAiMessages.length > 50) {
        this._recentAiMessages = this._recentAiMessages.slice(-50);
      }
      // v3.2.23 also keep _lastChatMessage for backward compat
      // with any code path that still reads it.
      this._lastChatMessage = this._recentAiMessages[this._recentAiMessages.length - 1];
    }
    this._broadcast(payload);
  }

  // Broadcast the full list of agents so the mobile can mirror the desktop arena (one companion per agent, not just the active one).
  broadcastAgentsList(agents) {
    if (!Array.isArray(agents) || agents.length === 0) return;
    const payload = { type: 'agents_list', agents, ts: Date.now() };
    this._lastAgentsList = { payload, ts: Date.now() };
    console.log(`[SyncServer] Broadcasting agents_list with ${agents.length} agent(s):`, agents.map(a => a.id).join(','));
    this._broadcast(payload);
  }

  // Broadcast the full list of quests so the mobile can mirror the desktop's quest panel.
  broadcastQuestsList(quests) {
    // Tag fresh broadcasts with `source: 'broadcast'` so the mobile can distinguish them from cached replays (which carry `source:…
    const payload = {
      type: 'quests_list',
      quests: Array.isArray(quests) ? quests : [],
      ts: Date.now(),
      source: 'broadcast',
    };
    this._lastQuestsList = { payload, ts: Date.now() };
    console.log(`[SyncServer] Broadcasting quests_list with ${payload.quests.length} quest(s)`);
    this._broadcast(payload);
  }

  broadcastCompanionChange(companionId) {
    console.log(`[SyncServer] Broadcasting companion change: ${companionId}`);
    this._broadcast({ type: 'companion_id', companionId, ts: Date.now() });
  }

  // TTS voice changed.
  broadcastTtsSettingsChanged(current) {
    console.log(`[SyncServer] Broadcasting tts_settings_changed: ${current}`);
    const payload = { type: 'tts_settings_changed', current, ts: Date.now() };
    this._lastTtsSettings = { payload, ts: Date.now() };
    this._broadcast(payload);
  }

  broadcastTyping(active) {
    this._lastTyping = { type: 'typing', active, ts: Date.now() };
    this._broadcast(this._lastTyping);
  }

  // Broadcast local-LLM status to the mobile.
  broadcastLlmStatus(status) {
    if (!status) return;
    const payload = {
      type: 'llm_status',
      agentId: status.agentId || null,
      model: status.model || null,
      state: status.state,           // 'running' | 'cold' | 'down' | 'too-big' | 'unsupported'
      baseUrl: status.baseUrl || null,
      providerName: status.providerName || null,
      modelId: status.modelId || null,
      vram: status.vram || null,
      ts: Date.now(),
    };
    this._broadcast(payload);
  }

  sendAudioResponse(ws, audioBase64, mimeType = 'audio/mpeg', extra) {
    const payload = { type: 'audio_response', audioBase64, mimeType, ...(extra || {}) };
    // Cache for reconnect replay (5s window)
    this._lastAudioResponse = { payload, ts: Date.now() };
    // Try original ws; fallback to any authenticated client
    if (ws && ws.readyState === WebSocket.OPEN) {
      this._send(ws, payload);
    } else {
      console.log('[SyncServer] audio_response ws closed, sending to any authenticated client');
      let sent = false;
      for (const [clientWs, client] of this.clients) {
        if (client.authenticated && clientWs.readyState === WebSocket.OPEN) {
          this._send(clientWs, payload);
          sent = true;
          break;
        }
      }
      if (!sent) console.warn('[SyncServer] audio_response: no open client to send to');
    }
  }

  sendTranscript(ws, transcript) {
    // Try the original ws first; if closed, find any authenticated client
    const payload = { type: 'voice_transcript_result', transcript };
    if (ws && ws.readyState === WebSocket.OPEN) {
      this._send(ws, payload);
    } else {
      // Fallback: send to first authenticated client
      for (const [clientWs, client] of this.clients) {
        if (client.authenticated && clientWs.readyState === WebSocket.OPEN) {
          this._send(clientWs, payload);
          break;
        }
      }
    }
  }

  sendChatHistory(ws, messages) {
    this._send(ws, { type: 'chat_history', messages, ts: Date.now() });
  }

  // Per-agent chat history for the mobile companion tab bar.
  sendAgentHistory(ws, agentId, source) {
    const payload = { type: 'agent_history', agentId, ts: Date.now() };
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      // Map shape (v3.3.19+).
      payload.buckets = source;
      const defaultBucket = source[Object.keys(source).find(k => k === '__default__') || '__default__']
        || Object.values(source)[0]
        || [];
      if (Array.isArray(defaultBucket)) {
        payload.messages = defaultBucket;
      }
    } else {
      // Legacy flat array.
      payload.messages = Array.isArray(source) ? source : [];
    }
    this._send(ws, payload);
    // v3.6.13: re-send the thinking state after history. Right after a
    // reconnect the phone screen may not be listening yet, so the replay
    // on auth alone was missed and the status bar vanished.
    if (this._lastTyping && this._lastTyping.active && Date.now() - this._lastTyping.ts < 30 * 60 * 1000) {
      this._send(ws, { ...this._lastTyping, replay: true });
    }
  }

  broadcastArenaEvent(event) {
    this._broadcast({ type: 'arena_event', ...event, ts: Date.now() });
  }

  /**
   * Send a remote_tool message to all authenticated mobile clients
   */
  sendRemoteTool(id, op, params) {
    this._broadcast({ type: 'remote_tool', id, op, ...params });
  }

  /** Send a message to all authenticated mobile clients. */
  sendToMobile(payload) {
    const authenticatedEntries = [...this.clients.entries()].filter(([, c]) => c.authenticated);
    if (authenticatedEntries.length === 0) return false;
    const json = JSON.stringify(payload);
    authenticatedEntries.forEach(([ws]) => {
      try { if (ws.readyState === 1) ws.send(json); } catch (_) {}
    });
    return true;
  }

  /**
   * Register a handler for bridge events (emitted by the EventEmitter 'emit' method).
   */
  onBridge(type, handler) {
    this.on(type, handler);
  }

  /**
   * Remove a previously registered bridge handler.
   */
  offBridge(type, handler) {
    this.off(type, handler);
  }

  _send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  _broadcast(obj) {
    const json = JSON.stringify(obj);
    for (const [ws, client] of this.clients) {
      if (client.authenticated && ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  }

  // v3.4.12: shared casual/quest chat context.
  broadcastChatContext(payload) {
    this._lastChatContext = { type: 'chat_context', ...payload, ts: Date.now() };
    this._broadcast(this._lastChatContext);
  }

  _notifyMainWindow(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /** Read the desktop's currently-selected TTS voice (piper voice name, e.g. */
  async _getTtsVoice() {
    try {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        return 'lessac';
      }
      const v = await this.mainWindow.webContents.executeJavaScript(
        "(() => { const s = JSON.parse(localStorage.getItem('cyberclaw-settings') || '{}'); return s.ttsVoice || 'lessac'; })()"
      );
      return v || 'lessac';
    } catch (err) {
      console.warn('[SyncServer] _getTtsVoice failed, using default:', err?.message);
      return 'lessac';
    }
  }

  /**
   * Get server status
   */
  getStatus() {
    const authenticated = [...this.clients.values()].filter(c => c.authenticated);
    return {
      running: !!this.wss,
      port: this.port,

      connectedDevices: authenticated.length,
      devices: authenticated.map(c => ({ id: c.id, name: c.name })),
      pairedDevices: this.config.pairedDevices.map(d => ({ name: d.name, pairedAt: d.pairedAt })),
      locked: Date.now() < this.pairingLockoutUntil
    };
  }

  /**
   * Get local network IPs for display
   */
  static getLocalIPs() {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          ips.push({ interface: name, address: net.address });
        }
      }
    }
    return ips;
  }
}

module.exports = SyncServer;
