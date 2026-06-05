/**
 * RemoteToolBridge — lets the desktop agent call ops on paired mobile devices.
 * Sends remote_tool messages via syncServer and awaits remote_tool_result responses.
 *
 * Class-based API (v2):
 *   const RemoteToolBridge = require('./remote-tool-bridge');
 *   const bridge = new RemoteToolBridge(syncServer);
 *   const result = await bridge.call('file_read', { path: '/sdcard/Download/foo.txt' });
 *   // → { ok: true, data: { content: '<base64>' } }
 *
 * Renderer can also call via IPC:
 *   ipcRenderer.invoke('remote-tool:call', { op, params, timeoutMs })
 *
 * Module-level convenience (backward compat):
 *   const bridge = require('./remote-tool-bridge');
 *   bridge.init(syncServer);
 *   await bridge.remoteToolCall('op', params, timeoutMs);
 */
const { ipcMain } = require('electron');
const crypto = require('crypto');

class RemoteToolBridge {
  constructor(syncServer) {
    this._syncServer = syncServer;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._init();
  }

  _init() {
    // Listen for results coming back from mobile
    this._syncServer.onBridge('remote_tool_result', (msg) => {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pending.delete(msg.id);
      pending.resolve({ ok: msg.ok, data: msg.data, error: msg.error });
    });

    // IPC handler so renderer can also call remote tools
    ipcMain.handle('remote-tool:call', async (event, { op, params, timeoutMs }) => {
      return this.call(op, params || {}, timeoutMs || 15000);
    });
  }

  /**
   * Call an op on the connected mobile device.
   * Returns { ok, data, error }
   */
  async call(op, params = {}, timeoutMs = 15000) {
    const id = crypto.randomUUID();
    const msg = { type: 'remote_tool', id, op, ...params };

    // Check if any mobile client is connected
    const sent = this._syncServer.sendToMobile(msg);
    if (!sent) return { ok: false, error: 'no_device_connected' };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      this._pending.set(id, { resolve, timer });
    });
  }

  destroy() {
    ipcMain.removeHandler('remote-tool:call');
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: 'destroyed' });
    }
    this._pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton for backward compatibility with init()/remoteToolCall()
// ---------------------------------------------------------------------------
let _instance = null;

function init(syncServer) {
  if (_instance) {
    console.warn('[RemoteToolBridge] init() called twice — ignoring second call');
    return;
  }
  _instance = new RemoteToolBridge(syncServer);
  console.log('[RemoteToolBridge] Initialised');
}

async function remoteToolCall(op, params = {}, timeoutMs = 15000) {
  if (!_instance) return { ok: false, error: 'bridge_not_initialised' };
  return _instance.call(op, params, timeoutMs);
}

module.exports = RemoteToolBridge;
module.exports.init = init;
module.exports.remoteToolCall = remoteToolCall;
