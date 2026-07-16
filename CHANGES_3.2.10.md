# v3.2.10 — Fix desktop CI release creation (silent softprops v2 failures)

Tobe (post v3.2.9):

> "the new builds failed"

## Symptom

Every `build-windows` / `build-linux` / `build-mac` job in the
`Build & Release` workflow reports `Upload to release` step as
`success` in the Actions UI, but **no GitHub Release was ever
published**. Verified via the API:

```bash
curl -s "https://api.github.com/repos/Tobe2222/CyberClaw/releases"
# → [] (empty array, 0 releases)
```

The mobile repo (`Cyber_Claw_Mobile`) has 30+ releases published
since v3.2.25, all working. The desktop repo has 0 releases
across v3.0.0 → v3.2.9 (15+ tagged builds, all with
"successful" upload steps).

## Root cause

`softprops/action-gh-release@v2` is unmaintained and silently
fails to create releases on certain runner / token combinations.
The action returns exit 0 (success) even when no release is
published, so the workflow step appears green in the UI while
doing nothing in the background.

This explains why Tobe's APK downloads have had version-mismatch
issues (downloaded v3.10.31, app shows v3.10.30): the
desktop's "release download" UX has been broken since v3.0.0,
so any APK Tobe pulled was either built manually or from the
per-run artifacts page, and the install/App-side APK version
is its own thing. The mobile repo's release has also been
broken in this exact same way — recent mobile releases
(v3.10.30 etc.) exist in `releases/` because the mobile
migrated to the gh CLI approach in v3.2.25.

## Fix

Switch all three platform jobs from `softprops/action-gh-release@v2`
to direct `gh release` CLI via `nick-fields/retry@v3` — the same
pattern the mobile repo has been using since v3.2.25:

1. Check if the release already exists (`gh release view`)
2. If yes → `gh release upload ... --clobber` (replace asset)
3. If no → `gh release create ... --generate-notes <assets>`

Wrapped in `nick-fields/retry@v3` for transient HTTPS / CDN
hiccups (4 attempts with 15s waits, 5-minute timeout).

Also added `env.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'` at
the workflow level — addresses the Node 20 deprecation warning
GitHub surfaces on every run (softprops v2 still targets Node 20
internally; the force flag tells GitHub to keep it on Node 24
instead of relying on auto-detection).

## v3.2.10.1 — same fix needs `shell: bash` on Windows

Tobe (after v3.2.10):

> "the windows build failed again"

Build-windows job's Upload-to-release step was failing at 1m 5s
runtime (4 retry attempts × ~2s each + 3 × 15s waits = 53s, with
~12s in the action's polling overhead). Each attempt failed
identically in ~2s — a tell that the failure wasn't transient
(network/CDN) but a deterministic parse/runtime error.

Cause: `nick-fields/retry@v3` defaults to **powershell** on
Windows runners. The `command:` payload is bash syntax (`set
-e`, `>/dev/null`, `2>&1`, the `if/then/fi` block). PowerShell
chokes on `set -e` and `2>&1`, exits with a parse error on the
first line, retry-v3 then waits 15s and re-runs the same
broken script → all 4 attempts fail the same way.

Linux/mac jobs defaulted to bash so they worked. Only Windows
was failing.

Fix: added `shell: bash` to the Windows Upload-to-release
step's `nick-fields/retry@v3` `with:` block. Linux/mac are
unchanged (the bash default was already correct there).

## Files

- `.github/workflows/build.yml` — replaced softprops v2 with
  `gh release` + `nick-fields/retry@v3` for all 3 platforms
- `package.json` 3.2.9 → 3.2.10

## What this means for Tobe

After this lands + the next desktop tag push, **all future
desktop releases will actually appear at
`https://github.com/Tobe2222/CyberClaw/releases`** for download.

To get the v3.2.9 desktop build (with the agent_history shape
fix), the options are:
1. Download the build artifact from a successful Actions run
   directly. Run #29474608962 succeeded for windows; the
   artifact is at the bottom of the job page
2. Build locally with `npm run build:win` / `build:linux` /
   `build:mac`

The mobile v3.10.33 APK IS published (mobile's CI already uses
this gh-CLI pattern) and contains the arena-text removal +
first-turn settle/cue fixes. The chat history defensive fallback
isn't in the v3.10.33 APK (added in a later force-push), but
that's belt-and-suspenders — the desktop v3.2.9+ fix normalizes
the wire shape so the mobile doesn't need to do anything.