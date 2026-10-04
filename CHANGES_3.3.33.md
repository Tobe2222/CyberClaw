# v3.3.33 — Error bubbles survive mobile reconnect + longer UI cap + "Casual" rename

**Tobe 2026-10-04 10:46 (Discord #cyber-dev):**

> "The errors still dont show on the mobile end.
> When the chat refreshes every 20 sec or something seems to
> know that there is a new text, see image. But Its an error i
> can see on the desktop and it does not reach the mobile chat,
> see second image right after. Errors should appear on the
> mobile end also.
>
> And switching between chats etc seem to work fine. Lets
> rename no quest chat to casual. It even jumped to casual
> when i gave food since the companions react to that, which is
> very good.
>
> I also see that the online status green dot on the companion
> chat tabs is gray on the desktop. Which is not correct.
>
> And lets extend the time cap since the error we seem to get
> often now is timeout."

Three issues plus a v3.3.32 holdover:

1. **Green-dot gray on companion tabs** — was actually a
   v3.3.32 fix that hadn't been committed yet. Now
   shipped in v3.3.32 (separate tag, already pushed).
2. **Errors not reaching mobile** — root cause was a
   persistence gap in the flat `chatHistory` mirror.
3. **Extend timeout cap** — bumped from 900s to 1800s
   (15 min → 30 min) per Tobe's explicit ask.
4. **"No quest" → "Casual" rename** — cosmetic label
   change on the per-bubble quest pill. Companion-reaction
   bubbles (v3.3.31's toy/snack routing) still go to the
   no-quest bucket; only the visible label changes.

The "green-dot" issue is fixed in v3.3.32 — that's a
separate, already-shipped tag. The work below is the
three v3.3.33 changes.

## Fix 1 — Persist `error` bubbles to the flat chatHistory mirror

Tobe's report: an error appeared on the desktop chat but
never reached the mobile. The desktop log
(`/tmp/cyberclaw-desktop.log` lines ~690-711) showed:

```
[IPC] sync-broadcast-chat received: {
  agentId: 'clawsuu',
  text: 'Error: agent call timed out (current cap is AGENT_TIMEOUT_MS=900000ms=900s) — the LLM call may still',
  isUser: false,
  activeQuestId: 'o2jnjx8115uk',
  ...
}
[IPC] Message broadcast to mobile clients
... (20+ second gap, no mobile client connected) ...
[SyncServer] Client connected: ... from ::ffff:89.8.34.217
[SyncServer] Replaying 5 recent AI message(s) to reconnected client
[RI] [App] Mobile requesting chat history, sending 5 messages
```

The realtime broadcast fired, but the mobile had
disconnected (Android doze / backgrounded / brief network
drop) and the WS frame was lost. The mobile then
reconnected, requested `chat_history`, and got a flat
`chatHistory` mirror that **did not contain the error**
— so the error never arrived via the chat_history replay
either. The agent's actual reply (which arrived later via
the openclaw tail once the LLM call completed in the
background) made it through because it's added via the
`addChatMsg('agent', ...)` path that DOES persist to the
mirror. Only the error path was broken.

### Root cause

In `src/js/app.js` the flat-mirror push guard read:

```js
if (type === 'agent' || type === 'user' || type === 'agent-image') {
  // ... chatHistory.push({...});
}
```

The `error` type was NOT in the list. The realtime
broadcast block (further down the function, around line
4736) DID broadcast errors — that part has worked
since v3.2.46. But the persistence-to-mirror path was
incomplete.

### Fix

Add `'error'` to the guard. Errors now persist in the
flat mirror just like agent/user/agent-image bubbles, so
every subsequent mobile `request_chat_history` replay
includes them. Belt-and-braces: realtime broadcast +
persistence.

**Lesson (added 2026-10-04):** "Errors must persist in
the flat chatHistory mirror." The realtime WS broadcast
is a transient network event — it can be missed during a
disconnect, and the mobile's only way to re-prime is
`chat_history` replay. Any message type that the user
expects to see (especially errors, which are the
highest-signal user feedback) must take both paths.
Asymmetry between the realtime broadcast guard
(`agent`/`user`/`error`/`agent-image`) and the mirror
push guard (`agent`/`user`/`agent-image`) is a bug —
they must include the same types.

## Fix 2 — Bump AGENT_TIMEOUT_MS from 900s to 1800s

Tobe 2026-10-04 10:46: 'And lets extend the time cap
since the error we seem to get often now is timeout.'

The 900s (15 min) UI-side cap was firing too often on
multi-tool code-refactor / git-tag-please-actually-ship
style workflows. Bumped to 1800s (30 min). The
underlying LLM call keeps running on the gateway
(openclaw default `timeoutSeconds` is 172800 = 48h), so
extending the UI-side cap is purely a UX decision about
how long we want the user to wait before we surface an
error — the actual work still completes. The
`typingFailsafe` is bumped proportionally (1500s, up
from 600s) so the typing bubble survives a full
legitimate run.

**Two places in `src/js/app.js` need the bump:**
- Main `sendChatMessage` path (line 3850, used by all
  mobile/voice/prompt IPC callers).
- `sendChat:img` image-attachment path (line 8949,
  used when sending an image attachment from the desktop).
Both had the same 900s cap and now have the same 1800s
cap.

**Lesson (general):** Promise.race timeout caps on the
desktop are a UX decision, not a correctness gate. The
LLM call still completes in the background; the cap
just controls how long the user waits before seeing an
error. Match the cap to the realistic worst-case task
length, not to a vague "should be fast" estimate.

## Fix 3 — "— No quest" → "— Casual" (desktop bubble pill)

Tobe 2026-10-04 10:46: 'Lets rename no quest chat to
casual. It even jumped to casual when i gave food since
the companions react to that, which is very good.'

Single literal change in `src/js/app.js` line 5002:

```diff
- : `<span class="msg-quest-header no-quest">— No quest</span>`;
+ : `<span class="msg-quest-header no-quest">— Casual</span>`;
```

The CSS class `.no-quest` is unchanged (style still
uses the muted/no-quest palette). The companion-reaction
routing logic (v3.3.31's `questOverride='__no_quest__'`
path, forceNoQuest flag on the broadcast) is unchanged —
toy/snack/ball-fetch reactions still land in the
no-quest bucket; only the visible label on each bubble
pill now reads "Casual" instead of "No quest".

The mobile-side rename ("No active quest" → "Casual
chat") is in mobile v3.11.29 — separate tag.

## Files changed

- `src/js/app.js` — add 'error' to flat-mirror push
  guard; bump AGENT_TIMEOUT_MS and typingFailsafe in
  two places; rename "— No quest" → "— Casual" in
  per-bubble pill.
- `package.json` — version bump to 3.3.33.

## Deploy

Renderer hot-reloads on next page load. No restart
needed for the renderer-side changes (mirror push guard
in `addChatMsg`, pill label string). The two
`AGENT_TIMEOUT_MS` constants are also renderer-side
inside `__sendChatMessageImpl` and the image path
inline function, so renderer hot-reload covers them too.

Main process / sync-server are not touched.

## Verification plan

For Tobe to verify in one pass:

1. **Errors reach mobile.** Force a timeout (send a
   multi-tool refactor that takes >18 min, or set
   AGENT_TIMEOUT_MS temporarily to 60s for testing).
   Background the mobile before the timeout fires.
   After the timeout, foreground the mobile — the
   error bubble should appear in the chat history
   within a few seconds of the next `request_chat_history`
   pull. Then open the same chat on desktop — both
   bubbles (error + actual reply when it arrives) should
   be visible in the same per-quest bucket.
2. **Timeout cap.** A 30-min task should now NOT
   surface an error prematurely. The typing bubble
   should survive up to ~25 min (1500s typingFailsafe).
3. **Casual pill.** Sent a chat with no active quest
   (or trigger a companion-reaction via the food button)
   — the per-bubble pill on desktop should read "Casual"
   instead of "No quest". Mobile (after v3.11.29) shows
   "Casual chat" in the QuestsScreen card and "— Casual
   chat" as the quest-change separator.

## Cross-cutting note (2026-10-04)

Three v3.3.x releases in three weeks have all touched
some subset of:
- per-bubble quest pill rendering
- per-tab green-dot online indicator
- error-persistence to flat mirror

These are independent features, but they share a common
property: they're renderer-side cosmetic / persistence
fixes that the user can only verify visually in chat.
Renderer hot-reload (no restart needed) is what makes
shipping these cheap — every fix is one bundle for the
user to pick up on next page load. If we ever lose the
renderer hot-reload (e.g. forced desktop restart for a
main-process change), the queue of renderer-only fixes
should be batched into a single release so the user
gets them all at once.