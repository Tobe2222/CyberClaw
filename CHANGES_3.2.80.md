# v3.2.80 — fix `promptCompanionReaction` returning the agent OBJECT instead of the id string

## The bug

After v3.2.79 landed (the companion-attribution
patch), The user tested treats on the mobile arena and
reported on 2026-08-06 11:34:

> "Okey did a couple drops right now. And the button
> works." (button = the new jump-to-bottom feature)

So the attribution IPC was flowing correctly
(`[mobile-treat] placed: hamburger (near clawsuu)`),
but the chat reaction still didn't fire. Diagnostic
logs revealed the smoking gun:

```
[RI] [promptCompanionReaction] targetId= [object Object] hasAgent= false sleepState= n/a chat= true targetAgentId= clawsuu activeChatAgentId= clawsuu
```

`targetAgentId` is `'clawsuu'` (the string, correctly),
but `targetId` is `[object Object]`. The diagnostic
shows `hasAgent= false` — the lookup failed.

## Root cause

The v3.2.79 `promptCompanionReaction` looked up the
target agent like this:

```js
const targetId = (targetAgentId && agents[targetAgentId])
  || activeChatAgentId
  || (agentOrder.find(id => !hiddenCompanions.has(id)))
  || agentOrder[0];
```

When `targetAgentId = 'clawsuu'` and `agents['clawsuu']`
returned a truthy agent object, the `||` short-circuit
collapsed to the **object itself**, not the string id.

Then later in the function:

```js
const target = agents[targetId];
if (!target) return;
```

`agents[<agent object>]` becomes `agents["[object Object]"]`
= `agents[undefined]` = `undefined`. The guard trip:

```js
if (!target) return;  // ← bails here
```

…and no chat reaction ever fires. The function returns
silently. No error, no log, no toast.

This is the same bug class as the v3.10.79 constructor
wiring bug and the v3.2.78 serialization bug — **a
silent no-op caused by a value-shape mismatch between
two halves of a contract**. The producer (IPC handler)
puts the right type in; the consumer (this function)
expects to read it back as a different type.

## The fix

Yield the **id string** after the truthy check:

```js
const targetId = (targetAgentId && agents[targetAgentId] ? targetAgentId : null)
  || activeChatAgentId
  || (agentOrder.find(id => !hiddenCompanions.has(id)))
  || agentOrder[0];
```

A `targetAgentId && agents[targetAgentId]` returns the
agent object (truthy). Re-yielding `targetAgentId` after
the truthy check stores the id string. The `?: null`
fallback handles the case where the explicit target is
unknown (mobile sent a companionId that doesn't exist on
the desktop yet) so the `||` chain falls through to
`activeChatAgentId` cleanly.

## Diagnostic noise

The v3.2.79-dx diagnostic log ONE-LINER is kept in
this commit so we can verify the fix on next test
(should show `targetId= clawsuu hasAgent= true` for
the mobile treat path). Will be removed in v3.2.81
once confirmed.

## Files

- `src/js/app.js`: `promptCompanionReaction` —
  ternary yields the id string, not the agent object
- `package.json`: bump `3.2.79` → `3.2.80`

## Lesson (a fifth time, different bug class)

**Truthy checks that pass-through non-boolean values
must explicitly re-yield the value type the caller
expects.**

The pattern `const x = foo || bar` is fine when both
sides are the same shape (strings, numbers, objects).
It's a bug waiting to happen when the caller is
implicitly relying on the *type* of `x` — `agents[x]`
works for `x = 'clawsuu'` but breaks for `x = <obj>`.

Three safer patterns for this case:

1. **Re-yield after truthy check** (preferred when the
   id is the desired type):
   ```js
   const id = (targetAgentId && agents[targetAgentId] ? targetAgentId : null) || fallback;
   ```

2. **Boolean coercion** (when the truthy check is
   itself the boolean you want):
   ```js
   if (targetAgentId && agents[targetAgentId]) {
     // use targetAgentId directly
   }
   ```

3. **Explicit `?? null`** (when `||` is risky because
   `0` / `''` are valid):
   ```js
   const target = (targetAgentId && agents[targetAgentId]) ?? null;
   ```

The v3.2.79 code did none of these — it used `||`
pass-through of an object, which silently corrupted the
id-type.

## Larger lesson: silent contract mismatches

These five bugs are all variants of the same
archetype:

1. v3.10.79: **callback wiring missing** — producer
   didn't register the consumer
2. v3.2.15 / v3.2.12 / v3.2.24: **constructor
   forgot `this.onX = options.onX`** — same as #1
3. v3.2.78: **IPC payload non-cloneable** — producer
   passed wrong type across boundary
4. v3.2.79: **truthy pass-through wrong type** — same
   as #3, but at the JS level
5. v3.2.80: **this fix** — truthy pass-through of the
   agent object instead of the id

The pattern: **a producer puts data into a contract
the consumer expects to read back as a different
shape, and there's no validation between them**. The
runtime happily produces a working no-op.

**Mitigation:** add a `validateContract(payload, shape)`
helper at every IPC + function boundary. Could be a
weekly landing page. Defer to a follow-up.

## Verification (for the user)

1. Drop a meat on the mobile arena.
2. Expected: log shows `[promptCompanionReaction] targetId= clawsuu hasAgent= true sleepState= awake chat= true targetAgentId= clawsuu activeChatAgentId= clawsuu`.
3. Expected: chat:send fires within 100ms.
4. Expected: clawsuu replies in chat ("Yum, thanks
   for the meat!").
5. Expected: memory.md appends a `- the user gave me meat (food)` line.

If step 5 still doesn't happen, we've found the
deeper 12-day-old memory regression.