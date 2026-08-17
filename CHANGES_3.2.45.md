# v3.2.45 — chat calls serialized per agent (no more lost replies)

## 1. Per-agent call chain

**the user's report (2026-08-02 18:51):**
> "I ask for something, then no reply, i have to ask whether
> its done or not, then he tells me he has done them and
> asks if i have not seen hes replies."

**What was happening:** the `chat:send-message` IPC handler
in main.js spawns an `openclaw agent -m ...` process per
chat message. Two such processes share the same session log
on disk. The renderer's `sendChatMessage` had a `chatBusy`
flag that would force-reset after 15s — and the second
user message ("Hello?") would start a SECOND agent
process while the first was still in flight.

The result: the first process's final assistant text
(where the LLM said "done, I made the changes") was
written to the session log but never broadcast to the
mobile — because the renderer had already moved on to
the second call's reply. The second call's LLM looked at
the session log (which DID contain the first call's tool
calls) and replied with "Yeah I finished the cleanup
already" — a LIE, because the user never saw the actual
first reply.

**the user's chat screenshot confirmed this:** the reply
"Yo, I'm here — finished the hive control cleanup
already, didn't you get the message?" was the LLM in
the second call responding to "Hello?" with a
hallucinated status based on the prior session log.

## 2. The fix

Per-agent promise chain via `chatSendChain: Map<agentId, Promise>`.
`sendChatMessage` now:

1. Resolves the agent (pre-pick, no side effects).
2. Looks up the prior call's chain promise for that agent.
3. Creates a new chain promise and stores it in the map.
4. `await`s the prior promise before starting its work.
5. Calls the original `__sendChatMessageImpl` body.
6. Resolves its own chain promise in `finally` (success or
   error).

Net: calls are strictly serialized per agent. Different
agents (Clawsuu vs Lamasuu) can still run in parallel.
Each user message gets exactly one reply, in order.

The `chatBusy` wait cap was also bumped from 15s to 95s
to match the IPC's 90s timeout. A complex tool-use task
("edit 7 files") can easily take 30-60s, and the old 15s
cap let the second message fire before the first finished.

## 3. Why the chain is per-agent, not global

A global mutex would serialize all chat messages across
all agents. If the user sends a message to Lamasuu while
Clawsuu is still working, Lamasuu's response would block
behind Clawsuu's. That's wrong — the agents are
independent. The per-agent map lets the queues stay
isolated.

## 4. Trade-off

The user may now see a "typing..." indicator for longer
(up to 90s on a complex task). The 15s force-reset was a
safety net for hung requests; with the chain there's no
need to interrupt — the second message waits its turn
patiently. The user still has the cancel input / closing
the app to abandon a hung request.

We also log every queued message in the desktop log so
the user can see "⏳ Waiting for previous AI reply" in
the Log tab. The mobile's typing indicator is unchanged.

## Files changed

- `src/js/app.js`:
  - New `chatSendChain: Map<agentId, Promise>`.
  - `window.sendChatMessage` is now a thin wrapper that
    awaits the prior call's chain promise, then delegates
    to `__sendChatMessageImpl` (the original body, renamed).
  - `chatBusy` wait cap: 15s → 95s.
- `package.json` — version 3.2.44 → 3.2.45

**v3.2.45 (desktop).**
