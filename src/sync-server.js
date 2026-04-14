/**
 * CyberClaw Sync Server
 * WebSocket server for mobile companion app sync.
 * Runs inside the Electron main process.
 * 
 * Protocol:
 *   Mobile connects → authenticates with pairing code
 *   Bi-directional sync of: companion state, chat messages, arena state
 *   Mobile can send: chat messages, voice transcripts, file references
 *   Desktop sends: AI responses, companion state updates, arena events
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CYBERCLAW_DIR = path.join(os.homedir(), '.openclaw', 'cyberclaw');
const SYNC_CONFIG_FILE = path.join(CYBERCLAW_DIR, 'sync-config.json');

class SyncServer {
  constructor(options = {}) {
    this.port = options.port || 9247;  // CyberClaw sync port
    this.wss = null;
    this.clients = new Map();  // ws → { id, name, authenticated }
    this.pairingCode = null;
    this.pairingExpiry = 0;
    this.mainWindow = options.mainWindow || null;
    this.onChatMessage = options.onChatMessage || null;  // callback for incoming chat from mobile
    this.onVoiceTranscript = options.onVoiceTranscript || null;

    // Load or generate persistent device key
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
   * Generate a 6-digit pairing code, valid for 5 minutes
   */
  generatePairingCode() {
    this.pairingCode = String(Math.floor(100000 + Math.random() * 900000));
    this.pairingExpiry = Date.now() + 5 * 60 * 1000;
    return this.pairingCode;
  }

  /**
   * Start the WebSocket server
   */
  start() {
    if (this.wss) return;

    this.wss = new WebSocket.Server({ port: this.port }, () => {
      console.log(`[SyncServer] Listening on ws://0.0.0.0:${this.port}`);
    });

    this.wss.on('connection', (ws, req) => {
      const clientId = crypto.randomBytes(8).toString('hex');
      const clientInfo = {
        id: clientId,
        name: 'Unknown',
        authenticated: false,
        ip: req.socket.remoteAddress
      };
      this.clients.set(ws, clientInfo);
      console.log(`[SyncServer] Client connected: ${clientId} from ${clientInfo.ip}`);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(ws, msg);
        } catch (e) {
          console.error('[SyncServer] Bad message:', e.message);
        }
      });

      ws.on('close', () => {
        const info = this.clients.get(ws);
        console.log(`[SyncServer] Client disconnected: ${info?.id || 'unknown'}`);
        this.clients.delete(ws);
        this._notifyMainWindow('mobile-disconnected', { clientId: info?.id });
      });

      ws.on('error', (err) => {
        console.error('[SyncServer] Client error:', err.message);
      });

      // Send hello
      this._send(ws, { type: 'hello', version: '1.0.0', requiresAuth: true });
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
      this.clients.clear();
    }
  }

  /**
   * Handle incoming messages from mobile clients
   */
  _handleMessage(ws, msg) {
    const client = this.clients.get(ws);
    if (!client) return;

    switch (msg.type) {
      case 'pair': {
        // Pairing with 6-digit code
        if (!this.pairingCode || Date.now() > this.pairingExpiry) {
          this._send(ws, { type: 'pair_result', success: false, error: 'No active pairing code' });
          return;
        }
        if (msg.code !== this.pairingCode) {
          this._send(ws, { type: 'pair_result', success: false, error: 'Wrong code' });
          return;
        }

        // Generate device token for future auto-connect
        const deviceToken = crypto.randomBytes(32).toString('hex');
        const deviceInfo = {
          token: deviceToken,
          name: msg.deviceName || 'Mobile',
          pairedAt: new Date().toISOString()
        };
        this.config.pairedDevices.push(deviceInfo);
        this._saveConfig();

        client.authenticated = true;
        client.name = deviceInfo.name;
        this.pairingCode = null;  // Invalidate code after use

        this._send(ws, { type: 'pair_result', success: true, token: deviceToken });
        this._notifyMainWindow('mobile-paired', { name: deviceInfo.name });
        console.log(`[SyncServer] Device paired: ${deviceInfo.name}`);
        break;
      }

      case 'auth': {
        // Re-authenticate with saved token
        const device = this.config.pairedDevices.find(d => d.token === msg.token);
        if (!device) {
          this._send(ws, { type: 'auth_result', success: false, error: 'Unknown device' });
          return;
        }
        client.authenticated = true;
        client.name = device.name;
        this._send(ws, { type: 'auth_result', success: true, name: device.name });
        this._notifyMainWindow('mobile-connected', { name: device.name });
        console.log(`[SyncServer] Device authenticated: ${device.name}`);

        // Send current state on connect
        this._sendFullState(ws);
        break;
      }

      case 'chat': {
        // Chat message from mobile
        if (!client.authenticated) return;
        if (this.onChatMessage) {
          this.onChatMessage(msg.text, msg.agentId || 'companion', {
            source: 'mobile',
            deviceName: client.name
          });
        }
        break;
      }

      case 'voice_transcript': {
        // Voice transcript from mobile (after wake word)
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

      case 'request_state': {
        // Mobile requests full state sync
        if (!client.authenticated) return;
        this._sendFullState(ws);
        break;
      }

      case 'companion_interaction': {
        // Feed, play, etc. from mobile
        if (!client.authenticated) return;
        this._notifyMainWindow('mobile-companion-action', msg.action);
        break;
      }

      case 'ping': {
        this._send(ws, { type: 'pong', ts: Date.now() });
        break;
      }
    }
  }

  /**
   * Send full companion state to a client
   */
  _sendFullState(ws) {
    // This will be populated by main.js when it sends state
    this._send(ws, { type: 'request_state_from_main' });
    // Main process should call syncServer.broadcastState() after
  }

  /**
   * Broadcast companion state to all authenticated clients
   */
  broadcastState(state) {
    const msg = { type: 'state_sync', ...state, ts: Date.now() };
    this._broadcast(msg);
  }

  /**
   * Broadcast a chat message (AI response) to mobile clients
   */
  broadcastChatMessage(agentId, text, isUser = false) {
    this._broadcast({
      type: 'chat_message',
      agentId,
      text,
      isUser,
      ts: Date.now()
    });
  }

  /**
   * Broadcast arena event (companion moved, ate treat, etc.)
   */
  broadcastArenaEvent(event) {
    this._broadcast({ type: 'arena_event', ...event, ts: Date.now() });
  }

  /**
   * Send to a specific client
   */
  _send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  /**
   * Broadcast to all authenticated clients
   */
  _broadcast(obj) {
    const json = JSON.stringify(obj);
    for (const [ws, client] of this.clients) {
      if (client.authenticated && ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  }

  /**
   * Notify the Electron main window
   */
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
      pairedDevices: this.config.pairedDevices.map(d => ({ name: d.name, pairedAt: d.pairedAt }))
    };
  }
}

module.exports = SyncServer;
