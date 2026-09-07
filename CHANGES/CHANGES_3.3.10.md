# v3.3.10 — Companion Forge: provider-first model picker + drop secondary fallback

Tobe (2026-09-07 10:28, Discord #cyber-dev):
"lets remove fallbacks and update the catalog, and make it
easy for the user so it just needs to select a provider and
then their keys or similar. Do this for both desktop and
mobile."

Tobe (2026-09-07 10:57, follow-up):
"Okey cool but the catalog is not up to date. There have
been several releases lately. And we also need to be able to
use others aswell, like minimax etc. Could we add a generic
input also? Where the user can input Whatever he has? As user
friendly as possible. Or just one good setup for generic so
we dont have to update them constantly with new releases."

## The shift: catalog → generic

The v3.2.26 forge model dropdown hard-coded a list of 8 models
across 4 providers. Two problems:

1. **Catalog drift** — new models shipped faster than we updated
   the list. Claude Opus 4.8, GPT-5.5, GPT-5.4 Mini, Gemini 3
   Preview all landed without support.
2. **Closed provider set** — the user couldn't use MiniMax,
   OpenRouter, Mistral, Kimi, Groq, Moonshot, or any custom
   baseUrl. These are all supported by the OpenClaw gateway
   but invisible to the desktop UI.

The new design: pick a provider (curated list), paste a key,
**type any model id**. The wire value is `provider/model`.
For local/self-hosted runtimes, use the existing Settings →
LLM Endpoints section.

## What changed

### 1. Forge model panel redesign

Old: two `<select>` dropdowns (Primary / Secondary) with hard-
coded `<optgroup>` lists.

New: a single "🧠 Model" section with:

- **Provider picker** — curated list of providers Tobe
  explicitly named (Anthropic, OpenAI, Google, MiniMax,
  OpenRouter, Mistral, Groq) plus a "Custom" entry that
  reveals a baseUrl field for anything else.
- **API key field** (cloud providers only) — masked
  input + 👁 toggle + 💾 save button. Saves to the existing
  `~/.openclaw/cyberclaw/providers.json` registry (same
  IPC the desktop's Settings → LLM Providers uses). Local
  providers hide this row.
- **Free-text model input** — no catalog. Placeholder
  rotates based on the chosen provider so the user sees a
  sensible hint, but they can type anything.
- **Status hint** — shows the suggested env var name
  (e.g. "Hint: `MINIMAX_API_KEY` env var works too.") so
  the user knows their options for getting the key to the
  runtime.
- **Local endpoints link** — "Self-hosted / local? Use
  Settings → LLM Endpoints instead." Mirrors the mobile's
  local-runtimes separation.

Hidden `<input id="forge-model-primary">` and `<input
id="forge-model-secondary">` are kept (with empty values)
so any stale JS that still references them gets `null` /
`''` cleanly instead of a missing-element error.

### 2. Drop the secondary / fallback

Tobe: "remove fallbacks". One model per companion.

- The "Secondary" row is gone from the markup.
- The save path no longer writes `secondaryModel`.
- The wire field is still in the desktop's
  `sprite_config_sync` ALLOWED whitelist, so existing
  `sprites.json` entries aren't sanitized away — they
  just stay on disk, unused.

The OpenClaw gateway's existing per-provider `fallbacks:`
chain (configured in `models.providers.<id>.fallbacks`)
still handles provider-down recovery at the runtime
layer. A per-companion secondary was redundant.

### 3. WELL_KNOWN_MODELS refresh

Used by the global "Default Model" dropdown in Settings
(not the forge — the forge is now generic). Refreshed:

| Old | New |
|-----|-----|
| `anthropic/claude-opus-4-6` | `anthropic/claude-opus-4-8` |
| `anthropic/claude-sonnet-4-6` | (kept) |
| `anthropic/claude-haiku-3.5` | (dropped) |
| `openai/gpt-4o` | (replaced) |
| `openai/gpt-4o-mini` | (replaced) |
| (none) | `openai/gpt-5.5` |
| (none) | `openai/gpt-5.4-mini` |
| `google/gemini-2.5-pro` | (kept) |
| `google/gemini-2.5-flash` | (kept) |
| (none) | `minimax/MiniMax-M3` |
| (none) | `openrouter/auto` |
| `ollama/llama3` | (kept) |

`formatModelName()` table updated with pretty names for
the new ids (so the inspect panel + chat UI show "Claude
Opus 4.8" not "claude-opus-4-8").

### 4. New `provider_save` sync-server case

The mobile's CompanionEditScreen can now ship an API key
to the desktop:

```
{ type: 'provider_save', provider: { id, name, baseUrl, apiKey, ... } }
```

Handled by the existing `providers:save` IPC logic (just
inlined to avoid the IPC handler registration dance). The
mobile doesn't need to know about Electron IPC — it sends
the message and trusts the desktop to persist.

### 5. CSS

The existing `.forge-traits-section` / `.settings-row` /
`.settings-input` styles cover everything. No new CSS.

## Files changed

- `src/index.html` — replaced the Primary/Secondary
  `<select>`s with the new provider + key + free-text
  model panel.
- `src/js/app.js` — new `FORGE_PROVIDERS` table +
  `hydrateForgeModelPanel` / `readForgePrimaryModel` /
  `onForgeProviderChange` / `toggleForgeKeyVisibility` /
  `saveForgeProviderKey` / `openLocalEndpointsSection`
  helpers. Refreshed `WELL_KNOWN_MODELS`. Refreshed
  `formatModelName`. Removed `secondaryModel` writes from
  the save path.
- `src/main.js` — new `onSaveProvider` callback wired into
  the SyncServer constructor; persists to the same
  providers.json store.
- `src/sync-server.js` — new `case 'provider_save'`
  handler.

## Verification

- TypeScript: N/A (desktop is plain JS).
- Manual mental test (desktop):
  1. Open companion forge for `Cyber_Database`.
  2. Provider picker defaults to "— Choose a provider —".
     Select "🐱 MiniMax".
  3. API key field appears, placeholder "paste your API key".
     Type `sk-minimax-test-...`. Click 💾. Status hint shows
     "✓ API key saved for minimax".
  4. Model field placeholder shows "MiniMax-M3". Type
     `MiniMax-M3`. Composed wire value shows
     "Saves as: minimax/MiniMax-M3" (inline preview).
  5. Click ⚔️ Save. sprites.json gets
     `primaryModel: "minimax/MiniMax-M3"`. No
     `secondaryModel` written. Agents list re-broadcasts.
  6. Open forge again → provider field auto-selects
     "MiniMax", key field shows `••••••••` (masked),
     model field shows "MiniMax-M3". ✓
- Manual mental test (backward-compat):
  1. Existing companion has
     `primaryModel: "anthropic/claude-opus-4-6"` in
     sprites.json (saved by v3.3.9 or earlier).
  2. Open forge. Provider field auto-selects
     "🅰️ Anthropic". Model field shows "claude-opus-4-6".
     ✓ Round-trips.
- Open a forge on a companion with `secondaryModel`
  set (legacy). Forge never displays it. Save path
  doesn't touch it. sprites.json still has it on disk.
  ✓ No data loss.

## UX lessons

- **Catalog maintenance is the wrong battle.** Picking a
  free-text input + a small curated provider hint is
  cheaper to maintain and lets the user use models we
  haven't heard of yet. The provider list itself stays
  curated because that's a stable concept (Anthropic
  isn't releasing a new company every week); individual
  models move fast and don't belong in our code.
- **Provider routing lives in the gateway, not the
  client.** The wire value `provider/model` carries the
  intent; the OpenClaw gateway does the actual routing.
  Both desktop and mobile just generate the string.
- **Always keep the ALLOWED whitelist stable across
  breaking changes.** Even though we're no longer writing
  `secondaryModel`, we kept it in the whitelist so any
  saved values survive. Removing the field on the
  whitelist would silently delete user data.
