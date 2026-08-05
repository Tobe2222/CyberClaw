# v3.2.66 — fix ReferenceError on httpTimeoutMs (v3.2.65 regression)

Tobe 2026-08-05 08:56:
> "But I had this error when talking to clawsuu on
> cyberclaw. What happened here?"
> [screenshot: `Error: Error invoking remote method
> 'chat:send-message': ReferenceError:
> httpTimeoutMs is not defined`]

## Root cause

In v3.2.65 I added the 60s HTTP fetch timeout to
`sendChatMessageViaHttp` with this shape:

```js
try {
  // ...
  const httpTimeoutMs = 60000;
  const ctrl = new AbortController();
  // ...
  res = await fetch(url, { ..., signal: ctrl.signal });
  // ...
} catch (e) {
  const isAbort = e?.name === 'AbortError' || /aborted/i.test(...);
  const reason = isAbort ? `aborted after ${httpTimeoutMs}ms` : ...;
  // ...
}
```

`httpTimeoutMs` was declared with `const` **inside**
the `try` block. `const` is block-scoped, so the
`catch` block cannot see it. As soon as the fetch
threw ANY error (e.g. a non-AbortError ECONNREFUSED,
a malformed token, anything), the catch block tried
to evaluate `httpTimeoutMs` and threw
`ReferenceError: httpTimeoutMs is not defined`. The
desktop's IPC handler then bubbled that as the user-
visible error.

Stack from `/tmp/cyberclaw-desktop.log`:
```
Error occurred in handler for 'chat:send-message':
  ReferenceError: httpTimeoutMs is not defined
    at sendChatMessageViaHttp (src/main.js:1146:47)
    at process.processTicksAndRejections (...)
```

## Fix

Hoist `const httpTimeoutMs = 60000;` out of the try
block to the function scope (just above the `try`).
Now the catch block can reference it. No other
behavior changes; the timeout still fires at 60s,
still aborts the fetch, still falls through to the
CLI fallback on abort.

## Files

- `src/main.js` — single line move + comment.
- `package.json` — bump to 3.2.66.
- `CHANGES_3.2.66.md` — this file.

## Lesson

When you reference a variable in a `catch` block that
needs to be visible there, declare it OUTSIDE the
`try`. `const` and `let` are block-scoped to the
innermost block, not the function. This bites you
when the catch is doing error-message construction
and references the same variables the try used —
the most common shape is `try { const x = ...; ... }
catch (e) { msg = `failed with ${x}`; }`.

If you want to keep the declaration close to its
use, declare it just above the `try` in the function
scope. Always test the catch path with a non-abort
error (e.g. a deliberate ECONNREFUSED) before
shipping — the `ReferenceError` only fires when the
catch actually runs.