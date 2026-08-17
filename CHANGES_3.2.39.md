# v3.2.39 — Log dropped mobile chats during auth handshake

**What changed:** The sync-server's `case 'chat'`
handler (sync-server.js around line 366) now logs
a `console.warn` line when it drops a chat because
`client.authenticated` is still false. Before, the
drop was completely silent.

**Why:** the user's 2026-07-29 18:30 report: "I wrote in
the chat but no thinking indication and no response.
There is the log in second image." The mobile logs
show no `→ [clawsuu]` line, the desktop log shows no
`Mobile chat received` line, and the agent reply
that DID appear in the mobile chat history was
likely a cached previous-turn reply — NOT a fresh
response to the user's "tested" message.

**The cause.** When the mobile reconnects to the
desktop rapidly, there's a brief race window:
1. Mobile opens WS (desktop `case 'open'` fires)
2. Mobile sends `{type: 'auth', token: '...'}` then
   WAITS for the auth round-trip.
3. During that wait, the user types and presses
   Send. The mobile's `sendMessage` runs,
   `syncClient.sendChat(text, aid)` is called.
4. The sync-client on the mobile (v3.10.109)
   checks `this.ws.readyState === WebSocket.OPEN`.
   The WS IS OPEN at this point. So the chat
   message gets sent over the wire.
5. On the desktop, the new connection is open but
   the auth handshake hasn't completed yet. The
   sync-server's `client.authenticated` flag is
   still false. The `case 'chat':` handler hits
   `if (!client.authenticated) return;` and
   silently drops the message.
6. The mobile thinks it sent. The desktop never
   saw it. No agent call fires. The user sees
   their text bubble but no "thinking" indicator
   and no reply.

**The fix (visibility, not prevention).** This
release logs `console.warn` on the desktop when a
chat hits the auth-window drop guard. The mobile
side already buffers during CONNECTING (v3.10.109),
but this is the desktop-side equivalent: when the
mobile sends a chat during the desktop's auth
pending window, we log it. The user's next
diagnosis step will show something like:

```
[SyncServer] chat dropped for ABC123 (Android Phone): not authenticated yet (text="tested a task")
```

in the desktop log instead of nothing. With that
signal we can decide whether the fix is:
- (a) **Real-time auth race**: have the desktop
  apply auth synchronously on WS `open` so the
  flag is true before any incoming messages can
  race.
- (b) **Buffer on desktop side**: queue chats that
  arrive during the handshake and process them once
  authenticated.
- (c) **Mobile sends `auth_result` ack as part of
  pair_request with the same call**: tighter
  race window.

The most likely fix is (b) because even with (a)
there's a TCP-write race where the mobile's chat
message arrives before the desktop finishes
processing the auth frame.

The fix is shipped disabled-by-default: just a log
line, no behavioral change. If the next "no reply"
report shows the warn line, we'll know it's an
auth race; if it doesn't show the warn line, the
issue is somewhere else entirely (and the log
filter change isn't masking it).

**Where:**
- `src/sync-server.js`, the `case 'chat':` handler.

**Mobile-side companion fix already shipped (v3.10.109):**
the mobile's SyncClient.send() buffers messages
when `readyState !== OPEN` and flushes them on
`auth_result success`. So this v3.2.39 fix closes
the same race from the OTHER end — the desktop's
recv side — while we figure out which side is
actually losing the message.

versionCode: n/a (desktop)
