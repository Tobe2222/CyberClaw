# 3.2.26 — Phone-side companion Personalize + per-companion chattiness scale

The user reported (2026-07-24 08:51):

> "@Clawsuu For some reason he has gotten alot chattier today.
> The desktop has the companion edit. Lets introduce that into mobile
> also. Lets put it in the settings, companions, and create a new
> edit/personalize companion.
> Lets add what the desktop has of those settings and add a chattiness
> scale, lets add that scale to the desktop also so they are alike,
> and this all has to be synced."

Screenshot showed 5 agent messages from Clawsuu in 5 hours since 3 AM.
That's the v3.1.3 baseline (60–90 min idle chatter) doing exactly what
it was tuned to do — but The user noticed it was chatty "today" because
Clawsuu hit the upper end of the random interval several times in a
row. Without a knob to dial it down, the user has to wait for the
desktop or accept the current rate.

## What ships

### (1) Desktop — Companion Forge gets a chattiness slider (1–5)

`src/index.html` — new "💬 Chattiness" section between the size and
model sections in the Companion Forge modal. 1–5 with a live
description.

`src/js/app.js` —
- `currentForgeChattiness` state (default 3)
- `CHATTINESS_DESCRIPTIONS` map (1=Silent, 2=Quiet, 3=Balanced,
  4=Chatty, 5=Very chatty)
- `updateForgeChattiness(value)` — live label + description update
- `openCompanionForge` hydrates from the saved sprite config
- `createNewCompanion` resets to default 3
- `saveCompanion` writes `chattiness` to `sprites.json` and mirrors
  it onto `agents[cid].chattiness` for the scheduler
- Boot-time hydration loop reads `cfg.chattiness` and falls back to 3
- `scheduleIdleChatter()` now reads `agents[cid].chattiness` per tick
  and picks the interval from a switch:
  - 1 → fire never (1h heartbeat just to reschedule)
  - 2 → 3–6h
  - 3 → 60–90min (the v3.1.3 baseline)
  - 4 → 30–60min
  - 5 → 15–30min
- `broadcastAgentsListToMobile` includes `chattiness` so the mobile
  picks up the current value without a separate request

### (2) Desktop — Settings → Companions list

`src/index.html` — new "🐾 Companions" section in the Settings
modal, between User Profile and Mobile Companion. Each row shows
the companion's emoji + name + chattiness slider + Edit button.
Edit opens the Companion Forge (full personalization, the same
forge as the v3.1.0+ code).

`src/js/app.js` —
- `renderSettingsCompanionsList()` — populates the list from
  `agentOrder`, hydrates chattiness from sprite config
- `updateSettingsCompanionChattiness(agentId, value)` — live label
- `saveSettingsCompanionChattiness(agentId, value)` — persists +
  re-broadcasts agents_list

`src/css/components.css` — new styles for the row layout.

### (3) Sync protocol — `sprite_config_sync` (mobile → desktop)

`src/sync-server.js` — new `onSaveSpriteConfig` callback, new
`sprite_config_sync` case handler with a whitelist (so the mobile
can't accidentally overwrite unrelated state). The whitelist:
`pixelCompanionId, spiritId, customName, focusSkills, traits,
primaryModel, secondaryModel, scale, chattiness`. Chattiness and
scale are clamped (1–5 and 1–8 respectively) before forwarding.
On success the server sends `sprite_config_sync_ok`; on failure
(`{ ok: false, reason, error }`) it sends `sprite_config_sync_failed`.

`src/main.js` — wires `onSaveSpriteConfig` to forward an IPC
`mobile-sprite-config-saved` to the renderer.

`src/js/app.js` (renderer) — receives `mobile-sprite-config-saved`,
merges the patch into the existing sprite config, calls the
existing `cyberclaw.agents.saveSpriteConfig`, mirrors onto the
in-memory `agents` map, regenerates the avatar if the sprite
changed, and calls `broadcastAgentsListToMobile()` so the change
reaches every connected client (including the phone that
initiated the edit).

### (4) Mobile — Personalize screen

`src/screens/CompanionEditScreen.tsx` (new file) — full-screen
route mirroring the desktop forge for the fields the mobile can
edit:
- Name (customName)
- Scale (1–8, with +/− buttons since RN doesn't have a native
  range slider)
- Chattiness (1–5, slider + tappable scale, with the same
  descriptions as the desktop)
- Traits (9 checkboxes matching the desktop's set)
- Primary / Secondary model (chips for the curated set + Custom
  text input)

Save → `syncClient.setSpriteConfig(agentId, patch)` →
desktop applies → `sprite_config_sync_ok` arrives → toast +
back. The full agents_list update happens ~100ms later via
the existing broadcast.

`src/services/SyncClient.ts` — new `setSpriteConfig(agentId, patch)`
send method. Receivers for `sprite_config_sync_ok` and
`sprite_config_sync_failed`.

`App.tsx` — new `companion-edit` route + `companionEditCtx`
context + `onOpenCompanionEdit` prop on CompanionSettingsScreen.

`src/screens/CompanionSettingsScreen.tsx` — new "✏️ Edit /
Personalize" card on the overview, opens the Personalize screen
for the current companion.

### (5) Mobile version bumps

- v3.10.92 (versionCode 316)
- Desktop v3.2.26

## Why this is the right shape

**Why a chattiness scale instead of a single "off" toggle.** The
problem is continuous, not binary. Some users want companions to
shut up entirely (sleeping baby, presentations), some want them
to chime in occasionally (the v3.1.3 baseline), some want them
to be a constant companion (the "always chatty" crowd). 1–5
covers that spectrum without burdening the UI with a per-time
or per-day-of-week scheduler.

**Why a slider on the desktop AND a slider on the phone.** The
user wants both surfaces to look the same. If the desktop has a
slider and the phone has a different control (or no control at
all), the user has to remember which surface to use. The
Settings → Companions list on the desktop is a quick dial; the
Personalize screen on the phone is the same dial plus the rest
of the forge. Both write to the same field, both broadcast to
the same WS, both see the same value on the next sync.

**Why whitelisting the patch fields on the sync server.** A
client-controlled patch is a trust boundary. The mobile can't
do anything malicious today, but the day we add a third client
(plugin, web app, CLI), the whitelist in `sprite_config_sync`
prevents it from writing `id` or any other field that should
only be changed through the openclaw config flow. Defense in
depth.

**Why the desktop treats the mobile as authoritative for the
slider value.** The desktop's `scheduleIdleChatter()` reads
`agents[cid].chattiness` per tick. The mobile writes the value
via the desktop's `saveSpriteConfig`, which mirrors onto
`agents[cid].chattiness`, and the next tick picks it up. We
don't cancel the in-flight timer (would race with the user's
intended interval) — the change takes effect within the
chattiness window. For chattiness=1, the one-hour heartbeat
means the change can take up to 1h to fully silence — fine,
because the user wants silence, not an immediate stop.

**Why the mobile can edit name/scale/traits/model but not
sprite.** The sprite catalog is bundled with the desktop (the
PNG atlas + per-sprite metadata). The mobile would have to ship
the same assets to render a sprite picker, and replacing the
sprite requires regenerating the avatar (the desktop's
`saveCompanion` does this by drawing the first idle frame to a
canvas and writing the PNG). Without the catalog and the
canvas-write pipeline on the phone, the sprite picker would
be a half-feature. The Settings → View All Companions button
on the desktop's Settings modal is the entry point for sprite
swaps; the mobile's Personalize screen is the entry point for
everything else. the user can still pick the sprite on the desktop
and the new sprite flows to the phone via the existing
agents_list broadcast.

## Lessons

**Always ship the same control on both surfaces when the
fields are synced.** "Chattiness on the desktop, no chattiness
on the phone" would have been a quick fix but would have left
the user re-opening the desktop every time he wanted to dial it
down. The instant he asks for a synced feature, the surface
parity becomes non-negotiable.

**Defense in depth on client-controlled patches.** A whitelist
on the sync server is four lines and prevents the next
"someone shipped a client that wrote the wrong field"
incident. The cost is low; the blast radius of an unrestricted
patch is unbounded.

**The right place for a chattiness slider is the FORGE, not
the settings.** Putting it on Settings → Voice Mode would have
been a category error (chattiness isn't a voice setting;
it controls idle text). The forge is the single place where
"how this companion behaves" lives, and the Settings list is
a quick dial for the most-used knob. Two surfaces, one
source of truth.

**When a feature is "always chatty" because the random interval
hit the upper end several times in a row, the user blames the
feature, not the random number generator.** Even though the
behavior was working as designed, the user sees "alot chattier
today" and assumes something changed. The slider is the
right escape hatch — the user can dial down without convincing
themselves the random number generator is broken.

**Whitelist, don't blacklist.** The mobile could send any
patch it wants. A whitelist on the server means we don't have
to predict what the mobile CAN'T send, and the day we add a
new field to the sprite config, we just add it to the whitelist
on the server and the mobile can optionally start sending it
without a server update. (The mobile's own `setSpriteConfig`
doesn't filter — it sends the patch as-is. The server is the
trust boundary.)
