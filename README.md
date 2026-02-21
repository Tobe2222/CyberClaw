# ⚔️ CyberClaw

**RPG-style GUI companion for [OpenClaw](https://github.com/openclaw/openclaw) AI agents.**

Download CyberClaw, install it, and it sets up OpenClaw for you. Create AI companions, assign them quests, manage your party — all from a slick RPG interface.

![CyberClaw](https://img.shields.io/badge/status-alpha-orange) ![License](https://img.shields.io/badge/license-MIT-blue)

## ✨ Features

- 🎠 **Companion Carousel** — Rotating 3D wheel showing all your AI companions
- 👑 **Party Leader** — Your main companion always visible in the leader panel
- 📜 **Quest Log** — Track projects with progress bars and companion assignments
- ⚔️ **Live OpenClaw Integration** — Reads agents, sessions, and status in real-time
- 🖥️ **Built-in Terminal** — OpenClaw gateway logs and CLI access
- 💬 **Chat Interface** — Talk to your companions directly
- 🎮 **RPG Stats** — HP, MP, XP, skills, equipment, rarity tiers

## 📥 Install

### Download

Grab the latest release for your platform:

| Platform | Download |
|----------|----------|
| **Linux** | `.AppImage` or `.deb` |
| **macOS** | `.dmg` |
| **Windows** | `.exe` installer or portable |

👉 [**Latest Release**](https://github.com/CyberHive-Digital/cyberclaw/releases/latest)

### First Run

1. Download and install CyberClaw
2. Launch it — if OpenClaw isn't installed, CyberClaw will set it up for you
3. Create your first companion and start building your party

## 🛠️ Development

```bash
# Clone
git clone https://github.com/CyberHive-Digital/cyberclaw.git
cd cyberclaw

# Install dependencies
npm install

# Run in dev mode
npm run dev

# Build for your platform
npm run build
```

## 🏗️ Architecture

- **Electron** app with custom RPG-themed UI
- Reads live data from `~/.openclaw/` (agent configs, sessions, subagents)
- Embedded terminal via `node-pty` + `xterm.js`
- No framework — vanilla JS, CSS Grid, CSS animations

## 📋 Roadmap

- [ ] OpenClaw auto-installer (first-run wizard)
- [ ] Create/edit companions from GUI
- [ ] Manage Discord/Telegram channel bindings
- [ ] Quest creation and tracking
- [ ] Real-time chat with companions
- [ ] Auto-update via GitHub releases

## 📄 License

MIT — Built by [CyberHive Digital](https://cyberhive.digital)
