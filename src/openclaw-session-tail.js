// OpenClaw session tailer.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');

class OpenClawSessionTail {
  constructor(options = {}) {
    // Directory containing OpenClaw session JSONL files.
    this.sessionsDir = options.sessionsDir ||
      path.join(os.homedir(), '.openclaw', 'agents', 'clawsuu', 'sessions');
    this.agentId = options.agentId || 'clawsuu';
    this.onTyping = options.onTyping || (() => {});
    this.onChatMessage = options.onChatMessage || (() => {});
    // Tool-call events for the better "thinking" indicator on the mobile.
    this.onToolCall = options.onToolCall || (() => {});
    this.onLog = options.onLog || (() => {});

    // Map: sessionFilePath -> lastReadOffset (in bytes).
    // Tracks how much of each session file we've already
    // consumed so we only emit NEW entries.
    this.fileOffsets = new Map();
    // Map: sessionFilePath -> sessionKey. We need this
    // to know which sessions are Discord-routed.
    this.fileToKey = new Map();
    // Map: sessionFilePath -> last message id we've already broadcast.
    this.fileLastBroadcastId = new Map();
    // Set of message ids that are "owned" by the desktop's own chat pipeline.
    this.pipelineOwnedIds = new Set();
  }

  // Called by main.js when the desktop's chat pipeline emits an assistant message.
  markPipelineOwned(messageId) {
    if (messageId) this.pipelineOwnedIds.add(messageId);
  }

  // Initial scan: build the fileToKey map from sessions.json
  // and seed fileOffsets to end-of-file (don't replay history).
  async start() {
    try {
      // Read sessions.json to map sessionId -> sessionKey.
      // This file is updated by OpenClaw on each session
      // start. We refresh it periodically.
      await this.refreshSessionKeys();

      // Walk the sessions directory and seed offsets to
      // current end-of-file. We don't replay history;
      // only NEW content emitted after start() is broadcast.
      const files = fs.readdirSync(this.sessionsDir)
        .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.'))
        .filter(f => !f.includes('.reset.'))
        .filter(f => !f.includes('.checkpoint.'))
        .filter(f => !f.includes('.trajectory.'));
      for (const f of files) {
        const fp = path.join(this.sessionsDir, f);
        const stat = fs.statSync(fp);
        this.fileOffsets.set(fp, stat.size);
      }
      this.onLog('info', `SessionTail seeded ${files.length} files at end-of-file (no history replay)`);

      // Start a polling loop.
      this.pollTimer = setInterval(() => this.pollFiles(), 1500);

      // Refresh session keys every 10s so new sessions
      // are picked up.
      this.refreshTimer = setInterval(() => this.refreshSessionKeys(), 10000);
    } catch (e) {
      this.onLog('error', `SessionTail start failed: ${e.message}`);
    }
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.pollTimer = null;
    this.refreshTimer = null;
  }

  async refreshSessionKeys() {
    // Sessions.json can be either a list (older format) or a dict keyed by sessionKey (newer format).
    const sessionsFile = path.join(this.sessionsDir, 'sessions.json');
    let entries = [];
    try {
      const raw = fs.readFileSync(sessionsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        entries = parsed;
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.sessions)) {
          entries = parsed.sessions;
        } else {
          // Dict format: keys are sessionKeys, values
          // are the entry objects. Flatten into a list,
          // remembering each entry's key from the dict key.
          entries = Object.entries(parsed).map(
            ([key, value]) => ({ ...value, key })
          );
        }
      }
    } catch (e) {
      // sessions.json may not exist yet on a fresh install
      return;
    }
    for (const s of entries) {
      // Prefer s.sessionFile (basename) over s.sessionId for the JSONL filename.
      const fname = s.sessionFile
        ? path.basename(s.sessionFile)
        : (s.sessionId ? `${s.sessionId}.jsonl` : null);
      if (fname) {
        const fp = path.join(this.sessionsDir, fname);
        this.fileToKey.set(fp, s.key || '');
      }
    }
  }

  isDiscordSessionKey(key) {
    return typeof key === 'string' && key.includes(':discord:');
  }

  pollFiles() {
    let files;
    try {
      files = fs.readdirSync(this.sessionsDir)
        .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.'))
        .filter(f => !f.includes('.reset.'))
        .filter(f => !f.includes('.checkpoint.'))
        .filter(f => !f.includes('.trajectory.'));
    } catch (e) {
      this.onLog('error', `SessionTail poll: readdir failed: ${e.message}`);
      return;
    }
    for (const f of files) {
      const fp = path.join(this.sessionsDir, f);
      try {
        const stat = fs.statSync(fp);
        const lastOffset = this.fileOffsets.get(fp) || 0;
        if (stat.size <= lastOffset) {
          // No new content. Could be a file rewrite (size
          // shrunk) — in that case reset to 0 to re-read.
          if (stat.size < lastOffset) {
            this.fileOffsets.set(fp, 0);
          }
          continue;
        }
        // Read the new bytes.
        const fd = fs.openSync(fp, 'r');
        const len = stat.size - lastOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, lastOffset);
        fs.closeSync(fd);
        this.fileOffsets.set(fp, stat.size);
        // Split on newlines; JSONL is line-delimited.
        const newContent = buf.toString('utf8');
        const lines = newContent.split('\n').filter(l => l.trim());
        if (lines.length > 0) {
          this.onLog('debug', `SessionTail: read ${lines.length} new lines from ${f} (delta=${len}b, sessionKey=${this.fileToKey.get(fp) || 'unknown'})`);
        }
        for (const line of lines) {
          this.processLine(fp, line);
        }
      } catch (e) {
        // File might be in the middle of being written;
        // skip this round.
        this.onLog('error', `SessionTail poll: error reading ${f}: ${e.message}`);
      }
    }
  }

  processLine(filePath, line) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      return;
    }
    if (!entry || entry.type !== 'message') return;
    const msg = entry.message;
    if (!msg) return;

    // Only handle the clawsuu agent (or whatever this tail is configured for).
    if (msg.role !== 'assistant') return;

    // Only handle messages with text content (skip
    // toolCall-only and toolResult-only messages).
    if (!Array.isArray(msg.content)) return;
    // Tool-call detection.
    const sessionKey = this.fileToKey.get(filePath) || '';
    const isDiscord = this.isDiscordSessionKey(sessionKey);
    if (!isDiscord && sessionKey) {
      // Chat-pipeline session (or cron/webchat, all classified as non-Discord).
      for (const part of msg.content) {
        if (part && part.type === 'toolCall' && part.name) {
          this.onLog('debug', `SessionTail: tool call detected: ${part.name} in session ${path.basename(filePath)}`);
          this.onToolCall({ tool: part.name, sessionKey });
        }
      }
    } else if (isDiscord) {
      // Explicitly suppress tool events for Discord-routed runs.
      this.onLog('debug', `SessionTail: suppressing tool call from Discord session ${path.basename(filePath)}`);
    } else if (!sessionKey) {
      // SessionKey is empty — sessions.json hasn't been populated yet for this file.
      this.onLog('debug', `SessionTail: file ${path.basename(filePath)} has no sessionKey mapping (sessions.json out of sync)`);
      // Trigger a refresh of sessions.json so future
      // polls pick up the mapping.
      this.refreshSessionKeys();
    }
    let text = '';
    for (const part of msg.content) {
      if (part && part.type === 'text' && typeof part.text === 'string') {
        text += part.text;
      }
    }
    if (!text || !text.trim()) return;

    // Skip if we've already broadcast this message.
    const msgId = entry.id;
    if (!msgId) return;
    if (this.pipelineOwnedIds.has(msgId)) return;
    if (this.fileLastBroadcastId.get(filePath) === msgId) return;

    // Only broadcast FINAL replies, not mid-run continuations.
    const stopReason = msg.stopReason;
    const isFinalReply =
      !stopReason || stopReason === 'stop' || stopReason === 'end_turn' || stopReason === 'max_tokens';
    if (!isFinalReply) {
      // Mid-run tool-use message — don't broadcast.
      this.fileLastBroadcastId.set(filePath, msgId);
      return;
    }

    // Skip if this session isn't Discord-routed. The
    // chat pipeline uses `agent:<id>:main` and similar
    // keys; Discord sessions have `:discord:` in the key.
    if (!isDiscord) {
      // Not a Discord session — skip. The chat pipeline
      // already handles these.
      return;
    }

    // Skip if this message is from before our start() (fileOffsets already handles this, but double-check).

    // Broadcast typing-off + chat message.
    this.onTyping(false);
    // Extract an agent display name from the session key
    // for the chat message metadata.
    const agentName = this.agentId;
    this.onChatMessage({
      agentId: this.agentId,
      agentName,
      text: text.trim(),
      isUser: false,
    });
    this.fileLastBroadcastId.set(filePath, msgId);
    // Keep the dedup set bounded.
    if (this.pipelineOwnedIds.size > 1000) {
      const arr = [...this.pipelineOwnedIds];
      this.pipelineOwnedIds = new Set(arr.slice(-500));
    }
  }
}

module.exports = { OpenClawSessionTail };
