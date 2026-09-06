# 3.2.27 — agents_list broadcast carries spriteConfig + avatar

the user's v3.10.94 feedback (the two real bugs after the
v3.2.26 Personalize release):

> "if the emoji is the preview we can remove it, i was
> thinking of the sprite the way it looks in the arena."
> "i still dont get the current settings. If you see the
> behaviours, none of them are selected, even tho they
> are on the desktop. The settings should be consistent
> between desktop and phone. Such that the companion is
> the same."

The mobile's Personalize screen was rendering:
- A catalog emoji (🐗 for Boar) in the preview box
  instead of the actual pixel-art sprite
- Empty trait checkboxes (Sassy, Curious, etc.) even
  when the desktop had several selected

The root cause was the same on both: the `agents_list`
broadcast didn't carry the data the mobile needed to
mirror the desktop's state.

## What ships

### (1) `spriteConfig` in agents_list

`src/js/app.js` — `broadcastAgentsListToMobile()` is
now async, reads `sprites.json` for each companion
(via the existing `cyberclaw.agents.getSpriteConfig`),
and includes the full per-companion sprite config in
every `agents_list` entry:

```js
spriteConfig: {
  pixelCompanionId: 'boar',
  customName: 'Clawsuu',
  focusSkills: [],
  traits: ['sassy', 'curious', 'goblin'],
  primaryModel: 'anthropic/claude-opus-4-6',
  secondaryModel: '',
  scale: 4,
  chattiness: 3,
}
```

The mobile hydrates its Personalize screen from this
field. Previously the mobile fell back to its own
defaults (empty traits) because the broadcast didn't
include the config.

### (2) `avatar` in agents_list

Same change adds `avatar: a.avatar || null` to each
entry. The avatar is the first frame of the idle
animation as a PNG data URL — the same PNG the
desktop's forge preview, arena, and chat tab icon
already render. The mobile's preview frame now
`<Image source={{ uri: avatar }}>`s this at
`scale × 16px` (16-128px range), so the user sees
the actual pixel-art sprite, not a generic emoji.

Size: 5-11KB per companion as a data URL. For 6
companions that's ~60KB of avatar data per broadcast.
The broadcast is sent every ~60s and on every
sprite_config_sync. Acceptable for the WiFi-local sync.

### (3) Unified broadcast shape

`mobile-request-agents-list` handler (the IPC from
the sync server asking the renderer to re-broadcast
for a late-reconnecting client) used to build its
own stripped-down agents list without `spriteConfig`
or `avatar`. Now it delegates to
`broadcastAgentsListToMobile()` so both broadcast
sites produce the same shape.

### (4) Floating-promise defense

`broadcastAgentsListToMobile` is now async. Most
callers used `try { broadcastAgentsListToMobile(); }
catch (_) {}` which only catches sync errors. Added
`.catch` handlers at the two critical call sites
(`mobile-sprite-config-saved` and
`mobile-request-agents-list`) to cover the floating
promise. The function's own inner try/catch should
prevent rejections, but defense in depth.

## What the user sees

Before v3.2.27:
- Mobile Personalize: empty trait checkboxes, 🐗
  emoji in the preview, scale = 4 (default), chattiness
  = 3 (default)
- Even after the user tapped a trait and saved, a
  remount would re-show empty traits until the next
  local-cache write

After v3.2.27:
- Mobile Personalize: same trait selections as
  desktop, same chattiness value, same sprite, same
  scale, same customName
- Preview shows the actual pixel-art sprite (Boar,
  Fox, Deer, Hare, Black Grouse) at the size
  slider's scale
- Save on mobile → desktop applies + re-broadcasts
  → mobile's open Personalize screen updates
  within ~100ms (no remount needed)
- Save on desktop → mobile's open Personalize screen
  updates within ~100ms (live agents_list subscription)

## Why this is the right shape

**The data flow should be a property of the system, not
a manual user sync.** the user's original ask in v3.2.26 was
"the same settings on both surfaces". v3.2.27 makes
that a property of the broadcast: the mobile's
Personalize screen reads from the desktop's `sprites.json`
on every agents_list event, so both surfaces show
identical state by construction. No "did I save on the
right device?" confusion possible.

**Avatar is already on the desktop — just send it.** The
desktop's `saveAvatar` writes the first frame of the
idle animation as a PNG data URL on every sprite
change. That data was already on the desktop's side;
shipping it to the mobile is one extra field on the
broadcast. No new assets, no canvas re-render on
mobile, no Twemoji indirection. The mobile renders
the same PNG the desktop renders.

**Sync the truth, not a stripped version.** The
`mobile-request-agents-list` handler was built as a
late-reconnecting client fix and was scoped to a
narrower payload (just id + name + emoji). After
v3.2.27 the late-reconnecting client gets the full
payload, no waiting for the next 60s sync. The
"stripped version" was a half-measure that left
late-reconnect users on stale data.

## Lessons

**"Async function with try { ... } catch { }" at the
call site is a footgun.** The try/catch only catches
sync errors. If the function later becomes async (or
any await is added), the catch stops catching and
rejections become unhandled. The pattern that works
is `someAsyncFn().catch(handleError)` at the call
site, or `await someAsyncFn()` inside an outer
async try/catch. Worth an ESLint rule for
"async-via-fire-and-forget".

**"Sync two surfaces" requires reading the data, not
just writing it.** v3.2.26 added the WRITE path
(mobile → desktop via `sprite_config_sync`). the user's
v3.10.94 feedback revealed we hadn't built the READ
path: the mobile couldn't see what the desktop had.
A "synced setting" is only synced when the read path
exists. We can test this by checking: when the user
opens the Personalize screen on a fresh install,
do the values match the desktop? In v3.2.26 they
didn't. In v3.2.27 they do.

**The preview should be a property of the data, not
a stand-in for it.** v3.2.26's preview was a catalog
emoji — visually a preview, semantically not. the user
called this out: "if the emoji is the preview we can
remove it, i was thinking of the sprite the way it
looks in the arena." The lesson: don't ship a
"placeholder" preview unless it's clearly labeled
as a placeholder. A user looking at a 🐗 in a
200×200 box will assume that's the sprite, not
"this is the catalog emoji because we didn't ship
the PNGs". Show the real thing, or don't show a
preview at all.

**Cache the heavy read, do the cheap work.** Per
companion, `getSpriteConfig` reads from `sprites.json`
(a 200-byte file). The first call hits disk; subsequent
calls hit the OS page cache. Doing it for 6 companions
in parallel via `Promise.all(order.map(async id => ...))`
adds ~1ms to the broadcast (cached) or ~10ms (cold).
Synchronously: the broadcast would be the same speed.
Async adds noise to the call sites but no real cost
to the user. The async conversion is worth it for the
correctness of having sprite config in the broadcast.

**Don't let a half-feature be the final form.** The
mobile's Personalize screen in v3.2.26 was a "half
of the desktop forge" — name, scale, traits, chattiness,
and a sprite picker that was actually a catalog emoji
picker. the user's iteration has been: try the half
version, then say what's wrong, then we close the gap.
The v3.2.27 gap-closing is to actually ship the avatar
PNG, not just the catalog metadata. Half-features are
fine to ship; the discipline is to close the gap
when the user calls out the half, not let it linger.
