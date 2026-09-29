# v3.3.22 — Desktop: chat layout refresh (bubble distinction, quest pill, channel-tab status, arena sizing, image-send)

## The bug (multiple UX + one code bug)

Tobe (2026-09-29 22:10, Discord #cyber-dev):

> "@Clawsuu Okey i now tested to send a message to clawsuu on
> the desktop with an attached image. He did not react it
> seems, no clawsuu is working etc text there."

Followed by (22:13):

> "it might be that the desktop is confused, it does not
> seem to have an active quest, it is atleast not highlighted
> on the quest list and the chat does not say either."

Plus seven smaller UX complaints (skills-library position,
skills stagnation, bubble distinction, channel-tab status
line, arena size).

## What this release fixes

### Code bug: desktop image-send dropped the attachment

Root cause: `app.js` window.sendChat (the paperclip-button
patch around line 8404) was passing the attachment to
`cyberclaw.chat.sendMessage` as a single object
`{image: dataUrl}` instead of an array. The receiving
handler in `main.js`'s `sendChatMessageViaHttp` checks
`Array.isArray(attachments) && attachments.length > 0`
before building the multimodal `image_url` content block.
Object → array check fails → multimodal block skipped →
LLM gets only the text "Describe this image" with no
image data. clawsuu genuinely had nothing to react to.

The fix: convert to a proper array
`[{data, mimeType, fileName, dataUri}]`. Same shape the
mobile uses for outbound image sends and the gateway
already accepts per the OpenAI multimodal spec.

Bonus: the desktop's image-send path was rendering the
user bubble via raw DOM (`appendChild`), bypassing
`addChatMsg` entirely. So the user bubble never landed in
`chatHistoryByAgentAndQuest` and never broadcast to the
mobile. Now routed through `addChatMsg('user', ...,
attachments)` so it persists and broadcasts. Matches the
v3.3.20 / 21 persistence flow.

### UX fix: per-bubble quest pill

The mobile (v3.11.5) already shows the active quest name
on each bubble via the v3.11.5 `activeQuestName` field.
The desktop did not — only the chat-input-area had a
`chat-quest-indicator` that hides when no quest is
active, leaving the user confused which quest the bubble
came from.

The fix: every bubble (`user` / `agent` / `agent-image`)
now renders a small dim header above the prefix showing
either `📜 <quest name>` or `— No quest` if no active
quest. Matches the mobile's pill behavior exactly.

### UX fix: clearer bubble distinction

Was: both user and agent bubbles used a faint tint on the
same left-aligned layout. Hard to tell which side of the
conversation a bubble belonged to.

Now: user bubbles align right with a 3px cyan border and
tinted background; agent bubbles align left with a 3px
gold border. Bigger paddings, rounded corners. The
conversation sides are now visually distinct at a glance.

### UX fix: dropped the chat-header bar

The chat-header (avatar + name + online-status text) was
rendering under the channel tabs as a redundant line.
Replaced with a green-dot online indicator on the channel
tab itself (`.companion-tab-status`, glowing green when
awake, dim grey when sleeping). The chat-header DOM is
kept (not removed) for backward compat with existing JS
references; it's now `display:none`.

### UX fix: arena height reduced

The arena (`#party-arena flex: 1.5`) was about 60% of the
center column height — too much given Tobe's chat-first
workflow. Now `flex: 0.111` (≈1:9 ratio). Sprite still
renders at the same minimum height (180px) but the chat
strip dominates visually.

## What's still queued

- **Skills library position**: the per-companion skills
  library UI is currently in the LEFT panel under the
  quest log. Tobe wants it on the RIGHT panel above the
  enabled-skills toggles. Needs a layout move + JS
  rewire of `refreshSkillsList()` to target the new
  container. Out of scope for this release.

- **Skills category/level stagnation**: the
  `inspect-skills` section reads
  `agent.stats.skills[name].level` + `.xp` and renders the
  XP bar. If clawsuu's stats aren't accumulating, that's
  a bug in main.js's `awardXpForReply` /
  `classifyTask` path. Out of scope; needs a separate
  diagnostic on the gateway side to confirm whether XP
  is being awarded at all.

- **Text-from-desktop → phone broadcast**: the desktop's
  text-only chat pipeline broadcasts via
  `sync-broadcast-chat` with `isUser: true` correctly.
  Apparent "missing" instances are the WS-reconnect race
  Tobe has hit three times now. Mitigated by the v3.3.21
  persistence fix — bubbles now ride along on every
  chat_history response.

## Audit table

Layer | Field | Preserves | This fix
---|---|---|---
desktop addChatMsg user | attachments | n/a | ✅ v3.3.22
desktop addChatMsg user | persistence | n/a | ✅ v3.3.22
desktop addChatMsg user | broadcast | n/a | ✅ v3.3.22
desktop chat:send-message IPC | attachments | n/a | ✅ v3.3.22
desktop bubble render | attachments (user) | n/a | ✅ v3.3.22
desktop bubble render | quest pill | n/a | ✅ v3.3.22
desktop bubble render | user/agent distinction | n/a | ✅ v3.3.22
desktop channel tab | green dot | n/a | ✅ v3.3.22
desktop arena | height | n/a | ✅ v3.3.22

## Lessons

1. **Shape mismatches at IPC boundaries.** The
   desktop's image-send path passed `{image: dataUri}`
   to a function expecting an array. JS happily accepts
   the object; the consumer's `Array.isArray` check
   silently skips the content. Same class as the
   constructor-binding silent-no-op bug (v3.3.13):
   hand-written shape checks don't fail loud when the
   shape is wrong.

2. **DOM-direct rendering bypasses the pipeline.** The
   old `sendChat` image path rendered the user bubble
   via `document.createElement('div')` + `appendChild`
   instead of `addChatMsg`. The bubble looked correct
   locally but was invisible to every downstream
   consumer (persistence, broadcast, history sync).
   Whenever you add a new bubble-rendering path, route
   it through `addChatMsg` so all consumers see it.

3. **One bubble per conversation side.** Right-aligned
   user bubbles are a familiar chat convention. The
   previous "tinted left-aligned" pattern works for
   Slack/Discord because those platforms have avatars
   that distinguish sides. We don't have avatars on
   every bubble, so the right-align is the visual cue.