# v3.2.97 — piper voice download survives Hugging Face's relative 307 redirects

## Bug

The user reported (2026-08-13, post-v3.2.96 install): the desktop crashed when they picked
the 'joe' piper voice for the first time. The .onnx downloaded fine
(60.3MB, 100%) but the .onnx.json hit a Hugging Face 307 redirect with a
**relative** `location: /api/resolve-cache/models/...` header. The
recursive redirect handler in `downloadFile()` passed that bare path to
`http.get()`, which synchronously threw `Invalid URL`. The throw was
inside an HTTP callback, outside any try/catch — Node's
`uncaughtException` handler killed the entire Electron process. Result:
sync-server dropped, all WS clients lost, restart required.

The crash had been latent since v3.2.92 (when piper voices were first
added). It just happened to fire today because the user picked 'joe' for
the first time — the other 7 voices had been downloaded by earlier
picks or had absolute redirect targets. Relative 307s are common on
HF's CDN for metadata files. (No identifying info — only behavior
described.)

Also: the desktop that restarted came back as v3.2.96 (no fix), so the
joe voice would crash again on every cold start until either (a) the
voice was downloaded manually, or (b) someone picked a different
voice. Without this fix the v3.2.96 release effectively made joe /
ryan / sam / kristin unusable on first download.

## Fix

`src/local-ai.js` `downloadFile()`:

- Recursive `doRequest()` now resolves the redirect `location` against
  the **current** request URL via `new URL(reqUrl, url).toString()`
  before passing it to `http.get()`. Handles absolute paths unchanged,
  relative paths get resolved against the original URL's origin.
- Wraps the recursive `doRequest(location)` call in try/catch so any
  synchronous throw inside the next hop is captured as a promise
  rejection instead of an uncaught exception that kills Electron.

Verification: ran `node -e "la.ensurePiper('joe')"` against the fixed
code. Both .onnx and .onnx.json download successfully (process exits 0,
files appear at `~/.cyberclaw/local-ai/piper/en_US-joe-medium.onnx{,.json}`).
Before the fix the same call would throw `Invalid URL` and crash.

## Files changed

- `src/local-ai.js` — `downloadFile()` redirect handling (~20 lines)
- `package.json` — 3.2.96 → 3.2.97

## Lessons

**Hugging Face's CDN returns 307 redirects with relative `location`
headers for metadata files.** This is a CDN quirk that differs from
most other CDNs which always return absolute URLs. Any code that
follows redirects must resolve relative locations against the current
URL — the standard Node `https.get` and `http.get` accept relative
URLs only if they're passed via `new URL(rel, base).toString()` first.
The previous code worked for years because most CDNs (GitHub Releases,
AWS CloudFront, HF's binary CDN path) return absolute locations.

**Synchronous throws inside HTTP callbacks become uncaught exceptions
that kill the Node process.** The recursive `doRequest(location)` call
was unguarded — if anything inside the next hop threw synchronously
(invalid URL, malformed config, etc.), the throw bubbled past the
Promise constructor's body and hit Node's default
`uncaughtException` handler. Electron doesn't recover from that — it
dies. Wrap any recursive async-driven call in try/catch so failures
become promise rejections that the parent caller can handle.