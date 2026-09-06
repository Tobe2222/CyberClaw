# v3.2.77 — wire up 4 missing callbacks in SyncServer constructor (mobile feed/wake/activity-ping silently no-op'd)

## The bug

After the v3.10.137 mobile fix shipped (correctly sending
`arena_treat_placed` as a JSON object instead of a
double-stringified string), The user tested the new APK and
reported on 2026-08-06:

> "clawsuu still cant recognize that he has been feeded.
> It does appear in the log tho."

The v3.2.76 per-message log confirmed the message
arrived at `sync-server.js`:

```
[SyncServer] msg type=arena_treat_placed from Android Phone
[SyncServer] msg type=arena_treat_eaten from Android Phone
```

But the companion **still didn't react**.

## Root cause

Four callbacks were added to `SyncServer`'s case-dispatch
in `_handleMessage` between v3.2.12 and v3.2.24, but the
constructor never copied them from `options` onto `this`:

| callback | added in | callsite in sync-server.js |
|---|---|---|
| `onMobileWakeAgent` | v3.2.12 (commit c61315a) | line ~448 |
| `onArenaTreatPlaced` | v3.2.15 (commit f0acdd9) | line ~494 |
| `onArenaTreatEaten` | v3.2.15 (commit f0acdd9) | line ~509 |
| `onMobileActivityPing` | v3.2.24 (commit 3bce0c1) | line ~478 |

Every callsite looks like:
```js
if (this.onArenaTreatPlaced) {
  this.onArenaTreatPlaced(msg.treat || 'apple', { ws, deviceName: client.name });
}
```

But `this.onArenaTreatPlaced` was `undefined` — the
constructor only copied `onChatMessage`, `onVoiceTranscript`,
`onAudioInput`, `onAttachment`, and the quest/sprite/soul
callbacks. So the `if (this.onX)` guard was always false and
the callback **silently never fired**. No error, no log,
no-op.

This is exactly the same bug class as v3.10.79 (quest
callbacks missing from constructor — The user hit that on
2026-07-22 with the quest editor showing "Couldn't update
quest" repeatedly). The comment block at lines 56-69 of
sync-server.js even documents that exact pattern.

## User-visible impact

| feature | status before this fix |
|---|---|
| Mobile feed → AI reaction | ❌ silently dropped |
| Mobile feed → companion "ate it" reaction | ❌ silently dropped |
| Mobile "wake companion" button | ❌ silently dropped |
| Mobile activity heartbeat (keep-awake) | ❌ silently dropped |

All four messages arrived at the sync-server and were
logged, but the handler chain stopped there. No IPC event
reached the renderer, so no chat reaction, no state flip,
no lastInteractionTs bump.

## The fix

Add four lines to the `SyncServer` constructor:

```js
this.onMobileWakeAgent = options.onMobileWakeAgent || null;
this.onMobileActivityPing = options.onMobileActivityPing || null;
this.onArenaTreatPlaced = options.onArenaTreatPlaced || null;
this.onArenaTreatEaten = options.onArenaTreatEaten || null;
```

`main.js` was already passing all four callbacks in the
SyncServer options object (lines 3236, 3247, 3273, 3287),
so the rest of the chain (sync-server → main.js callback →
`mainWindow.webContents.send` IPC → renderer's
`ipcRenderer.on`) lights up automatically.

## Files

- `src/sync-server.js`: add the 4 constructor assignments
  + a long comment block explaining the bug + the lesson
- `package.json`: bump `3.2.76` → `3.2.77`

## The lesson (re-stated for the third time — same bug class)

**Whenever you add a `this.onXyz` reference in
`_handleMessage`, you must also add
`this.onXyz = options.onXyz || null;` in the constructor.**

The `if (this.onXyz)` guard silently masks the missing
wiring — there's no error, no log, just a no-op. The
sister comment at v3.10.79 already says this. Apparently
twice is not enough.

**Mitigation idea (deferred):** replace the silent
`if (this.onXyz)` guard with a one-time warning log on
first undefined access, e.g.:

```js
if (this.onArenaTreatPlaced) {
  this.onArenaTreatPlaced(...)
} else if (!this._warnedMissingArenaTreatPlaced) {
  this._warnedMissingArenaTreatPlaced = true;
  console.warn('[SyncServer] arena_treat_placed received but onArenaTreatPlaced callback not wired');
}
```

This would have surfaced the bug within minutes of the user's
first feed test instead of ~2 weeks later.

## Verification (for the user to confirm)

1. Restart the desktop (`npm start`).
2. Drop a treat on the mobile arena.
3. Expected: companion gives a 1-2 sentence reaction in
   chat ("Yum, thanks for the burger!").
4. Expected: log shows `[mobile-treat] placed: <treat>`
   (the renderer's first console.log inside the
   `mobile-arena-treat-placed` IPC handler).
5. Also try: tap the moon/sleep button on mobile → companion
   wakes immediately + log shows `[mobile-wake] woke
   companion ...`.