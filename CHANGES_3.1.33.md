# v3.1.33 — per-companion LLM via user-managed endpoints

## Why

Until now, every companion silently used the global default LLM (`minimax/MiniMax-M3` in your config). The `forge-model-primary` dropdown in the companion editor updated `agent.spriteConfig.primaryModel` but never propagated the choice to `openclaw.json`'s `agents.list[i].model.primary` — so the gateway kept routing every agent to the default model regardless of what the picker said.

Tobe's vision: each companion picks its own LLM. Local models the user has already downloaded (Ollama, LM Studio, llama.cpp server, Jan.ai, vLLM, anything with an OpenAI-compatible `/v1/models` endpoint) are first-class — no bundling model runtimes, no managing downloads.

## What changed

### Architecture: bring-your-own-model

CyberClaw becomes LLM-runtime-agnostic. The user is responsible for downloading and running their model; CyberClaw just points at the HTTP endpoint. This means:
- Zero model-maintenance burden on the CyberClaw side
- Any GGUF / transformer model works — GLM 5.2, Llama 4, Qwen, Mistral, Phi, whatever
- The user picks their model via their preferred runtime (Ollama for one-command `ollama pull`, LM Studio for a GUI, llama.cpp for raw GGUF control)

### New `~/.openclaw/cyberclaw/llm-endpoints.json`

A registry of user-managed OpenAI-compatible HTTP endpoints. Each entry:
```json
{
  "id": "ollama-local",
  "name": "Local Ollama",
  "baseUrl": "http://localhost:11434",
  "apiKey": "",
  "type": "ollama",
  "models": [{"id": "llama3.1:8b"}, {"id": "qwen2.5-coder:32b"}],
  "lastProbedAt": 1719334800000,
  "autoDetected": true
}
```

### New IPC handlers in `src/main.js`

- `llm:endpoints:list` — returns all configured endpoints
- `llm:endpoints:add({name, baseUrl, apiKey?})` — saves + probes `GET /v1/models` (falls back to Ollama's `/api/tags`)
- `llm:endpoints:delete(id)`
- `llm:endpoints:probe(id)` — re-probes a specific endpoint's model list
- `llm:endpoints:detect-ollama` — probes `http://localhost:11434` and adds it as "Local Ollama" if reachable
- `agent:set-model({agentId, model, fallbacks})` — patches `openclaw.json` directly (openclaw doesn't expose an `agents edit --model` subcommand)

Plus a startup hook in `app.whenReady()` that auto-probes Ollama and adds it if running. Silent on failure — doesn't block app startup.

### Updated `src/preload.js`

- `cyberclaw.llm.endpoints.{list,add,delete,probe,detectOllama}` — new namespace
- `cyberclaw.openclaw.setAgentModel(agentId, model, fallbacks)` — new method

### New Settings section: "🦙 Local LLM Endpoints"

In the Settings panel, right under "🧠 LLM Providers". Shows a card per endpoint with name, baseUrl, model count, last-probed timestamp, and a re-probe button. Add endpoint: name + baseUrl + optional API key + Test button + Save button. Plus a "🔍 Detect Ollama" button for one-click auto-config.

### Companion Forge model picker

`refreshForgeModelDropdowns()` now also iterates LLM endpoints and adds an `<optgroup>` per endpoint with one `<option>` per discovered model. Values are namespaced as `<endpointId>/<modelId>` so the runtime knows which endpoint to route to.

### Companion Forge save flow

`saveCompanion()` now calls `cyberclaw.openclaw.setAgentModel(editorAgentId, model, fallbacks)` after the local sprite config save. This is what actually wires the per-companion model through to the gateway. Without this, the picker was decorative — the agent kept using the global default.

### Wizard step 3: "LLM (Brain)" picker

The setup wizard's "Create Your First Companion" step now has a model picker right under the name input. Populated from the same well-known + custom providers + LLM endpoints list as the forge. On create, the selected model is passed via `wizard:create-agent` which now actually uses `--model <id>` on `openclaw agents add`.

### Updated `wizard:create-agent` IPC

Previously: ran `openclaw agents add --non-interactive` with no `--workspace` or `--model` flags, which the CLI silently rejected (needs `--workspace`). Pre-v3.1.33, this was a no-op that swallowed the error.

Now: passes the user-chosen `--workspace` and `--model`. On failure (agent already exists, etc.), falls back to patching `openclaw.json` directly so the user's model choice is applied even on retry.

## Files
- `src/main.js` — IPC handlers, auto-probe, fetchWithAbort, wizard:create-agent rewrite
- `src/preload.js` — new APIs exposed
- `src/index.html` — Local LLM Endpoints settings section
- `src/js/app.js` — renderLlmEndpoints + companion model picker + setAgentModel call on save
- `src/wizard.html` — model picker in step 3
- `src/js/wizard.js` — populateWizardModelPicker + model pass-through
- `package.json` — 3.1.32 → 3.1.33

## Lessons

- **"The picker saves the value" is not the same as "the runtime uses it".** Pre-v3.1.33, the forge model picker updated the local sprite config but never told OpenClaw. The picker felt like it worked but the gateway kept using the global default. Always trace a config write all the way to the consumer.
- **Auto-detect on startup is friendly but bounded.** The startup Ollama probe has a 4s timeout per call (`fetchWithAbort`). If Ollama isn't running, the probe fails silently and the app starts normally. If it is running, the user gets a ready-to-use endpoint without any setup. The right balance between "zero-config" and "don't make me wait".
- **OpenAI-compatible is the lingua franca for local model servers.** Ollama, LM Studio, llama.cpp server, vLLM, Jan.ai, LocalAI — all expose `/v1/models` and `/v1/chat/completions`. One probe path covers the whole ecosystem. We do special-case Ollama's `/api/tags` as a fallback because its `/v1/models` is sometimes empty until you pull a model, but the OpenAI path is the primary.
- **Namespacing model IDs by endpoint avoids the "which provider owns this model id?" problem.** `<endpointId>/<modelId>` (e.g. `ollama-local/llama3.1:8b`) is unambiguous. The runtime can route the request without consulting the registry.
- **openclaw's CLI has gaps.** `agents add --model X` works but `agents edit --model X` doesn't exist. Patching `openclaw.json` directly (with atomic write) is the right workaround — and since `openclaw.json` is symlinked into the user's workspace anyway, the change is naturally persistent and inspectable.