# v3.2.1 — Settings: 🧠 LLM Providers section cleanup + provider presets

the user (in #cyber-dev): "Regarding the API section of the
settings. I never really tested much of that. Is that the
most appropriate API services? Are there more? Or better
ones suited to this app now that it has evolved some?"

Audit of the section turned up four issues worth fixing:

1. **Dead default-settings fields.** `keyAnthropic`,
   `keyOpenai`, `keyGoogle`, and `ollamaUrl` were declared
   in `DEFAULT_SETTINGS` but **never read anywhere** in the
   codebase. They were being silently re-saved on every
   `saveSettings()` call, perpetuating dead state in every
   user's localStorage blob forever.

2. **Duplicated well-known-model catalog.** The list of
   `anthropic/claude-*`, `openai/gpt-4o`, `google/gemini-*`
   and `ollama/llama3` models was inlined in TWO places:
   `refreshDefaultModelDropdown()` and
   `refreshForgeModelDropdowns()`. The two copies had drifted
   — the forge copy was missing the Ollama entry, so picking
   a local Ollama model in the forge required a previously
   saved endpoint while picking one in Settings worked
   out-of-the-box.

3. **No preset providers.** The "Add provider" form takes
   name + base URL + API style. Users pasting a known
   provider have to type all three plus hunt for the right
   base URL. OpenRouter alone has ~5 URL variants floating
   around docs and most users will typo them.

4. **Info text didn't mention the well-known providers
   work via the Default Model dropdown.** Anthropic,
   OpenAI, Google, and Ollama don't need any setup — the
   OpenClaw gateway routes them. The section info text
   only talked about "add your own LLM provider", which
   made it look like you had to add one to use anything.

## What changed

### 1. Dead fields removed with safe migration

`src/js/app.js`:

- Removed `keyAnthropic`, `keyOpenai`, `keyGoogle`,
  `ollamaUrl` from `DEFAULT_SETTINGS`.
- Added `LEGACY_PROVIDER_KEYS` constant listing them.
- `loadSettings()` now strips these keys from any saved
  blob on next load (no write-back — `saveSettings()` will
  persist the cleaned object on the next user-driven save,
  which avoids a redundant localStorage write on every
  settings open).

Backward compat: any user with one of these keys in their
saved blob will see them disappear from localStorage on
their next save action. The values were unread so there's
nothing to lose. The stale `// Legacy provider key fields
were removed; values still in s.* if previously saved.`
comment in `saveSettings()` is also gone — it's no longer
true.

### 2. Shared `WELL_KNOWN_MODELS` catalog

`src/js/app.js`:

- Extracted the catalog to a top-level `WELL_KNOWN_MODELS`
  const above `loadSettings()`.
- `refreshDefaultModelDropdown()` now uses
  `const wellKnown = WELL_KNOWN_MODELS;` (zero behavior
  change for that call site).
- `refreshForgeModelDropdowns()` now groups
  `WELL_KNOWN_MODELS` by `provider` into the
  `{group, options: [...]}` shape it needs. This **adds**
  the Ollama entry to the forge dropdown (which it was
  missing before) — a quiet bugfix on top of the dedupe.

### 3. One-click provider preset buttons

`src/js/app.js` + `src/index.html`:

- Added `PROVIDER_PRESETS` constant with six presets:
  OpenRouter, Groq, Together, Fireworks, Mistral, DeepSeek.
  Each carries `baseUrl`, sensible `defaultModel`, and
  `api: 'openai-completions'` (all six speak OpenAI wire
  format).
- `window.applyProviderPreset(id)` fills the add-form's
  name / baseUrl / defaultModel / api fields, clears the
  API key, opens the form if collapsed, and focuses the
  API key input so the user can paste and Save in two
  actions.
- `window.renderProviderPresets()` renders a row of small
  buttons above the "Add provider" details. Called on
  `DOMContentLoaded` (so the DOM is ready when settings
  opens) and again in `openSettings()` (cheap; idempotent).
- `src/index.html`: new `<div id="provider-presets">`
  container between the section info text and the
  `<details>` add form.

Ollama is intentionally NOT a preset — it has its own
section (🦙 Local LLM Endpoints) with auto-detect, and
its models need runtime discovery rather than a single
default.

### 4. Section info text updated

`src/index.html`: the explanatory paragraph now mentions
that Anthropic / OpenAI / Google / Ollama work via the
Default Model dropdown above and don't need setup. The
preset row is mentioned as the next option for everything
else.

## Files touched

- `src/js/app.js` (defaults cleanup, shared catalog,
  preset code, DOMContentLoaded + openSettings hooks,
  stale comment removal)
- `src/index.html` (info text rewrite, preset container)
- `package.json` (3.2.0 → 3.2.1)

## Companion release

Nothing mobile-side. The mobile app reads the desktop's
provider list via the sync server, so changes here
propagate automatically on the next reconnect. The
`messagesByAgent`-style cache it builds will pick up the
new `ollama/llama3` forge option on next refresh.
