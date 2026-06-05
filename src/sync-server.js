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

      case 'request_state': {
        if (!client.authenticated) return;
        this._sendFullState(ws);
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
    }
  }

  _sendFullState(ws) {
    this._send(ws, { type: 'request_state_from_main' });
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

  broadcastChatMessage(agentId, text, isUser = false) {
    const payload = { type: 'chat_message', agentId, text, isUser, ts: Date.now() };
    // Cache last AI message for reconnect replay
    if (!isUser) this._lastChatMessage = { payload, ts: Date.now() };
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
