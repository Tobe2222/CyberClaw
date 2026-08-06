# v3.2.82 — fix `cyberclaw.companions.rememberMemory` (wrong API path) + drop placed reaction

## Two fixes in one release

### 1. Renderer's rememberMemory path was wrong

After v3.2.80 made the chat reaction fire, Tobe
flagged on 2026-08-06 that clawsuu still doesn't
"remember" food across sessions. The memory.md file
was last modified 2026-07-25, 12 days ago, despite
daily treat activity.

Diagnostic revealed the cause:

```
[RI] [memory-dx-pre] treat_placed: memoryAgentId=clawsuu hasCyberclaw=false hasRememberMemory=undefined
```

`hasCyberclaw=false`. The renderer was calling
`cyberclaw.companions.rememberMemory(...)`, but the
preload (`src/preload.js:74`) actually exposes
`rememberMemory` at `cyberclaw.agents.rememberMemory`.
The `?.` optional chain silently returned `undefined`
and the `if` block was bypassed — no IPC fired, no
file write.

This affected **8 call sites** in `src/js/app.js`
(5 treat-related, plus `promptCompanionSilent` and
`placeTreatOnArena` + `promptCompanionEat`). All
fixed in a single `sed`:

```sh
sed -i 's/cyberclaw\.companions\.rememberMemory/cyberclaw.agents.rememberMemory/g' src/js/app.js
```

Now `cyberclaw.agents.rememberMemory` matches the
preload shape. Memory appends work, `memory.md` will
be updated for every treat event.

### 2. Drop the placed reaction — one comment per treat, not two

Tobe's screenshot from 2026-08-06 13:18 showed
clawsuu producing two consecutive chat bubbles per
food drop:

- "Tobe, you're literally grinding meat into my
  goblin belly..." (placed reaction)
- "Juicy, filling, the kind of protein that hits
  your goblin soul..." (eaten reaction)

Same pattern for the apple: "Apple redemption..."
followed by "Crunchy, sweet, kinda the palate
cleanser...". Tobe flagged: "we dont want that".

The mobile arena fires TWO IPC events per drop:

- `treat_placed` — when the food hits the ground
- `treat_eaten` — when a companion consumes it

The desktop renderer had two chat reactions
(`promptCompanionReaction` in each handler), producing
two bubbles. The eaten reaction ("I just ate X") is
the natural companion voice. The placed reaction
("I just gave you X") was a user-prompt-flavored
question that felt redundant when the eaten reaction
arrived ~1 second later.

**Fix:** removed the `promptCompanionReaction` call
from the `mobile-arena-treat-placed` handler. Memory
append stays (deterministic, cross-session recall).
The eaten handler is unchanged — it still fires the
chat reaction + memory append.

Edge case: a treat dropped out of range of any
companion gets NO chat reaction now. Acceptable
tradeoff — the placed reaction was a question to
the companion ("what do you think?"), and the
silence when nothing eats is honest.

## Diagnostic cleanup

The temporary `[memory-dx-pre]` / `[memory-dx]` /
`[promptCompanionReaction]` diagnostics added in
v3.2.79-dx and v3.2.81-dx are removed (or
commented out) — they served their purpose. The
`[memory-dx]` lines in main.js's IPC handler are
also reverted to the original terse form.

The `[mobile-treat] placed: <treat>` and
`[mobile-treat] eaten: <treat>` lines remain — they're
useful for confirming the chain lights up.

## Files

- `src/js/app.js`:
  - `cyberclaw.companions.rememberMemory` →
    `cyberclaw.agents.rememberMemory` (8 sites)
  - Removed `promptCompanionReaction` call in
    `mobile-arena-treat-placed` handler
  - Cleaned up diagnostic `console.log` lines
- `src/main.js`:
  - Restored terse `ipcMain.handle('companion:remember-memory')`
    body (removed diagnostic)
- `package.json`: bump `3.2.81` → `3.2.82`

## Verification (for Tobe)

1. Drop a treat on the mobile arena.
2. Expected: ONE chat bubble from clawsuu ("Yum, that
   was good!") — not two.
3. Expected: `clawsuu/memory.md` gets a new
   `- Tobe gave me <food> (<category>)` line
   (verify with `cat ~/.openclaw/cyberclaw/companions/clawsuu/memory.md`).
4. Expected: desktop log shows `[mobile-treat] placed`
   AND `[mobile-treat] eaten` (both events still
   fire) but only one `[chat:send]` per drop.

## Lesson (sixth in this thread)

**API path typos in renderer code are silent.** When
`cyberclaw.companions.rememberMemory` is undefined
and the code uses `?.` optional chaining, the whole
block silently no-ops. No error, no warning, no log
unless you add one.

The diagnostic pattern that worked here:
1. Add a `console.log` BEFORE the if-check, printing
   the value of each piece of the chain
   (`memoryAgentId`, `hasCyberclaw`, `hasRememberMemory`).
2. The log tells you which link is broken.

For the broader silent-no-op problem, the right
fix is:
- A lint rule that flags `cyberclaw.?.X` patterns
  where X isn't on the preload surface (would
  require a custom rule + a build-time
  introspection of preload exports)
- OR a dev-mode `validateContract` helper that
  asserts every IPC handler + every renderer
  call site match the preload surface

Both are worth pursuing. The validateContract
proposal has been a deferred item for two days now;
let me commit to writing it up after this thread
wraps.

## Bigger picture

**Six silent-no-op bugs in one thread.** Pattern:
1. v3.2.77 — constructor missed callback wiring
2. v3.2.78 — IPC payload non-cloneable
3. v3.2.79 — truthy pass-through wrong type (agent
   object instead of id string)
4. v3.2.81 — `cyberclaw.companions.rememberMemory`
   (wrong API path) — this fix
5. v3.2.82 — placed + eaten producing double
   comments (UX, not silent — but related class)
6. (Earlier, in mobile) v3.10.137 — double
   `JSON.stringify` in syncClient.send

All six have a common shape: **the producer + consumer
agree on the data shape at the API boundary, but the
runtime silently fails to act on it because some
intermediate step doesn't match**. The bugs were
all surfaced by patient log-grepping + adding one
diagnostic line at a time.

Time to write the validation helper. The validateContract
proposal should land as v3.2.83 (deferred follow-up
PR, separate commit).