# v3.2.65 — HTTP timeout + safe CLI fallback for chat:send

the user 2026-08-05 06:04:
> "@Clawsuu any idea why hes not answers?"

Then 06:12:
> "@Clawsuu he answered now, its just that the
> clawsuu is thinking was not there. But he spewed
> alot of crap. He should not"

Two problems, one root cause, two fixes:

## 1. Mobile chat hung for 5+ minutes with no reply

The CyberClaw desktop's HTTP path for `chat:send-message`
calls `fetch()` against the local OpenClaw gateway
(`127.0.0.1:18789/v1/chat/completions`) with **no
timeout**. When a per-session lane in the gateway
wedges — e.g. an aborted run that never clears its
`activeAhead=1` slot in the lane diagnostics — every
subsequent call to the same session queues behind the
dead one and the fetch hangs until the upstream
provider timeout fires (often minutes).

The renderer-side typing-bubble watcher force-clears
at 300s, but the underlying `await fetch()` keeps
blocking, so the renderer never gets a reply to send
to the mobile. Every subsequent mobile message
queues behind the stuck call. User sees nothing.

**Diagnostic trail (from `/tmp/cyberclaw-desktop.log`):**
```
[chat:send/http] POST http://127.0.0.1:18789/v1/chat/completions  ← last successful
... 60 minutes of OpenClaw tail chatter, no chat:send activity ...
[mobile-chat] hold elapsed, sending text-only: [From: Android Phone] ?  ← the user's first message
[mobile-chat] hold elapsed, sending text-only: [From: Android Phone] Hey
[mobile-chat] hold elapsed, sending text-only: [From: Android Phone] Hello
[RW] [sendChatMessage] typing bubble > 300s, force-clearing
[chat:send/http] fetch failed: fetch failed  ← finally gave up
```

And from `/tmp/openclaw/openclaw-2026-08-05.log`:
```
{"subsystem":"diagnostic","lane wait exceeded:
 lane=session:agent:clawsuu:openai-user:cyberclaw:clawsuu
 waitedMs=143422 queueAhead=0 activeAhead=1 activeNow=0 queueBehind=4"}
```

The clawsuu mobile-session lane had one active run
that never resolved; four queued behind it, all
waiting >140s each. Gateway itself was healthy
(default-agent calls succeeded in 3-5s, minimax API
responded in 0.16s).

**Fix:** wrap the HTTP `fetch()` in an
`AbortController` with a 60s timeout. On abort,
fall through to the CLI fallback path (which now
works correctly — see #2). Renderer fails fast
instead of hanging 5 minutes.

## 2. CLI fallback dumped the system prompt into the chat

When the HTTP path gave up and fell back to
`sendChatMessageViaCli` (which runs
`openclaw agent -m "<message>"`), the desktop
passed the message through `execCb` →
`/bin/sh -c "..."`. The escape did `"` → `\"`
but left literal newlines, backticks, and dollar
signs intact. `/bin/sh` saw a multi-line script
with unbalanced quoting and barfed:

```
/bin/sh: 1: cannot open agentId: No such file
/bin/sh: 1: cannot open quest.directory: No such file
/bin/sh: 1: INSTRUCTIONS.md: not found
/bin/sh: 1: remember_fact: not found
/bin/sh: 1: CREATE_QUEST: not found
...
```

`child_process.exec` then set `err.message` to
that entire multi-line error string. The desktop
returned `{ ok: false, error: err.message }` and
the renderer displayed `Error: <30KB of stderr>`
as the chat bubble. The user saw it as "he spewed alot
of crap."

**Fix:** switch the CLI fallback from `execCb` to
`spawn(bin, ['agent', '-m', finalMessage, '--agent',
agentId, '--json'])`. `spawn` takes the argv as an
array — no shell interpretation at all, so newlines
and special chars go straight to the child as one
argv entry.

Also tighten the error path: if the child exits
non-zero with no usable stdout, return a short
friendly error string instead of the raw stderr.
The verbose stderr now goes to `cliStderr` field
which the desktop logger can surface separately
(via `desktop-log` IPC), but never into the user's
chat bubble.

## Reproduction (pre-fix, before this patch)

```
$ node /tmp/test-cli-fallback.mjs   # with multi-line, $/backtick payload
Message length: 1397 bytes
Spawning openclaw with argv array (no shell)...
exit code=0 elapsed=12194ms
stdout length: 34228   ← proper JSON reply
stderr length: 170
```

Compare to the old `execCb` path — when the
message grew to ~30KB with the full system prompt
+ tags, `/bin/sh -c` failed to parse it.

## Files

- `src/main.js`
  - `sendChatMessageViaHttp`: 60s AbortController
    timeout on the fetch; clear timer in `finally`;
    surface "aborted after 60000ms" reason in the
    fallback hint.
  - `sendChatMessageViaCli`: switch from `execCb`
    (which shells out) to `spawn` (which doesn't).
    Same 180s kill-timer semantics; non-zero exit
    returns a short friendly error string instead of
    raw stderr.

## Test

`npm start` after pulling. Send a mobile chat
message while the gateway is down (kill the
`openclaw-gateway` systemd unit) — the message
should fall through to the CLI path and get a real
reply, not a wall of stderr.