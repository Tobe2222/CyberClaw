# 3.2.21 — Discord replies now reach the mobile chat (OpenClaw session tail)

## Reported by Tobe (via Discord, screenshot)

Tobe's chat with clawsuu (Discord #cyber-dev, mobile
chat screenshot):

> "@Clawsuu why answer in discord? I asked through
> cyberclaw."

Screenshot showed the mobile chat with two user
messages ("Hello. Have you looked at it?" and
"Heeello") and "Clawsuu is thinking..." at the
bottom — but no agent reply visible. The agent's
reply was actually sent to Discord at 15:56:42 CEST
(gateway log: "Committed messaging text: tool=message
len=1229"), but it never reached the mobile chat.

## Root cause

When the user types in the mobile chat, the desktop's
chat pipeline runs the agent and broadcasts the reply
back to the mobile via `sync-broadcast-chat` IPC.
The renderer's chat panel owns `chatHistoryByAgent`,
which the mobile reads via `request_chat_history` for
the per-companion tab.

When the user types in **Discord** instead, OpenClaw's
gateway routes the message directly to the clawsuu
agent. The agent's reply goes back through OpenClaw's
`message` tool to Discord — the desktop never sees
it. Result: the mobile shows "thinking" forever and
the user thinks the agent is hung, when actually it
already replied to Discord minutes ago.

This is the same architectural gap that has bitten
us before (mobile echo loops in v3.1.26, agent
messages missing from chat history in v3.10.79):
a side-channel reply path bypasses the renderer's
chat pipeline, leaving the mobile UI out of sync.

## Fix

New module `src/openclaw-session-tail.js` that tails
the OpenClaw session JSONL files and bridges
Discord-routed agent replies back into the desktop's
chat pipeline.

**Three pieces:**

### 1. Session JSONL tailer (`openclaw-session-tail.js`)

Polls the OpenClaw session directory every 1.5s for
new bytes in each `*.jsonl` file. JSONL is line-
delimited (one JSON message per line), so we track
the byte offset per file and read only the new bytes.

For each new assistant message in a Discord-routed
session (`sessionKey` matches `:discord:`), the tailer:

- **Emits `onChatMessage`** with the agent's text. Main
  process forwards this to:
  - `syncServer.broadcastChatMessage(...)` — pushes
    to currently-connected mobiles in real time
  - `mainWindow.webContents.send('openclaw-session-chat-message', ...)`
    — adds to renderer's `chatHistoryByAgent` so
    reconnects get the message on the next
    `request_chat_history` pull
- **Emits `onToolCall`** with the tool name. Main
  process forwards this as an `agent_tool` event to
  all connected mobiles — used for the better
  "thinking" indicator (Issue #2 from this round).

The tailer SKIPS sessions that aren't Discord-routed
(sessions with `agent:<id>:main` or similar keys are
the desktop's own chat-pipeline sessions and already
broadcast through the normal `sync-broadcast-chat`
IPC). Avoiding this avoids double-broadcasting.

### 2. Renderer IPC handler (`js/app.js`)

Added `ipcRenderer.on('openclaw-session-chat-message', ...)`
that calls `addChatMsg('agent', text, agentName)` to
inject the message into the renderer's in-memory
`chatHistory` + `chatHistoryByAgent`. Future
`request_chat_history` pulls from any mobile (or
desktop's own history requests) will see the message.

### 3. Preload wiring (`preload.js`)

Exposed `window.cyberclaw.onSessionChatMessage` and
`onSessionTyping` so the renderer can subscribe.

### Tool-call friendly names (`main.js`)

`toolFriendlyName(tool)` maps internal OpenClaw tool
names to short, concise display text:

```
exec → "Running command..."
read → "Reading file..."
write → "Writing file..."
edit → "Editing file..."
message → "Sending message..."
browser → "Browsing..."
web_search → "Searching..."
process → "Running process..."
cron → "Scheduling..."
memory_search → "Searching memory..."
memory_write → "Saving to memory..."
default → "Thinking..."
```

Each entry is one short phrase (~25 chars max). No
prefix or emoji — the indicator bar is already
visually distinct, and a prefix makes it longer than
necessary.

The mobile listens for the `agent_tool` event and
shows the friendly text in the chat-voice-status bar
(where "Clawsuu is thinking..." used to live).

## Files changed

- **NEW** `src/openclaw-session-tail.js` — session
  JSONL tailer module (~280 lines)
- `src/main.js`:
  - Imported `OpenClawSessionTail`
  - Added `toolFriendlyName(tool)` helper
  - Initialized the tailer in `app.whenReady()` with
    `onTyping`, `onChatMessage`, `onToolCall` callbacks
    wired to `syncServer` and the renderer
- `src/preload.js`:
  - Exposed `window.cyberclaw.onSessionChatMessage` and
    `onSessionTyping`
- `src/js/app.js`:
  - Added `ipcRenderer.on('openclaw-session-chat-message', ...)`
    handler that injects into `chatHistoryByAgent`
- `package.json` — version 3.2.20 → 3.2.21

## Companion mobile change (v3.10.87)

Same change shipped from the mobile side. See
`CyberClawMobile/CHANGES_3.10.87.md` for details.

## Lessons

**Architectural gaps between channels turn into
"agent isn't answering" bugs.** This is the third
time the discord-vs-chat-pipeline asymmetry has
caused user-visible bugs (mobile echo loops in
v3.1.26, agent messages missing in v3.10.79,
Discord-only replies invisible in v3.2.21). The
fix in each case is the same: bridge the side
channel into the main pipeline. The pattern keeps
recurring because the desktop's chat pipeline is
the source of truth for mobile, but OpenClaw
treats Discord as a first-class channel. Every
new side channel (voice, mobile, Discord, webchat)
needs an explicit "broadcast to mobile chat"
bridge, or the mobile stays out of sync.

**Tailing JSONL is a reasonable bridge when the
canonical source doesn't notify.** OpenClaw
doesn't push events to the desktop when an
agent reply lands in a Discord-routed session.
We can't add an OpenClaw-side hook without
shipping an OpenClaw patch. But OpenClaw writes
the full agent transcript to JSONL files, and
those are readable from the desktop's filesystem.
Polling 1.5s is fine for chat — humans don't
notice sub-second latency between agent reply
and mobile display. The JSONL format is also
stable, so the parser is simple.

**Skipping the desktop's own pipeline sessions is
load-bearing.** The chat pipeline ALSO writes to
OpenClaw session JSONLs (the desktop spawns
`openclaw agent -m "..."` CLI calls). If we
broadcast every Discord-and-main session, we
double-broadcast the desktop's pipeline replies.
The dedup is via `sessionKey` match — Discord
sessions have `:discord:` in the key, pipeline
sessions have `:main` or `:cron:` or `:subagent:`.
Hard-coded prefix check; could miss edge cases
(custom keys), but works for the standard agent
routing patterns.

**Polling has a fundamental race we accepted.**
If the desktop restarts mid-conversation and the
tailer restarts, it reads `sessions.json` and
seeds file offsets to **current end-of-file** —
no history replay. This means messages that landed
during the restart window are lost. For a desktop
restart that's acceptable (the user knows they
restarted; the previous chat is in Discord and
they can scroll back). For a more robust fix
we'd persist the offsets and resume from last
known, but that adds storage and complexity that
isn't worth it for an edge case.

**Better thinking indicators come from actual
state, not cycling text.** Tobe asked for "short
and concise" and I gave him per-tool-call phrases
("Running command...", "Reading file..."). The
text is short but it's also **accurate** — the
user sees what the agent is actually doing, not a
random "thinking..." rotation. The data source is
the OpenClaw session JSONL, which has the tool
name in every assistant message. Same data
source as the chat-message bridge, just a
different field extracted.