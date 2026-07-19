# PROVIDERS-PLAN — multi-provider auth, model activation, and the Settings page

Phase goal: let the user connect Anthropic, OpenAI, and Kimi alongside the
existing OpenRouter + mock providers, activate the models they actually use,
and control which source serves a model that is reachable through more than
one provider — all from a settings page that reads as an overview, not a wall
of fields.

## 0. Feasibility — what is allowed (verified July 2026)

| Requested option | Verdict | Why |
|---|---|---|
| Claude — API key | ✅ build | Adapter already exists (`core/adapters/anthropic.js`). |
| Claude — subscription login (OAuth) | ❌ drop | Anthropic bans consumer-plan OAuth tokens in any third-party tool (ToS, enforced Apr 2026). Claude Code / claude.ai only. |
| GPT — API key | ✅ build | Standard OpenAI API, OpenAI-compatible chat completions. |
| GPT — ChatGPT login | ❌ drop | "Sign in with ChatGPT" is identity-only; subscription quota cannot pay for third-party model calls. Workarounds are reverse-engineered Codex auth — ToS-risky, not built. |
| Kimi — API key | ✅ build | platform.kimi.ai, OpenAI-compatible endpoint. |
| Kimi — subscription | ✅ build | Officially supported: a Kimi membership's "Kimi Code" benefit issues an API key valid in third-party tools (model id `kimi-for-coding`, OpenAI- and Anthropic-protocol compatible). Subscription-backed, but mechanically still a key — no OAuth flow needed. |

Net provider list: **mock, anthropic, openai, kimi (two key kinds), openrouter**.
The dropped OAuth options are represented in the UI as a short disabled note
("Subscription login isn't permitted by Anthropic/OpenAI — use an API key"),
so the user learns why rather than wondering where the button went.

## 1. Data model (settings.json, userData — never the repo)

Generalize the single `openrouterApiKey` into a providers map:

```json
{
  "providers": {
    "anthropic":  { "apiKey": "…" },
    "openai":     { "apiKey": "…" },
    "kimi":       { "apiKey": "…", "keyKind": "platform" },
    "openrouter": { "apiKey": "…" }
  },
  "providerPriority": ["anthropic", "openai", "kimi", "openrouter", "mock"],
  "activeModels": [
    { "id": "claude-sonnet-5", "source": "auto" },
    { "id": "gpt-5.2",         "source": "auto" },
    { "id": "kimi-for-coding", "source": "kimi" }
  ],
  "workers": { "executor": { "provider": "anthropic", "model": "claude-sonnet-5" } }
}
```

- `keyKind` for Kimi: `"platform"` (pay-as-you-go, platform.kimi.ai) or
  `"code"` (subscription Kimi-Code key). Same adapter, different base URL +
  allowed models; the UI labels them differently so the user knows which
  budget is being spent.
- `activeModels` is the curated list the rest of the app sees. Everything else
  (node templates, worker pickers, category routing) offers ONLY active
  models — this is the anti-overwhelm mechanism: thousands of OpenRouter
  models exist, the pickers show the five you chose.
- `source: "auto"` = resolve via `providerPriority` at call time among
  *connected* providers that can serve that model. A concrete source pins it.
- Migration: on load, if legacy `openrouterApiKey` exists, move it into
  `providers.openrouter.apiKey` once and delete the old field.

## 2. Resolution rule (one paragraph, one function)

`resolveModelSource(modelId)` in the main process: if the model entry pins a
source and that provider has a key, use it; otherwise walk `providerPriority`,
skip providers with no key, skip providers that can't serve the id (each
adapter exports `canServe(modelId)` — anthropic: `claude-*`; openai: `gpt-*`,
`o*`; kimi: `kimi-*`; openrouter: anything with a `/` or listed in its fetched
catalog), and take the first hit. No match → the run fails fast with a
settings-pointing error, same style as today's missing-key errors. The
resolved `{provider, model, apiKey}` is what gets stamped onto the worker
object — `callModel` and the retry machinery are untouched.

## 3. Adapters (core/adapters/)

- `openai.js` — clone of `openrouter.js` pointed at
  `https://api.openai.com/v1/chat/completions` (same OpenAI-compatible shape:
  messages/tools, streaming with `stream_options.include_usage`, sseEvents,
  apiError). Factor the shared body into `openaiCompatible(baseUrl, headers)`
  in `http.js` rather than copy-pasting — openrouter, openai, and kimi are the
  same adapter with different URLs and auth headers.
- `kimi.js` — the same factory; base URL switches on `keyKind`
  (platform endpoint vs Kimi-Code endpoint per their docs; model
  `kimi-for-coding` only valid on the code endpoint).
- `anthropic.js` — already done; add `canServe`.
- Register all in `index.js`. Mock unchanged.

## 4. Main process (electron/main.js)

- `refreshRuntime()`: inject `apiKey` from `settings.providers[w.provider]`
  instead of the openrouter-only special case; run every worker through
  `resolveModelSource` when its model's source is `auto`.
- `settings:get` returns per-provider `hasKey` flags (never keys),
  `providerPriority`, `activeModels`, and a small connected/model-count
  summary for the overview UI.
- `settings:set` accepts `{ providerKeys: { anthropic: "…" } }` (one-way, like
  today), `providerPriority`, `activeModels`, `workers`.
- New `provider:test` IPC: fire a 1-token call through the adapter and return
  ok/error — powers the "Test" button so a bad key is caught in Settings, not
  three nodes into a run.
- `models:list` becomes per-provider: openrouter keeps its live catalog fetch;
  anthropic/openai/kimi return short curated static lists (their APIs' model
  endpoints are inconsistent; a hardcoded list of current ids + a free-text
  field covers it and avoids another failure mode).

## 5. Settings page (src/Settings.jsx + styles)

Grows from a modal into a two-tab page (keep the overlay shell; add a slim
tab rail like TabStrip): **Providers** and **Models**. Project storage stays
as a small section under Providers.

Overview-first design rules:
- The Providers tab is a stack of five compact provider cards. Collapsed card
  = one line: name, status pill (`connected` / `no key` / `disabled by
  provider` for the OAuth notes), and model count. That's the whole overview —
  five lines, readable in two seconds.
- Expanding a card reveals: masked key input + Save (existing one-way
  pattern), Test button with inline ok/error, and for Kimi a two-option
  key-kind toggle ("Platform key — pay per token" / "Kimi Code key — uses your
  Kimi membership"). Anthropic and OpenAI cards carry the one-line disabled
  subscription note. Only one card expanded at a time.
- The Models tab has two zones:
  - **Active models** (top): the curated list. Each row: model id, activation
    toggle, and a source select — `Auto (priority)` plus each connected
    provider that can serve it. A row whose every source is disconnected gets
    a warning pill instead of silently failing later.
  - **Add a model** (bottom): search box backed by the per-provider catalogs
    (openrouter fetch + curated lists), reusing today's datalist. Picking one
    appends an active row. Default source: auto.
- **Provider priority**: a single horizontal ordered chip row at the top of
  the Models tab ("When a model is available from several sources, the first
  connected one wins"), reorder via drag or ◀ ▶ buttons on each chip. One
  global ordering + per-model pin override covers every case the user
  described (e.g. GPT via API vs OpenRouter) without a per-model matrix.
- Default worker section: unchanged behavior, but its model picker now lists
  only active models — which is the payoff of the curation.

## 6. Tasks (ordered, each independently shippable)

1. settings.json migration + providers map + per-provider hasKey over IPC.
2. `openaiCompatible` factory in http.js; port openrouter.js onto it (no
   behavior change — regression-test streaming + tools against the live API).
3. `openai.js` + `kimi.js` adapters + `canServe` on all adapters + registry.
4. `resolveModelSource` + priority + activeModels in main; workers resolved
   through it; `provider:test` IPC.
5. Settings UI: tab rail + provider cards (keys, test, Kimi key-kind).
6. Settings UI: Models tab — active list, toggles, source select, priority
   chips, add-model search.
7. Wire active-model filtering into the worker picker (and node
   template/category pickers when they grow model fields).
8. Verification pass: `npm test` for resolution-rule unit tests
   (priority walk, pin, disconnected skip, no-match error); manual smoke of
   each provider with a real key; migration test on a legacy settings.json.

## 7. Out of scope (deliberately)

- Any OAuth/device-code flow for Anthropic or OpenAI (ToS).
- Per-category priority matrices — global priority + per-model pin is enough
  until proven otherwise.
- Local models (ollama/llamacpp) — the factory in task 2 makes them a
  one-file add later.
