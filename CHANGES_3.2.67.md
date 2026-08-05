# v3.2.67 — second httpTimeoutMs ReferenceError fix (v3.2.66 didn't actually fix it)

Tobe 2026-08-05 09:25:
> "tested. I sent a message but it did not show up
> in the chat for some reason, it said that clawsuu
> is thinking but im not sure if he got the message
> or not."

Stack from `/tmp/cyberclaw-desktop.log`:
```
Error occurred in handler for 'chat:send-message':
  ReferenceError: httpTimeoutMs is not defined
    at sendChatMessageViaHttp
      (src/main.js:1152:47)
```

Same error, same line, after v3.2.66 supposedly
fixed it. Why?

## The bug behind the bug

`sendChatMessageViaHttp` has a **nested** try/catch
structure that I missed in v3.2.66:

```js
async function sendChatMessageViaHttp(...) {
  // ... ctx assembly ...
  // ... build body, url ...

  // OUTER try — wraps the whole HTTP path, including
  // the response parsing, success/error returns, etc.
  try {
    // ... console.log POST line ...

    // INNER try — just the fetch + abort timer cleanup
    try {
      res = await fetch(url, { ..., signal: ctrl.signal });
    } finally {
      clearTimeout(httpTimer);
    }

    // ... response handling ...
    return { ok: true, reply: ... };
    return { ok: false, error: 'No reply...' };
  } catch (e) {                  // ← OUTER catch
    const reason = isAbort
      ? `aborted after ${httpTimeoutMs}ms`
      : (e?.message || 'unknown');
    // ...
  }
}
```

In v3.2.65, `httpTimeoutMs` was declared inside the
INNER try (around the fetch). The OUTER catch
couldn't see it.

In v3.2.66 I hoisted it out of the INNER try — but
**not out of the OUTER try**. The declaration was
still inside the outer try block, so it was still
invisible to the outer catch. Same ReferenceError,
same fix needed at a higher scope.

Any non-fetch error thrown from within the OUTER
try (e.g. `await res.json()` failing, an exception
in the response-shape handling, etc.) would trigger
the outer catch with `httpTimeoutMs` undefined.

## The fix

Hoist `const httpTimeoutMs = 60000;` to function
scope — declared AFTER the body/url construction
but BEFORE the outer `try {`. Now it's visible to
both the inner and outer try blocks AND the outer
catch.

```js
const url = `${gw.baseUrl}/v1/chat/completions`;

// FUNCTION scope — visible to outer catch
const httpTimeoutMs = 60000;

try {                                // OUTER try
  // ...
  try {                              // INNER try (just the fetch)
    res = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(httpTimer);
  }
  // ... response handling ...
} catch (e) {
  // httpTimeoutMs is now in scope here
  const reason = isAbort ? `aborted after ${httpTimeoutMs}ms` : ...;
  // ...
}
```

## Lesson

When you have **nested** try/catch (an outer one
wrapping a wider code path) and the catch needs to
reference a variable, that variable must be declared
OUTSIDE THE OUTERMOST try. Hoisting out of an inner
try isn't enough.

General rule: any variable the catch needs to
reference must be at the SAME scope level as the
catch itself. If the catch is at function scope
(wrapping the whole function body), the variable
must be at function scope. If it's at a block scope
(a smaller try inside a larger try), the variable
must be in the larger try but outside the smaller
one.

Self-review that catches this: when adding a catch
block that references a local variable, immediately
check whether the variable's scope includes the
catch block. If not, hoist it. Don't stop at the
first enclosing block — keep walking outward until
you find a scope that contains the catch.