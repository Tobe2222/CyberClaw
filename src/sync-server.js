/**
 * CyberClaw Sync Server
 * Secure WebSocket server (WSS) for mobile companion app sync.
 * Runs inside the Electron main process.
 * 
 * Security:
 *   - Self-signed TLS certificate (auto-generated on first run)
 *   - Pairing via 6-digit code (5-minute expiry)
 *   - Device tokens for auto-reconnect (HMAC-signed)
 *   - Rate-limited pairing attempts (3 wrong → 5-min lockout)
 *   - Unauthenticated connections dropped after 10 seconds
 *   - Safe for port forwarding (port 9247)
 * 
 * Protocol:
 *   Mobile connects → authenticates with pairing code or saved token
 *   Bi-directional sync of: companion state, chat messages, arena events
 */

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

    // v3.1.46: track the most recent wake_training_progress per
    // agent so a phone that lost its WebSocket mid-training (and
    // reconnected) can pick up where the bar should be. Without
    // this, a phone that reconnects during a 15-minute training
    // sees a frozen 30% bar and a red "Last event: 60s+ ago"
    // indicator until the training finishes — because the
    // _broadcast() call iterates this.clients and the phone's
    // old ws is already disconnected. The phone's watchdog
    // (poll every 20s for the cached wake_training_result) is
    // what surfaces this — main.js attaches the latest progress
    // to the result reply so the trainer can re-paint the bar.
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
  _handleMessage(ws, msg) {
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
        if (!client.authenticated) return;
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

      case 'audio_input': {
        if (!client.authenticated) return;
        if (this.onAudioInput) {
          this.onAudioInput(msg.audioBase64, msg.mimeType || 'audio/wav', ws, {
            source: 'mobile',
            deviceName: client.name
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

      // v3.1.16: explicit agents-list refresh. The mobile can fire
      // this if the user did something that should rebuild the
      // companion tab bar (e.g. pulled-to-refresh, or the desktop
      // announced a change). Same code path as request_state for
      // the agents list half — the cache or the refresh callback
      // is used.
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

      // v3.1.95: explicit quests-list refresh. Mobile asks the desktop
      // for the full list of quests. Same code path as
      // request_agents_list — replay the cached payload if we have
      // it, otherwise ask the main process to trigger a fresh
      // broadcast via onRequestQuestsList.
      //
      // v3.1.52: Tobe's v3.8.0 testing found that the
      // _lastQuestsList cache could be stale (the broadcast
      // path that updates the cache was failing silently in
      // some scenario), so an explicit request from the
      // mobile would replay stale data. Always re-read from
      // disk on explicit request — the file is small and
      // loadQuests is fast (O(n) over typically <20 quests).
      case 'request_quests_list': {
        if (!client.authenticated) return;
        console.log(`[SyncServer] Mobile requested quests list refresh (name=${client.name})`);
        if (this.onRequestQuestsList) {
          try { this.onRequestQuestsList(); } catch (e) { console.log('[SyncServer] onRequestQuestsList failed:', e?.message); }
        } else if (this._lastQuestsList) {
          this._send(ws, this._lastQuestsList.payload);
        }
        break;
      }

      // v3.8.0: phone-side quest edit. The mobile can now
      // edit quests over WebSocket. Each inbound message
      // routes to a callback in main.js that performs the
      // mutation using the same loadQuests → modify →
      // saveQuests flow the desktop's IPC handlers use. The
      // save triggers a `quests_list` broadcast (existing
      // path) so the mobile's optimistic update is replaced
      // with the canonical data within ~100ms.
      //
      // Ack protocol: if the mutation succeeds, no ack is
      // sent — the mobile just waits for the next
      // `quests_list` broadcast to confirm. If it fails
      // (quest not found, invalid id, etc.), we send a
      // `quests_update_failed` ack with the action and id
      // so the mobile can roll back its optimistic update
      // and show an error.
      case 'set_quest_active': {
        if (!client.authenticated) return;
        const { id } = msg;
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
            this._send(ws, { type: 'quests_update_failed', action: 'update_quest', id, error: 'quest not found' });
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

      case 'ping': {
        this._send(ws, { type: 'pong', ts: Date.now() });
        break;
      }

      case 'remote_tool_result': {
        if (!client.authenticated) return;
        // Emit so the remote-tool-bridge can resolve the pending promise
        this.emit('remote_tool_result', msg);
        break;
      }

      // v3.1.91: mobile asks the desktop to synthesize
      // speech audio for the wake greeting phrase. The
      // device-side native TTS is unavailable on some
      // Android skins (no engine installed), so the phone
      // has the desktop synthesize the audio and caches it
      // locally for instant playback on wake events. The
      // request is async: the desktop calls piper TTS via
      // local-ai.synthesizeSpeech and sends back an
      // audio_response tagged with requestId='greeting' so
      // the phone can route it to the greeting cache.
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

      // v3.2.29 (sibling of request_greeting_audio): mobile
      // asks the desktop to synthesize the exit reply
      // phrase. Same piper TTS path as the greeting, but
      // the audio_response is tagged requestId='exit_reply'
      // so the phone routes it to the exit-reply cache
      // instead of the greeting cache. Mobile plays the
      // cached audio on voice-mode close.
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

      // v3.2.0: mobile asks the desktop to start a custom
      // openWakeWord training job. We just emit the request;
      // main.js picks it up, runs the same training script
      // that the IPC handler `agent:train-wake-phrase` uses,
      // and routes progress + completion back to the mobile
      // via this.syncServer.sendToMobile({type: 'wake_training_...'}).
      //
      // Why not call the IPC handler directly: the IPC handler
      // is registered on the desktop renderer's webContents
      // invocation, not from main.js itself. Going through an
      // event gives us the same spawn-and-stream behavior with
      // a single shared implementation.
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

      // v3.1.40: mobile asks the desktop for the most recent
      // wake-training result for an agent. Used on reconnect /
      // remount: the phone lost its socket mid-training (Android
      // background-killed it, network blip, etc.) and the desktop
      // finished the run while the phone was offline. We cache the
      // last result per agent for 15 minutes so the phone can pick
      // up where it left off without re-recording and re-training.
      case 'get_latest_wake_training_result': {
        console.log(`[SyncServer] get_latest_wake_training_result from ${client.name || '?'} agentId=${msg.agentId}`);
        if (!client.authenticated) return;
        if (!msg.agentId) {
          this._send(ws, { type: 'wake_training_result', ok: false, error: 'agentId required' });
          return;
        }
        // v3.1.46: if main.js has cached a recent wake_training_progress
        // for this agent, attach it to the reply. The phone's
        // watchdog polls this case every 20s while training is
        // active; the phone uses the latest progress to re-paint
        // the bar if its own WebSocket was dead when the progress
        // events fired (broadcast skips dead ws). Without this,
        // a phone that reconnects mid-training sees a frozen 30%
        // bar until the training actually finishes.
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

      // v3.2.0: mobile asks for the bytes of a previously-trained
      // .tflite. Returns base64. Used after wake_training_done
      // arrives so the phone can store the model locally and
      // hot-swap the wake interpreter.
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

      // v3.5.0: exit-phrase training. Parallel to wake
      // training but keyed by phrase instead of agentId
      // (exit phrases are user-level, not per-companion).
      // The same train_wake_phrase.py script runs either
      // way — openWakeWord is a generic binary wake-word
      // classifier; the phrase string doesn't change the
      // training pipeline. We just route to a different
      // working directory keyed on phrase, and the model
      // comes back via a parallel `exit_*` message chain.
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

      // v3.6.0: send-word training. Same shape as the exit
      // cases above: per-phrase scope (the send word is
      // user-level, not per-companion), separate message
      // chain so the three pipelines don't collide. The
      // mobile's SendPhraseTrainer has shipped since
      // v3.6.0 but the desktop was missing these cases
      // — the request fell into the default arm and the
      // trainer stuck at "Uploading samples to desktop…"
      // indefinitely. Adding them closes the loop.
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
    }
  }

  // v3.1.91: synthesize greeting audio on the desktop and
  // send back as an audio_response tagged so the phone can
  // route it to the greeting cache instead of the AI-reply
  // playback path. Synthesizes with the same piper voice
  // the desktop uses for AI replies so the greeting
  // matches the in-conversation voice.
  async _handleGreetingAudio(ws, text) {
    const localAI = require('./local-ai');
    const stripEmojis = (s) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    const cleanText = stripEmojis(text);
    if (!cleanText) {
      console.warn('[SyncServer] greeting text was all emojis, nothing to synthesize');
      return;
    }
    const audioBase64 = await localAI.synthesizeSpeech(cleanText, 'lessac');
    if (!audioBase64) {
      console.warn('[SyncServer] synthesizeSpeech returned empty for greeting');
      return;
    }
    // Tag the audio_response so the phone knows to cache
    // it as the greeting (vs playing it immediately as an
    // AI reply). The phone keys its cache by audio hash or
    // stores the raw base64 with the phrase as the key.
    const payload = {
      type: 'audio_response',
      audioBase64,
      mimeType: 'audio/wav',
      requestId: 'greeting',
      // Echo the source text so the phone can match the
      // audio to its cache key even if the phone's local
      // state has changed since the request.
      text: cleanText,
      ts: Date.now(),
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      this._send(ws, payload);
      console.log(`[SyncServer] Sent greeting audio (${audioBase64.length} chars) to mobile`);
    } else {
      // v3.1.32: the original WS may have reconnected
      // during the 2-5s synthesis window. Fall back to
      // any currently-authenticated client, same
      // pattern as sendAudioResponse. Without this, a
      // brief network blip between the synthesis
      // request and the audio response would silently
      // drop the cache write.
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

  // v3.2.29: synthesize exit reply audio on the desktop
  // and send back as an audio_response tagged so the
  // phone can route it to the exit-reply cache. Same
  // piper TTS path as _handleGreetingAudio — the only
  // difference is the requestId so the phone knows
  // which cache to write to. Synthesizes with the
  // same piper voice as greetings and AI replies so
  // the exit reply matches the in-conversation voice.
  async _handleExitReplyAudio(ws, text) {
    const localAI = require('./local-ai');
    const stripEmojis = (s) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    const cleanText = stripEmojis(text);
    if (!cleanText) {
      console.warn('[SyncServer] exit reply text was all emojis, nothing to synthesize');
      return;
    }
    const audioBase64 = await localAI.synthesizeSpeech(cleanText, 'lessac');
    if (!audioBase64) {
      console.warn('[SyncServer] synthesizeSpeech returned empty for exit reply');
      return;
    }
    // Tag the audio_response so the phone knows to
    // cache it as the exit reply (vs the greeting, vs
    // an AI reply). The phone keys its cache by phrase
    // string.
    const payload = {
      type: 'audio_response',
      audioBase64,
      mimeType: 'audio/wav',
      requestId: 'exit_reply',
      text: cleanText,
      ts: Date.now(),
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      this._send(ws, payload);
      console.log(`[SyncServer] Sent exit reply audio (${audioBase64.length} chars) to mobile`);
    } else {
      // Same reconnection fallback as _handleGreetingAudio:
      // the original WS may have reconnected during the
      // 2-5s synthesis window. Without this, a brief
      // network blip would silently drop the cache write.
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
    // v3.1.17: replay the latest agents list so a reconnecting
    // mobile can rebuild its companion tab bar. Without this, only
    // a client connected during the initial arena init would have
    // any agents at all.
    //
    // v3.1.16: the previous code gated this on a 10-minute TTL
    // `(Date.now() - this._lastAgentsList.ts) < 600000`, but that's
    // wrong — a user who starts the desktop, walks away for an
    // hour, then opens the mobile app would find the agents list
    // never replays. The list itself is small and the desktop is
    // the source of truth, so always replay it as long as the
    // cache exists. If the cache is empty (mobile connected before
    // the renderer's first broadcast), we ask the main process to
    // trigger a fresh broadcast.
    if (this._lastAgentsList) {
      console.log(`[SyncServer] Replaying recent agents_list (${this._lastAgentsList.payload.agents.length} agents) to reconnected client`);
      this._send(ws, this._lastAgentsList.payload);
    } else if (this.onRequestAgentsList) {
      console.log('[SyncServer] No cached agents_list — asking main process to refresh');
      try { this.onRequestAgentsList(); } catch (e) { console.log('[SyncServer] onRequestAgentsList failed:', e?.message); }
    }
    // v3.1.95: also replay quests list so a reconnecting mobile
    // restores its quest cache without depending on the
    // HomeScreen's own refresh loop. Quests are persisted to
    // AsyncStorage on the mobile side too, but replay means the
    // mobile is consistent with the desktop within ~1 RTT after
    // auth completes.
    if (this._lastQuestsList) {
      console.log(`[SyncServer] Replaying recent quests_list (${this._lastQuestsList.payload.quests.length} quest(s)) to reconnected client`);
      this._send(ws, this._lastQuestsList.payload);
    } else if (this.onRequestQuestsList) {
      console.log('[SyncServer] No cached quests_list — asking main process to refresh');
      try { this.onRequestQuestsList(); } catch (e) { console.log('[SyncServer] onRequestQuestsList failed:', e?.message); }
    }
    // Replay last chat message if it arrived while client was disconnected (60s window)
    if (this._lastChatMessage && (Date.now() - this._lastChatMessage.ts) < 60000) {
      console.log('[SyncServer] Replaying recent chat_message to reconnected client');
      this._send(ws, this._lastChatMessage.payload);
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

  broadcastChatMessage(agentId, text, isUser = false, agentName = null) {
    const payload = { type: 'chat_message', agentId, agentName, text, isUser, ts: Date.now() };
    // Cache last AI message for reconnect replay
    if (!isUser) this._lastChatMessage = { payload, ts: Date.now() };
    this._broadcast(payload);
  }

  // v3.1.15: broadcast the full list of agents so the mobile can mirror
  // the desktop arena (one companion per agent, not just the active one).
  // Each entry: { id, name, sprite, scale, emoji }
  // v3.1.17: cache the last agents list so a reconnecting client can
  // get the current list even if it wasn't connected during the
  // initial arena init.
  broadcastAgentsList(agents) {
    if (!Array.isArray(agents) || agents.length === 0) return;
    const payload = { type: 'agents_list', agents, ts: Date.now() };
    this._lastAgentsList = { payload, ts: Date.now() };
    console.log(`[SyncServer] Broadcasting agents_list with ${agents.length} agent(s):`, agents.map(a => a.id).join(','));
    this._broadcast(payload);
  }

  // v3.1.95: broadcast the full list of quests so the mobile can
  // mirror the desktop's quest panel. Each entry is the full
  // quest object as stored in ~/.openclaw/cyberclaw/quests.json
  // (id, name, description, status, directory, goals, created,
  // etc). The mobile renders a read-only list (cache is keyed by
  // companionId on the phone side; the full list is shared
  // globally on the desktop so the mobile just gets the same
  // array). Cache the last payload so a reconnecting client gets
  // the current list even if it disconnected after the initial
  // broadcast.
  broadcastQuestsList(quests) {
    const payload = { type: 'quests_list', quests: Array.isArray(quests) ? quests : [], ts: Date.now() };
    this._lastQuestsList = { payload, ts: Date.now() };
    console.log(`[SyncServer] Broadcasting quests_list with ${payload.quests.length} quest(s)`);
    this._broadcast(payload);
  }

  broadcastCompanionChange(companionId) {
    console.log(`[SyncServer] Broadcasting companion change: ${companionId}`);
    this._broadcast({ type: 'companion_id', companionId, ts: Date.now() });
  }

  broadcastTyping(active) {
    this._broadcast({ type: 'typing', active, ts: Date.now() });
  }

  sendAudioResponse(ws, audioBase64, mimeType = 'audio/mpeg') {
    const payload = { type: 'audio_response', audioBase64, mimeType };
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

  // v3.1.17: per-agent chat history for the mobile companion tab bar.
  // Each tab on the mobile shows only the chat history for the
  // selected companion. The desktop stores chatHistoryByAgent[id]
  // so we just look up and send the requested agent's history.
  sendAgentHistory(ws, agentId, messages) {
    this._send(ws, { type: 'agent_history', agentId, messages, ts: Date.now() });
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

  /**
   * Send a message to all authenticated mobile clients.
   * Returns true if at least one client was reachable, false if no device connected.
   */
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

  _notifyMainWindow(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
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
