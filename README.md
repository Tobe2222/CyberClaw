# ⚔️ CyberClaw

**RPG-style desktop companion for [OpenClaw](https://github.com/openclaw/openclaw) AI agents.**

Talk to your companions, manage quests, train personalized wake phrases, and pair
your phone for voice and remote agent reach — all from one Electron app.

> **Status:** Active development. Current tag: **v3.2.13**.

Pairs with [CyberClaw Mobile](https://github.com/Tobe2222/Cyber_Claw_Mobile)
over a local WebSocket. See [Mobile README](../cyberclaw-mobile/CyberClawMobile/README.md)
for the phone side.

---

## ✨ What it does

- 🎠 **Companion carousel** — rotating 3D wheel of all your AI companions, each
  bound to one OpenClaw agent (clawsuu, lamasuu, …)
- 👑 **Party leader** — your primary companion always visible in the leader panel
- 🏟️ **Pixel arena** — animated companion sprite with chat panel overlaid
- 💬 **Chat + voice** — text and push-to-talk / wake-triggered voice with
  the agent. TTS via Piper (local), streamed to the mobile app for phone audio.
- 📜 **Quest log** — projects with progress bars, companion assignments,
  per-step checklists
- 🎙️ **Wake phrase trainer** — train `.tflite` models per companion, with
  fine-grained progress events streamed to the phone's progress bar
- 📱 **Mobile pairing** — 6-digit code + device token over WSS, auto-reconnect
- 🖥️ **Built-in terminal** — OpenClaw gateway logs and CLI access via
  `node-pty` + `xterm.js`

---

## 🧱 Architecture

```
┌──────────────────────┐         ┌──────────────────────┐
│  CyberClaw Desktop   │  IPC    │  Renderer process    │
│  (Electron main,     │ ──────► │  (vanilla JS,        │
│   Node 22)           │ ◄────── │   no framework)      │
│                      │         │                      │
│  • Sync Server (WSS) │         │  • Companion carousel│
│  • Wake trainer      │         │  • Pixel arena       │
│  • Piper TTS         │         │  • Quest log         │
│  • PTY terminal      │         │  • Settings          │
│  • Renderer watchdog │         │  • Chat panel        │
└──────┬───────────────┘         └──────────────────────┘
       │ WSS :9247
       ▼
┌──────────────────────┐
│  CyberClaw Mobile    │
│  (Android, RN 0.85)  │
└──────────────────────┘
       │
       │ HTTPS / disk
       ▼
   ~/.openclaw/cyberclaw/
   ├── wake-training/<agentId>/   # .tflite + checkpoints
   ├── sync-config.json           # pairing state, device tokens
   ├── certs/                     # self-signed TLS cert
   └── quest/                     # quest index (projects)
```

**Key files:**

- `src/main.js` — Electron main, IPC, renderer-hang watchdog, pending-voice
  queue, pty hosting
- `src/sync-server.js` — WSS sync server on `:9247`, TLS cert generation,
  pairing flow, device tokens, broadcast/cache/replay protocol
- `src/preload.js` — context bridge between main and renderer
- `src/local-ai.js` — local LLM/TTS orchestration (calls piper)
- `src/piper-tts.py` — piper TTS subprocess (local neural TTS)
- `src/remote-tool-bridge.js` — connects to OpenClaw gateway for agent reach
- `src/js/app.js` — renderer root, screen routing, IPC subscriptions
- `src/js/companion-renderer.js` — companion carousel + leader panel
- `src/js/pixel-arena.js` — animated sprite arena
- `src/js/wizard.js` — first-run wizard (companion creation)
- `scripts/train_wake_phrase.py` — openWakeWord training pipeline,
  subprocess progress streaming
- `src/index.html`, `src/companion-window.html`, `src/wizard.html`,
  `src/doctor.html` — renderer entry points

---

## 🚀 Quick start (development)

### Prerequisites

- Node.js ≥ 22.11
- Python 3.10+ (for wake training + Piper TTS)
- Linux: `apt install python3-pip python3-venv libasound2-dev`
- macOS / Windows: same setup, native deps handled by node-gyp / electron-rebuild

### Build and run

```bash
# Install JS deps
npm install

# Rebuild native modules against Electron's ABI
npx @electron/rebuild

# Start the app (dev mode — DevTools enabled, hot reload)
npm run dev

# Or production mode
npm start
```

### Pair a phone

1. Launch the desktop app — the sync server boots and shows the LAN IP
2. On mobile: **Settings → Connection** → enter the IP → tap **Pair**
3. Desktop shows a 6-digit code; enter it on the phone
4. Mobile stores a device token; reconnects automatically on every launch

Tokens are stored in `~/.openclaw/cyberclaw/sync-config.json` and HMAC-signed
to prevent tampering.

### Train a wake phrase

The wake trainer runs locally on the desktop's Python env, outputs `.tflite`
to `~/.openclaw/cyberclaw/wake-training/<agentId>/output/model/<name>/`.

```bash
# One-time setup
./scripts/setup_training_env.sh

# Train via the UI (recommended) — Companion settings → Train wake
# Or manually:
python scripts/train_wake_phrase.py --agent-id clawsuu --samples /path/to/wavs
```

The trainer emits `PROGRESS::` events that the desktop's main process
re-broadcasts to the mobile via the WebSocket, so the phone sees the same
progress bar as the desktop's log panel.

---

## 📦 Release builds

GitHub Actions builds on tag push (`.github/workflows/build.yml`). The
release pipeline:

- Detects the tag's version bump and updates `latest.md` for the GitHub
  release notes
- Builds `.AppImage` / `.deb` (Linux), `.dmg` (macOS), `.exe` (Windows)
- Publishes via the `gh` CLI (Tobe's v3.2.10 fix — `softprops/action-gh-release`
  had stopped working reliably)

Local build:

```bash
npm run build:linux   # AppImage + deb
npm run build:mac     # dmg
npm run build:win     # nsis installer
npm run dist          # all three
```

`build-desktop.sh` is a convenience script that pulls, installs, and
rebuilds before launch — used after a fresh `git pull` to make sure native
modules are in sync with the current Electron ABI.

---

## 🗂️ Project layout

```
cyberclaw/
├── src/
│   ├── main.js                  # Electron main, IPC, watchdog
│   ├── preload.js               # context bridge
│   ├── sync-server.js           # WSS sync server :9247
│   ├── local-ai.js              # LLM + TTS orchestration
│   ├── piper-tts.py             # piper TTS subprocess
│   ├── remote-tool-bridge.js    # OpenClaw gateway bridge
│   ├── js/
│   │   ├── app.js               # renderer root
│   │   ├── companion-renderer.js
│   │   ├── pixel-arena.js
│   │   └── wizard.js
│   ├── css/
│   ├── assets/
│   ├── *.html                   # renderer entry points
├── scripts/
│   ├── train_wake_phrase.py     # openWakeWord trainer
│   ├── setup_training_env.sh    # one-time venv setup
│   └── dp/                      # dataset prep helpers
├── android/                     # symlink or sibling (mobile lives separately)
├── build-desktop.sh
├── package.json
├── latest.md                    # rolling changelog (channel: #cyber-dev)
└── CHANGES_X.Y.Z.md             # one per release
```

---

## 🔐 Security notes

- Sync server uses a **self-signed TLS certificate**, auto-generated on first
  run into `~/.openclaw/cyberclaw/certs/`. The mobile app trusts it after
  pairing.
- Pairing codes expire after 5 minutes.
- Device tokens are HMAC-signed and rate-limited pairing attempts (3 wrong
  → 5-min lockout).
- Unauthenticated WS connections are dropped after 10 seconds.
- The sync port (9247) is safe to port-forward — the auth layer protects
  against LAN-wide unauthorized access.

---

## 🧪 Renderer watchdog

`main.js` runs a renderer-hang watchdog (added in v3.2.4). After 3
consecutive unacked mobile-voice IPCs within 5 minutes, the renderer is
reloaded via `webContents.reload()`. A pending-voice queue (v3.2.6, capped at
3 entries) re-routes any in-flight voice transcripts so the user doesn't have
to repeat themselves after a reload.

This is intentional: the user's primary feedback when voice mode hangs is
"it failed to respond, now what" — losing in-renderer chat history is
acceptable if voice mode is restored.

---

## 📋 Versioning

- `version` in `package.json` is the source of truth (current: `3.2.13`)
- Tags are `vX.Y.Z`, pushed on `main`
- Each release has a `CHANGES_X.Y.Z.md` with full diff + lessons learned
- `latest.md` is the rolling changelog in #cyber-dev format

---

## 📄 License

MIT — Built by [CyberHive Digital](https://cyberhive.digital).