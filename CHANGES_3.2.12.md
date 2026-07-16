# v3.2.12 — Companion sleep state mirrored to mobile + auto-wake on any speech input

Tobe (post v3.2.10 / v3.10.42):

> "the companions dont sleep on the phone, they should. And they
> should always awaken if spoken to in any way"

Two parts in this release.

## 1. Sleeping-companion visual on the phone

The desktop maintains a per-agent `sleepState: 'awake' | 'sleeping'`
field, toggled manually via `toggleCompanionSleep()` or
automatically by `scheduleAutoSleep()` after a configurable period
of inactivity. The mobile previously had no concept of sleep —
the arena sprite always looked wide-awake regardless of what the
desktop's pixels were doing.

### Fix

- **`agents_list` broadcast payload** (`src/js/app.js`):
  Added `sleepState` to each agent entry. The desktop now pushes
  the per-agent awake/asleep state alongside the existing
  `id, name, sprite, scale, emoji, icon, iconFile, iconDataUri`.

- **`broadcastAgentsListToMobile()` triggers**: every code path
  that mutates `sleepState` now calls this so the mobile sees the
  new state immediately (rather than waiting for the next
  periodic broadcast):
  - `toggleCompanionSleep()` (manual button click)
  - `sendChat()` auto-wake on typed submit
  - `sendChatMessage()` auto-wake on mobile-initiated chat
  - `scheduleAutoSleep()` background checker

- **`sendChatMessage()`** now explicitly flips `sleepState` from
  `'sleeping'` to `'awake'` for the active companion when
  the mobile sends a chat (mirrors what `sendChat()` already did
  for DOM-typed input). Without this, mobile-typed chat
  would receive a reply from a sleeping companion and the sprite
  would stay in 'death' pose until something else nudged the
  night-wake timer.

### Mobile-side render

When the active companion's `sleepState === 'sleeping'`:
- The arena WebView gets `opacity: 0.65` (dimmed) so the
  sleeping sprite reads as quiet/dormant.
- A small `💤 sleeping` pill overlay renders in the upper-right
  of the arena View (positioned absolute, pointerEvents="none"
  so it doesn't block taps).
- Both clear automatically when the next `agents_list`
  broadcast lands with `sleepState: 'awake'` (which happens
  immediately after the wake request fires — see below).

## 2. Auto-wake on any speech/chat input

Tobe: "they should always awaken if spoken to in any way".

The desktop's `sendChat()` and `sendChatMessage()` already
auto-wake on chat. But the mobile ALSO needs to wake on:
- Chat-submit on the home screen (covered — `sendChatMessage`
  flip)
- **Voice-mode entry** (`enterVoiceMode()`) — the user is
  about to start talking, but a sleeping companion wouldn't
  wake until the first utterance arrived
- **Voice-mode recording send** (audio transcription) — same
  problem

### Fix (mobile-side)

New sync API:
- `syncClient.sendWakeAgent(agentId)` (mobile) sends a
  `mobile_wake_agent` message over the existing WebSocket
  sync connection.

New sync-server / desktop IPC chain:
- `sync-server.js`: new case `'mobile_wake_agent'` invokes
  `onMobileWakeAgent(agentId, meta)`
- `main.js`: the callback forwards to the renderer via
  `webContents.send('mobile-wake-request', { agentId })`
- `app.js`: new `ipcRenderer.on('mobile-wake-request', ...)`
  handler flips `sleepState` (matching the existing
  `toggleCompanionSleep()` pattern), nudges the night-wake
  timer, and rebroadcasts `agents_list` so all connected
  mobile clients see the new state.

Mobile trigger points:
- HomeScreen `sendMessage()` — fires `sendWakeAgent(aid)`
  at the top, before any other side-effects
- HomeScreen `enterVoiceMode()` — fires `sendWakeAgent(aid)`
  at the top, before any routing logic

These two trigger points cover the user's three main
input paths (chat submit, voice-mode from wake word, voice-mode
from focus tap). Recording-send and voice-mode turn send paths
on the mobile ultimately route through `sendChatMessage` on the
desktop (which already auto-wakes via the
`toggleCompanionSleep`-equivalent logic in sendChatMessage
itself), so they're covered too.

## Files

### Desktop (v3.2.12)
- `src/js/app.js`:
  - `broadcastAgentsListToMobile()` includes `sleepState`
  - `toggleCompanionSleep()` rebroadcasts on state change
  - `sendChat()` and `sendChatMessage()` rebroadcast on auto-wake
  - `scheduleAutoSleep()` rebroadcasts on auto-sleep
  - `sendChatMessage()` now also flips `sleepState` (mobile chat
    auto-wake, previously only `nudgeNightWake()`)
  - New `ipcRenderer.on('mobile-wake-request', ...)` handler
- `src/sync-server.js`: new `case 'mobile_wake_agent'` routes
  to `onMobileWakeAgent` callback
- `src/main.js`: SyncServer constructed with
  `onMobileWakeAgent` that sends `mobile-wake-request` to
  renderer

### Mobile (v3.10.43)
- `src/services/SyncClient.ts`: new `sendWakeAgent(agentId)`
  method
- `src/screens/HomeScreen.tsx`:
  - `agents` state type extended with `sleepState`
  - `sleepOverlay` flag computed from `activeChatAgentId`'s
    sleepState
  - WebView `style` applies `opacity: 0.65` when sleeping
  - `💤 sleeping` overlay pill rendered above the arena
    when sleeping
  - `sendMessage()` and `enterVoiceMode()` fire
    `sendWakeAgent(aid)` at the top

## Behavior

- Phones now show a dimmed sprite when the desktop considers
  the active companion sleeping. Clear visual difference.
- Any speech input (typed chat, voice mode entry, voice mode
  send) wakes the companion within a few hundred ms.
- The night-wake timer on the desktop resets on every wake
  trigger, so a quick chat doesn't immediately re-trigger
  the sleep countdown.
- No regression for already-working sessions — the desktop
  broadcasts `sleepState: 'awake'` (or omits the field,
  which the mobile defaults to awake) for routine operations.

## Side effects / edge cases

- If the WebSocket sync connection drops during a wake
  request, the message is silently dropped. Acceptable: the
  next `agents_list` broadcast after reconnect will refresh the
  mobile-side state, and the actual chat reply will arrive
  separately.
- If the user has multiple companions and only one is
  sleeping, only that one wakes. Other sleeping companions
  stay asleep until spoken to.
- The `💤 sleeping` overlay only appears for the *active*
  companion (matches `activeChatAgentId`). Other sleeping
  companions on other tabs don't show the overlay until the
  user switches to them — at which point the new active
  companion's `sleepState` is read and the overlay updates.

## Future work

- The mobile could optionally suppress the "🎤 Voice Mode"
  button (or filter to a specific aria-label) when the
  active companion is sleeping, to make the sleep state
  explicitly prevent voice mode. Currently the user can
  still tap into voice mode with a sleeping companion —
  they'd just be auto-woken by the new wake trigger.