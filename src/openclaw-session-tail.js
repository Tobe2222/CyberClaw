// v3.2.21: OpenClaw session tailer. Watches the OpenClaw
// session JSONL files for clawsuu (and other agents) and
// emits events when the agent receives a Discord-routed
// user message and produces an assistant reply. Used by
// main.js to broadcast typing state + chat messages to
// the mobile, fixing the bug where Discord replies don't
// reach the mobile chat because they bypass the desktop's
// chat pipeline.
//
// Why this exists:
// When the user sends a message via Discord, OpenClaw's
// gateway routes it directly to the clawsuu agent. The
// agent's reply goes back through OpenClaw's `message`
// tool to Discord. The desktop's chat renderer never
// sees this — it only handles replies from its own chat
// pipeline (mobile chat, voice mode, typed desktop chat).
//
// To fix this without OpenClaw cooperation, we tail
// OpenClaw's session JSONL files. When we detect a new
// assistant text message in a Discord-routed session,
// we broadcast it via `sync-broadcast-chat` to the mobile.
//
// We skip sessions whose key matches the desktop's own
// pipeline (e.g. `agent:clawsuu:main`) — those replies
// already go through the chat pipeline's normal path and
// double-broadcasting would create duplicates.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');

class OpenClawSessionTail {
  constructor(options = {}) {
    // Directory containing OpenClaw session JSONL files.
    // Default: <workspace>/sessions/ for the configured
    // agent. The desktop knows the workspace from
    // OPENCLAW_AGENT_DIR or the agent config.
    this.sessionsDir = options.sessionsDir ||
      path.join(os.homedir(), '.openclaw', 'agents', 'clawsuu', 'sessions');
    this.agentId = options.agentId || 'clawsuu';
    this.onTyping = options.onTyping || (() => {});
    this.onChatMessage = options.onChatMessage || (() => {});
    // v3.2.21: tool-call events for the better "thinking"
    // indicator on the mobile. The tailer watches for
    // assistant messages that contain tool calls and
    // emits a "tool-call" event with the tool name. The
    // mobile uses this to show short, accurate progress
    // ("💭 Running command..." vs "💭 Reading file...").
    this.onToolCall = options.onToolCall || (() => {});
    this.onLog = options.onLog || (() => {});

    // Map: sessionFilePath -> lastReadOffset (in bytes).
    // Tracks how much of each session file we've already
    // consumed so we only emit NEW entries.
    this.fileOffsets = new Map();
    // Map: sessionFilePath -> sessionKey. We need this
    // to know which sessions are Discord-routed.
    this.fileToKey = new Map();
    // Map: sessionFilePath -> last message id we've
    // already broadcast. Even within a single file,
    // session turns reuse the file across multiple model
    // runs — we need to track which assistant messages
    // have been emitted so we don't double-broadcast.
    this.fileLastBroadcastId = new Map();
    // Set of message ids that are "owned" by the
    // desktop's own chat pipeline. The chat pipeline
    // emits assistant messages via addChatMsg + the
    // sync-broadcast-chat IPC. If we see the same
    // message id here (because the chat pipeline's agent
    // run also wrote to the same OpenClaw session), we
    // skip it. Set externally by main.js when the chat
    // pipeline runs an agent.
    this.pipelineOwnedIds = new Set();
  }

  // Called by main.js when the desktop's chat pipeline
  // emits an assistant message. We add the message id to
  // a "don't re-emit" set so the tail doesn't broadcast
  // it twice. Message ids are unique enough to use as
  // dedup keys (OpenClaw's JSONL uses uuid-style ids).
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

      // Start a polling loop. fs.watch is unreliable on
      // Linux when files are appended to vs rewritten,
      // and OpenClaw appends. Polling every 1.5s is good
      // enough for "near-real-time" delivery to mobile.
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
    // sessions.json contains an array of session metadata
    // including sessionId and sessionKey. We rebuild
    // fileToKey based on filenames.
    const sessionsFile = path.join(this.sessionsDir, 'sessions.json');
    let sessions = [];
    try {
      const raw = fs.readFileSync(sessionsFile, 'utf8');
      const parsed = JSON.parse(raw);
      sessions = parsed.sessions || (Array.isArray(parsed) ? parsed : []);
    } catch (e) {
      // sessions.json may not exist yet on a fresh install
      return;
    }
    for (const s of sessions) {
      if (s.sessionId) {
        const fp = path.join(this.sessionsDir, `${s.sessionId}.jsonl`);
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
        for (const line of lines) {
          this.processLine(fp, line);
        }
      } catch (e) {
        // File might be in the middle of being written;
        // skip this round.
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

    // Only handle the clawsuu agent (or whatever this tail
    // is configured for). We can identify by the
    // sessionKey in fileToKey, but session keys aren't
    // per-message — they're per-file. Since the desktop
    // only configures ONE tail per agent, and the
    // sessionsDir is per-agent, we can safely process
    // all entries here.
    if (msg.role !== 'assistant') return;

    // Only handle messages with text content (skip
    // toolCall-only and toolResult-only messages).
    if (!Array.isArray(msg.content)) return;
    // v3.2.21: tool-call detection. If the assistant
    // message contains a tool call (not just text),
    // emit a tool-call event so the mobile can show
    // "💭 Running command..." or similar. We only emit
    // for Discord-routed sessions to match the chat
    // pipeline scope (the desktop's own pipeline
    // already shows progress via the renderer's
    // typing bubble).
    const sessionKey = this.fileToKey.get(filePath) || '';
    const isDiscord = this.isDiscordSessionKey(sessionKey);
    if (isDiscord) {
      for (const part of msg.content) {
        if (part && part.type === 'toolCall' && part.name) {
          this.onToolCall({ tool: part.name, sessionKey });
        }
      }
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

    // Skip if this session isn't Discord-routed. The
    // chat pipeline uses `agent:<id>:main` and similar
    // keys; Discord sessions have `:discord:` in the key.
    if (!isDiscord) {
      // Not a Discord session — skip. The chat pipeline
      // already handles these.
      return;
    }

    // Skip if this message is from before our start()
    // (fileOffsets already handles this, but double-check).
    // If fileOffsets is 0 for this file, we may be reading
    // from the beginning — that's fine, just don't track
    // lastBroadcastId for entries that came before start().

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
