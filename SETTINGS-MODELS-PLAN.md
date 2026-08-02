# SETTINGS-MODELS-PLAN — Settings & model-picker redesign

**Status:** Active plan. **P1–P5 landed**; P6–P8 outstanding. Supersedes nothing; the retired `PROVIDERS-PLAN.md` shipped what exists today.
**Owner decisions still open:** listed in §10.

---

## 0. Why this exists

The Settings page and the `WorkerPicker` were built to prove a mechanism — multi-provider
resolution (retired `PROVIDERS-PLAN.md` §1–§5) — and they show it. They are a correct model
of the *system*, and a poor model of the *user's job*.

What a real user is actually doing when they open this page:

| Their job | What the app offers today |
|---|---|
| "Connect the provider I pay for." | Seven flat cards in a fixed order, no notion of which ones matter to me. |
| "Which models can I use, and what do they cost?" | A free-text search box and a `<datalist>`. Cost appears nowhere in the app. |
| "Use the three models I actually like." | `activeModels`, a flat unordered list of raw ids with a checkbox each. |
| "Did Anthropic ship something new?" | Nothing. `CURATED_MODELS` changes only when the repo does, silently. |
| "Will this provider train on my code?" | Nothing. |
| "Am I burning my Claude plan or my API key?" | One warning paragraph inside a collapsed card. |
| "Pick a model for this node." | A `<select>` of bare ids, plus two mock ids permanently mixed in. |

And the mock provider — a development affordance — is a first-class citizen in every one of
those surfaces, sitting in `PROVIDER_ORDER`, in `activeModels`, and hardcoded into
`WorkerPicker` as `MOCK_MODELS`.

### Goals (from the request)

- **G1.** Easy provider picking; models listed, not typed.
- **G2.** Categorisation of models.
- **G3.** Favouriting.
- **G4.** **NEW** badges on models that weren't there last time the app was opened.
- **G5.** Good visual representation of per-token cost.
- **G6.** Training rules ("will they train on this?") surfaced per model.
- **G7.** Claude/ChatGPT subscription models are governed by the *user's* provider account
  settings, not by Flyt — communicate that honestly rather than guessing.
- **G8.** Mock moves into its own hidden section below Advanced, and gains a
  user-entered custom response.

### Non-goals

- Cost *tracking* / spend accounting. `GOALS.md` lists it as an explicit non-goal. This plan
  shows **published prices**, never a running total.
- A global command palette. D26 rejects that. The new picker is a **scoped combobox** on one
  field — different thing, and the plan must not let it grow into the rejected one.
- Live per-provider model-endpoint polling (see §2, decision on metadata source).

### Constraints inherited

- **D26 anti-ideas:** no large-area `backdrop-filter`, no mesh gradients, no 3D tilt, no
  skeleton shimmer. Cost bars render instantly from local data — there is nothing to shimmer.
  Modern CSS *is* allowed (`oklch`, `light-dark()`, `field-sizing`, anchor positioning).
- **D28:** the catalog is immutable bundled data → `projectRoot`. User state (favourites,
  seen-model map, mock scripts) is mutable → `settings.json` under `dataRoot`.
- **D24:** zero new dependencies.
- **Principle 1 (file-based state):** the catalog is a plain, diffable, hand-editable file.
- **Security invariant:** the renderer never sees a key. Unchanged — nothing here needs one.

---

## 1. Current state, precisely

Read these before touching anything:

- `src/Settings.jsx` (768 lines) — the whole page: `ProvidersTab`, `ModelsTab`, `SafetyTab`,
  `SubscriptionCard`, `JudgeModelSection`, `FlowFilesSection`. Duplicates `SERVE` /
  `PROVIDER_ORDER` / `MOCK_MODELS` from core, by design (presentational mirror).
- `src/Inspector.jsx` L167–233 — `WorkerPicker`, used at five call sites (L345, L361, L427,
  L557, L616, L780, L954) plus `src/ConfigModal.jsx`.
- `core/modelSource.js` — `CURATED_MODELS`, `TEST_MODELS`, `migrateSettings`,
  `createResolver`, `resolveCallTarget`. The catalog today is 16 entries of
  `{ id, name, supportsTools }`.
- `electron/main.js` — `publicSettings()` (~L273–330), the `settings:set` handler
  (~L960–1030), `models:list` (~L1035+).
- `core/adapters/mock.js` — role-keyed canned responses, `mockAdapter.canServe`.
- `src/styles.css` — `.settings-*`, `.provider-card*`, `.model-row`, `.priority-chip`,
  `.worker-picker`.

### The three structural problems

1. **There is no model *record*.** A model is a bare string id everywhere. Every attribute a
   user cares about (price, context, tier, training policy, release date) has nowhere to live.
   Everything else in this plan is blocked on fixing that first.
2. **`activeModels` conflates three ideas** — *installed* (I know about it), *enabled* (offer
   it in pickers), and *pinned source* (route it here). Favouriting is a fourth. The list needs
   to become derived-from-catalog plus a small user-state overlay, not a hand-maintained array.
3. **Mock is structurally load-bearing.** `WorkerPicker` falls back to
   `{ provider: 'mock', model: 'mock-large' }` when a worker is unset, and `MOCK_MODELS` is
   appended to every picker. Hiding mock is not a CSS change; it needs a real default-worker
   fallback and a mock-enabled gate.

---

## 2. Data layer — the model catalog

**Decision: bundled catalog + OpenRouter live merge.** A curated file ships with the app and
covers anthropic / openai / kimi / claude-code / codex; the existing OpenRouter `/models`
fetch is merged on top of it for OpenRouter ids (it already returns `pricing`, which the
current code discards). Rationale: provider model endpoints are inconsistent (that is why
`CURATED_MODELS` exists), the file works offline and with no key, and it is diffable — which
is also what makes the NEW badge work for bundled providers.

### New files

```
core/modelCatalog.js     — the catalog, as a JS module (not JSON: keeps ESM import
                           assertions and bundler config out of it, stays commentable)
core/modelCatalog.test.js → tests/modelCatalog.test.js
```

`core/modelSource.js` keeps `createResolver` / `resolveCallTarget` / `migrateSettings`.
`CURATED_MODELS` is **derived** from the catalog (`byProvider(id)`) so `models:list` and every
existing caller keep working unchanged during the transition.

### Record shape

```js
{
  id: 'claude-sonnet-5',
  name: 'Claude Sonnet 5',
  providers: ['anthropic', 'claude-code'],   // who can serve it
  family: 'Claude',
  tier: 'frontier',        // 'frontier' | 'balanced' | 'fast' | 'reasoning' | 'legacy'
  releasedAt: '2026-02-24',
  contextLength: 200_000,
  maxOutput: 64_000,
  price: {                 // USD per 1M tokens, null = not published
    input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75
  },
  caps: { tools: true, vision: true, reasoning: true, streaming: true },
  training: {
    policy: 'no-train',    // see the enum below
    scope: 'api',          // 'api' | 'subscription' | 'aggregator'
    note: 'API inputs and outputs are not used to train models.',
    source: 'https://…'    // the page the claim came from; shown as "source" link
  },
  deprecated: false,
  aliasOf: null            // e.g. 'claude-sonnet-5-20260224' → 'claude-sonnet-5'
}
```

### The `training.policy` enum — five values, no more

| Value | Pill | Meaning |
|---|---|---|
| `no-train` | green "not trained on" | Provider states inputs/outputs are not used for training. |
| `opt-out-default` | amber "off by default" | Not trained on unless you opt in, per account setting. |
| `opt-in-default` | amber "on by default" | Trained on unless you opt out, per account setting. |
| `account-governed` | blue "your account decides" | **The subscription case (G7).** Flyt cannot read it. |
| `unknown` | grey "unknown" | Aggregator route, or unverified. Never guess. |

`account-governed` is the honest answer for `claude-code` and `codex`, and for OpenRouter
routes where the upstream provider is chosen per request. The pill's tooltip says so in one
sentence and links to the provider's own privacy/settings page. **Rule: the app never asserts
a training policy it cannot cite.** Every non-`unknown` entry carries a `source` URL, and
`tests/modelCatalog.test.js` enforces that.

### Subscription pricing

Subscription entries carry `price: { kind: 'plan', plan: 'Claude Pro / Max' }` instead of
per-token numbers. The cost column renders **"your plan's limits"**, not "$0" — the current
copy's real point (a multi-node run burns your 5-hour window) is a cost signal and belongs
in the same visual slot as dollars, not buried in a collapsed card.

### OpenRouter merge

`models:list('openrouter')` already fetches `context_length` and `supported_parameters`. Extend
the mapper to read `pricing.prompt` / `pricing.completion` (OpenRouter reports USD **per
token**; multiply by 1e6) and `m.created` (unix seconds → `releasedAt`). Merge rule: bundled
record wins on `name`/`tier`/`training`; live wins on `price`/`contextLength`. Cache the merged
result in `settings.modelCatalogCache.openrouter = { fetchedAt, models }` so the NEW diff and
the cost bars survive a restart without a key round-trip.

### Catalog maintenance

Add `npm run catalog -- check` (`scripts/catalog-check.mjs`): fetches OpenRouter, diffs against
the bundled file, and prints ids/prices that drifted. A maintenance aid for whoever bumps the
file — **not** run at app start.

---

## 3. Settings state additions

In `settings.json` (all migrated in `migrateSettings`, all defaulted, none required):

```js
favouriteModels: ['claude-sonnet-5', 'gpt-5.2'],   // ordered; the user's shortlist
seenModels: { 'claude-sonnet-5': '2026-07-01T…' }, // id → first time this install saw it
modelGrouping: 'provider',                          // 'provider' | 'tier' | 'cost'
showAllModels: false,                               // false = enabled-only in the Models tab
mock: {
  enabled: false,          // gates mock out of every picker (G8)
  mode: 'roles',           // 'roles' | 'custom' | 'echo' | 'error'
  customResponse: '',      // used when mode === 'custom'
  perRole: {},             // optional role → text overrides, beats customResponse
  latencyMs: 700,
  streaming: true,
  failureRate: 0           // 0–1, injects adapter errors for testing retry/gate paths
}
```

`activeModels` **stays** — it is the routing registry and `resolveCallTarget` depends on it.
What changes is that the UI no longer makes the user curate it by hand: enabling a model in
the redesigned tab writes the entry, favouriting writes `favouriteModels`, and a model with no
entry is simply not enabled. No migration of existing `activeModels` is needed.

`publicSettings()` gains: `catalog` (merged, already filtered to providers the install knows
about), `favouriteModels`, `newModelIds` (computed main-side — see §4), `mock`, `modelGrouping`.

**`seenModels` bookkeeping (G4).** Computed in the main process, never the renderer:

- On `settings:get`, diff every catalog id against `seenModels`.
- An id absent from `seenModels` **and** where `seenModels` is non-empty → it is NEW.
- First run ever (`seenModels` empty) → stamp everything, badge nothing. A fresh install
  where all 40 models glow NEW is noise, not information.
- The badge clears when the user **expands the group containing it** (explicit
  `settings:markSeen(ids)` call), and independently expires after 21 days.
- New OpenRouter models are stamped on catalog fetch, so an OpenRouter refresh legitimately
  surfaces "3 new" — which is exactly the provider-released-a-model case G4 is about.

---

## 4. UI — Settings page

### Tab structure

```
Providers  |  Models  |  Safety  |  Advanced
```

`Advanced` is new. It absorbs, in this order:

1. **Project storage** (moved off Providers — it is not a provider concern).
2. **Flow files** (moved off Providers).
3. **Provider priority** (moved off Models — it is a routing-mechanics control, and the
   redesigned Models tab makes it near-irrelevant for anyone who pins a source).
4. **Developer** — a collapsed `<details>`, closed by default, containing the entire mock
   provider section (§6). This is the "hidden section below advanced" from the request.

### Providers tab (G1)

Restructure from seven equal cards into **two bands**:

- **Your providers** — anything connected, sorted by connection. Each card shows a live
  one-line summary: `Anthropic · connected · 3 models enabled · $3.00–$15.00 /Mtok range`.
- **Available** — the rest, each a single row with a "Connect" button that expands the card.
  Mock is **not here at all** any more; it lives in Advanced → Developer.

Pair the API-key card with its subscription sibling visually — Anthropic + Claude
subscription in one bordered group, OpenAI + ChatGPT subscription in another — because that
pairing *is* the decision the user is making ("pay per token, or spend my plan?"). Today
those sit as two of seven flat siblings and the relationship is only explained in prose.

Each subscription card gets a persistent **billing pill** in its header —
`spends your Claude plan` — rather than only the warning paragraph inside the expanded body,
and the same pill appears on every model that resolves through it (G7).

### Models tab — the core redesign (G2–G6)

Layout, top to bottom:

```
┌────────────────────────────────────────────────────────────────┐
│ [search…]        Group: (Provider) (Tier) (Cost)   [ ] show all │  ← toolbar, sticky
├────────────────────────────────────────────────────────────────┤
│ ★ Favourites                                              (3)  │  ← always first
│   ▸ model rows                                                 │
├────────────────────────────────────────────────────────────────┤
│ ▾ Anthropic          connected · 3 enabled · 1 NEW             │  ← group header
│   ▸ model rows                                                 │
│ ▸ OpenAI             connected · 2 enabled                     │
│ ▸ OpenRouter         connected · 312 in catalog   [Refresh]    │
│ ▸ Kimi               no key                                    │
├────────────────────────────────────────────────────────────────┤
│ Default worker  · Safety model · Judge model                   │  ← the three role pickers,
└────────────────────────────────────────────────────────────────┘     one section, using §5
```

**Model row** — one line, scannable left to right, nothing hidden behind a hover:

```
★  Claude Sonnet 5              NEW   ▓▓▓▓░░░░  $3 / $15    not trained on   200k  ⚒ 👁   [toggle]  [source ▾]
│  │                            │     │         │            │                │     │      │         │
│  └ name (id in a muted mono   │     │         └ exact      └ training pill  │     │      └ enabled └ auto/pinned
│    subline, copyable)         │     └ cost bar   in/out                     │     └ caps
└ favourite (G3)                └ new badge (G4)                              └ context
```

**Grouping (G2)** is a three-way toggle, not a fixed hierarchy, because the three groupings
answer three different questions:

- **Provider** (default) — "what do I get from the thing I pay for?"
- **Tier** — Frontier / Balanced / Fast & cheap / Reasoning / Legacy. Answers "what should I
  put on this node?" A cheap model on a `documentation` node is the single highest-leverage
  configuration a user can make, and today nothing in the UI suggests it.
- **Cost** — ascending blended price. Answers "what's the cheapest thing that can do this?"

**Cost visualisation (G5).** A horizontal bar per row, **log-scaled** across the catalog's
observed price range, because the range is ~1000× (sub-cent to $75/Mtok) and a linear bar
would render every non-frontier model as a nub. The bar's value is a **blended** price at a
3:1 input:output ratio — the realistic agent-workload ratio — with the exact `$in / $out`
printed beside it. Four tint stops keyed to order-of-magnitude, using existing theme tokens
(no new palette): `$` under 1, `$$` 1–5, `$$$` 5–20, `$$$$` above 20. Subscription models
render a distinct striped bar labelled "plan", never a dollar figure. Unknown price renders
an empty track with "—", never a zero-width bar that reads as "free".

Group headers carry a **range summary** (`$0.25–$15 /Mtok`) so a collapsed provider still
answers the cost question.

**Enabled vs. everything.** Default view is enabled models plus favourites; `show all` reveals
the full catalog per group. This replaces "Add a model" as a separate section — adding a model
is now just toggling it on where you found it. Keep a free-text **"Add a model by id"** escape
hatch at the bottom of the tab for ids the catalog doesn't know (self-hosted, brand-new,
OpenRouter routes) — that path must never regress; it is the only thing that works on day zero
of a model launch.

### Safety tab

Unchanged in substance. The two model `<select>`s are swapped for the §5 picker, which gives
them cost bars for free — and "pick a cheap model for this" is precisely the advice the
existing hint text already gives in prose.

---

## 5. The shared model picker

New file `src/ModelPicker.jsx`, exporting `<ModelPicker value onChange role />`. Replaces
`WorkerPicker` (which becomes a thin wrapper, then is deleted) and the four bare `<select>`s
in Settings.

A **combobox popover**, not a `<select>`:

- Type-to-filter across id, name and family.
- Sections: **Favourites**, then the current grouping, then **Other** (enabled-but-unfavourited).
- Each option is the compact form of the model row: name, cost tint, training glyph, caps.
- Footer: **"Any model id…"** free-text, plus — **only when `mock.enabled`** — a mock section.
- Anchored with CSS anchor positioning (allowed by D26), keyboard-complete
  (↑/↓/Enter/Esc/Home/End), `role="combobox"` + `aria-activedescendant`.

**Not a command palette.** D26 rejects the global palette; this is a field-scoped combobox
bound to one setting. Guardrail for future work: it must not gain non-model commands, and it
must not be reachable by a global shortcut.

**Default-worker fallback (unblocks G8).** `WorkerPicker` currently defaults an unset worker to
`{ provider: 'mock', model: 'mock-large' }`. Change to: unset → **inherit** (render
`app default (claude-sonnet-5)` from `settings.workers.executor`), and only fall back to mock
if no active model exists at all *and* mock is enabled. Inheritance is the honest description
of what the runner already does; the mock default was always a lie about resolution.

---

## 6. Mock provider (G8)

### Placement

`Advanced ▸ Developer ▸ Mock provider` — a `<details>` closed by default. Removed from
`PROVIDER_ORDER` in `Settings.jsx`, from the Providers tab, and from every picker unless
`settings.mock.enabled`.

`core/adapters/mock.js` stays registered in the adapter registry regardless — the tests use it
directly, and `canServe` already fences it to `mock-*` ids so it can never capture a real call.

### Custom response

The section contains:

- **Enable mock provider** — the master gate.
- **Response mode** — radio:
  - `roles` — today's behaviour: canned per-role output (default, keeps every existing test green).
  - `custom` — **a textarea; whatever you type is returned verbatim for every call.** This is
    the requested feature. Monospace, `field-sizing: content`, with a hint that a fenced
    ```` ```tool ```` block will exercise the agent tool loop and a fenced ```` ```json ````
    block will satisfy evaluator nodes.
  - `echo` — returns the prompt it received. The fastest way to inspect assembled context,
    which is otherwise only visible by digging in `runs/`.
  - `error` — always throws, for exercising retry and failure UI.
- **Per-role overrides** — an optional list of `role → text` rows, beating `customResponse`
  for that role. Lets one mock run drive a whole multi-node flow with distinct outputs.
- **Latency** (ms) and **stream output** — the existing simulated latency/streaming, now
  adjustable. Latency 0 is how you test that the canvas doesn't flicker on instant nodes.
- **Failure rate** (0–1) — inject adapter errors.

### Wiring

`mockAdapter` takes its config from the runtime config the same way keys do:
`rebuildRuntimeConfig()` puts `settings.mock` on `runtimeConfig.mock`, adapters receive it in
their call options, and `mock.js` branches on `mode` before the existing role table. The role
table stays as the `roles` branch — deleting it would break `tests/flowRunner.test.js` and the
zero-key end-to-end story `GOALS.md` Quick Start promises.

---

## 7. Phases

Each phase ends green (`npm test`) and is independently shippable.

| # | Phase | Touches | Done when |
|---|---|---|---|
| **P1** | **Catalog data layer.** `core/modelCatalog.js` with the full record shape; `CURATED_MODELS` derived from it; OpenRouter mapper reads pricing + `created`; `scripts/catalog-check.mjs`. | `core/modelCatalog.js`, `core/modelSource.js`, `electron/main.js`, `tests/` | `tests/modelCatalog.test.js` passes: every record validates, every non-`unknown` training policy has a `source`, no duplicate ids, every `providers[]` entry is a known provider, every id is servable by at least one of its providers per `SERVE`. Existing `modelSource.test.js` unchanged and green. |
| **P2** | **Settings state.** `favouriteModels`, `seenModels`, `modelGrouping`, `mock` in `migrateSettings` + `settings:set` + `publicSettings()`; `settings:markSeen` IPC; NEW computation main-side. | `core/modelSource.js`, `electron/main.js`, `electron/preload.cjs` | Round-trip tests: unknown keys dropped, defaults applied, first-run stamps-all-badges-none, second-run-with-new-catalog-entry badges exactly that entry. |
| **P3** | **Settings shell + Advanced tab + mock move.** Fourth tab; Project storage / Flow files / Provider priority relocated; Developer `<details>` with the full mock section; mock gated out of pickers. | `src/Settings.jsx`, `src/Inspector.jsx`, `src/styles.css` | Mock appears in exactly one place in the UI. With `mock.enabled: false` and no keys, the app still explains what to do next rather than silently offering nothing. |
| **P4** | **Mock authoring + adapter wiring.** Modes, custom textarea, per-role rows, latency, streaming, failure rate → `runtimeConfig.mock` → `mock.js`. | `src/Settings.jsx`, `electron/main.js`, `core/adapters/mock.js`, `tests/` | A run with `mode: 'custom'` returns the typed text at every node; `roles` mode is byte-identical to today (existing tests are the proof). |
| **P5** | **Providers tab restructure.** Two bands, paired API/subscription groups, billing pill, per-card summary line. | `src/Settings.jsx`, `src/styles.css` | Connected providers are above the fold; the pay-per-token vs. plan choice is legible without expanding a card. |
| **P6** | **Models tab redesign.** Toolbar, grouping toggle, groups, model rows, favourites, NEW badges, cost bars, training pills, free-text escape hatch. | `src/Settings.jsx` → split out `src/ModelsTab.jsx`, `src/ModelRow.jsx`, `src/CostBar.jsx`; `src/styles.css` | All of G2–G6 visible on one screen; 300+ OpenRouter models render without jank (§8). |
| **P7** | **Shared `ModelPicker`.** New component; all `WorkerPicker` call sites migrated; `WorkerPicker` deleted; Safety/Judge/Default-worker selects migrated; unset-worker fallback fixed. | `src/ModelPicker.jsx`, `src/Inspector.jsx`, `src/ConfigModal.jsx`, `src/Settings.jsx` | Grep for `MOCK_MODELS` returns `core/` and the mock section only. Every model choice in the app goes through one component. |
| **P8** | **Verification.** §8. | — | §8 checklist complete. |

P1→P2 are strictly sequential. P3/P4 (mock) and P5/P6 (visual) are independent after P2 and
can be reordered by taste. P7 depends on P6's row rendering.

---

## 8. Verification

- **Unit:** `tests/modelCatalog.test.js` (record validity, training-source rule, alias
  resolution, provider/serve consistency), `tests/modelSource.test.js` extended for the new
  settings keys, NEW-badge diff logic tested as a pure function (not through the UI).
- **Cost maths:** a test asserting blended-price ordering and log-scale bar widths against
  hand-computed values, including the null-price and subscription cases. Cost is the claim in
  this plan most likely to be quietly wrong.
- **Regression:** `npm test` green throughout; `tests/brand.test.js` still passes (new files
  must use `core/brand.js`, not literals); zero-key end-to-end mock run still works.
- **Performance (`GOALS.md` NFR):** render the Models tab with the full OpenRouter catalog
  (~300 models) expanded and confirm the tab stays interactive. If it doesn't, groups render
  collapsed-by-default with `content-visibility: auto` before reaching for virtualisation.
- **Accessibility:** run `design:accessibility-review` over the new tab and picker. Specific
  risks: the cost bar must not be the *only* carrier of the price (the number is printed
  beside it), the training pill must not be colour-only (text label, always), NEW must not be
  colour-only (the word "NEW"), and the combobox needs the full ARIA pattern.
- **Honesty audit:** every `training.policy` in the shipped catalog gets its `source` URL
  opened and read. A wrong claim here is worse than no claim — this is the one item that
  cannot be automated away.

---

## 9. Documentation to update on landing

- **`DECISIONS.md` — D32** (draft in §11 below; the 2026-07-25 doc pass took D30, D31 and D33, leaving D32 reserved for this plan). This is where the *why* lives; per
  `CLAUDE.md`, this plan file is retired to git history once implemented.
- **`CLAUDE.md`** — add to "Active work" now; remove on completion.
- **`DESIGN-SPEC.md` §11** — built-vs-planned ledger entries for the catalog and picker.
- **`GOALS.md`** — the non-goals list says "cost tracking"; add a clarifying half-sentence that
  *displaying published prices* is in scope while *tracking spend* remains out.
- **`SUBSCRIPTION-AUTH-GUIDE.md`** — cross-reference the `account-governed` training policy.

---

## 10. Open questions for the owner

- **Q1.** Should `tier` be catalog-assigned (curated, opinionated) or derived from price +
  context? Curated is better copy and worse maintenance. The plan assumes **curated**, with a
  price-derived fallback for unknown OpenRouter ids.
- **Q2.** Does favouriting imply enabling? Simplest rule: **yes — favouriting enables**, and
  un-favouriting leaves it enabled. Two toggles that can disagree is a state users lose track of.
- **Q3.** Should the blended-cost ratio (3:1) be user-adjustable? The plan says no — a fixed,
  documented assumption printed next to the legend beats a slider nobody moves.
- **Q4.** Should Provider priority stay user-facing at all once source-pinning is one click on
  every row? The plan relocates it to Advanced rather than removing it; removal is a follow-up
  once telemetry-free judgement says it's dead weight.

---

## 11. Draft `DECISIONS.md` entry

> ### D32 — Models are catalog records, not strings; mock is a developer tool
>
> **Context.** Settings and `WorkerPicker` modelled a model as a bare id, which left price,
> context, tier, release date and training policy with nowhere to live — so the app could not
> answer the three questions users actually open Settings with ("what does this cost?", "will
> they train on my code?", "is there anything new?"). Mock, a development affordance, sat in
> `PROVIDER_ORDER` and in every picker.
>
> **Decision.** A model is a record in a bundled, hand-editable catalog (`core/modelCatalog.js`),
> merged with OpenRouter's live pricing. User state over the catalog — favourites, seen-model
> map for NEW badges, grouping — lives in `settings.json`; `activeModels` remains the routing
> registry but stops being hand-curated. Cost is **displayed, never tracked** (spend accounting
> stays a `GOALS.md` non-goal). Training policy uses a five-value enum in which
> `account-governed` is the correct, honest answer for subscription providers — Flyt cannot
> read the user's Anthropic/OpenAI account settings and will not pretend to; every other
> non-`unknown` value carries a citable source URL, enforced by test. Mock moves to
> Advanced ▸ Developer behind an explicit enable gate and gains user-authored responses; the
> unset-worker fallback becomes *inherit the default worker* rather than *mock-large*.
> One `<ModelPicker>` combobox serves every model choice in the app — field-scoped, which is
> not the global command palette D26 rejects.
>
> **Status.** Decided; implementation per `SETTINGS-MODELS-PLAN.md`.
