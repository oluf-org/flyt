# PIVOT-PLAN.md — from "do everything with LLMs" to "see what the LLMs are doing"

**Status:** **Partially implemented, 2026-08-02.** P1–P6, P8 and P10 are landed
and tested; **P7 (the builder), P9 (sweeps) and P11 (verification) remain.**
D35 is written into `DECISIONS.md` already — this file stays until P11 closes,
because the verification checklist in §9 is the thing that says the pivot is
actually done. Defined 2026-08-02 via a structured interview with the owner (Olav).
**Read alongside:** `GOALS.md`, `PRODUCT-SPEC.md`, `DESIGN-SPEC.md` §11, `DECISIONS.md`.
**Lands as:** draft **D35** in §12 of this file; moves to `DECISIONS.md` when P11 closes.

> **Standing-rules note.** `CLAUDE.md` says two plans are active and nothing else is a
> plan. This file makes it three, briefly, and then makes it one:
> - `TOOLS-PLAN.md` — **paused** after P5's declarative HTTP tools. P6–P10 (MCP client,
>   tool clerk, Flyt-as-MCP-server, code mode, Tools page) are shelved and re-evaluated
>   once P4 of this plan ships. Nothing in it is cancelled.
> - `SETTINGS-MODELS-PLAN.md` — **absorbed**. Its outstanding P6 (Models tab) and P7
>   (shared `ModelPicker`) are prerequisites for this plan's P7 and are folded in there;
>   the standalone document retires when they land.

---

## 1. The pivot in one sentence

**Before:** *An easy-to-use desktop app for AI workflows — pick a workflow, type what you
want, and watch it execute.*

**After:**

> **An instrument for LLM work: build the pipeline yourself, then see exactly what every
> model call cost, sent, and returned — down to the wire.**

The canvas survives. The engine survives. What changes is where the value sits. Today
Flyt's pitch is *capability* — it does things with LLMs. After the pivot the pitch is
*legibility and control* — it is the only place you can watch an LLM pipeline run and
interrogate it afterwards, and every part of the pipeline is something you built.

The old thesis in `PRODUCT-SPEC.md` §1 — *decomposition and routing may matter more than
raw model strength* — is not abandoned. It is finally **testable**, because the pivot
builds the measurement apparatus that thesis always needed and never had.

### What the pivot is not

It is not a retreat from building things. Positioning stays **both**: Flyt is still aimed
at replacing a chat box for building software (`PRODUCT-SPEC.md` §3), and the V1 coding
loop stays green. The investigator is the layer that makes the builder trustworthy, not a
replacement for it. This is the plan's single largest risk — see §11.

---

## 2. Decisions locked in the interview

| # | Question | Decision |
|---|---|---|
| 1 | Whose calls does Flyt observe? | **Flyt's own runs only.** No proxy, no OTel import. The graph is the only way to produce data — you must build the flow to investigate it. |
| 2 | Do prompts move into the graph? | **Hybrid.** The prompt is a real, user-owned field on the node. A model can *draft* into it; nothing is generated invisibly at runtime. |
| 3 | Floor beneath "no default nodes" | **A tiny hidden kernel.** 2–3 system nodes used only by the builder flow, absent from the palette. The user's library ships genuinely empty. |
| 4 | The existing 10 templates + 5 flows | **Presets.** Removed from the library; offered as starting options inside *Create node* / *Create flow*. |
| 5 | Zoom depth on one call | **Full wire record.** Literal request/response JSON — params, system blocks, tool schemas, cache markers, redacted headers — plus every metric, per attempt. |
| 6 | Cost scope | **History and aggregates.** A persistent, derived metrics store across all runs. Retires the `GOALS.md` "cost tracking" non-goal. No budgets or caps yet. |
| 7 | The builder | **Native surface, Flyt flow underneath.** A chat UI backed by a hidden flow running on `core/flowRunner.js` with the user's chosen model, and as transparent in run view as any other flow. |
| 8 | Positioning | **Both.** Investigator layer *and* coding agent. |
| 9 | Where metrics live | **On runs, primarily.** Plus an Investigator page for cross-run structure and visualisation. |
| 10 | What moves into the graph | **Model per node. Retries and timeouts per node.** *Not* context assembly; *not* decomposition/spawning — those stay engine concerns. |
| 11 | Control flow | **Conditionals + bounded loops.** Retires the DAG-only non-goal. Every loop must declare a bound. |
| 12 | Toolbox track | **HTTP tools proceed; the rest pauses.** |
| 13 | Metrics store | **Files + rebuildable derived index.** The index is never authoritative and can be deleted at any time. |
| 14 | Investigator page must answer | Model leaderboard · spend and usage over time · latency and throughput distributions. |
| 15 | Migration | **Clean break.** Bump the run-record format; old runs are "pre-metrics" and excluded from aggregates; flows are not migrated. |
| 16 | Compare / judge / sweeps (D27) | **Core to the pivot.** Sweeps become a headline feature feeding the Investigator page. |

---

## 3. Principles that change

These are edits to `GOALS.md`, not reinterpretations of it. Each one retires something
currently written as non-negotiable.

**Retired — "templates do not contain hand-written prompts."** `GOALS.md` §Core Concepts
currently states that the model generates its own prompt and the template only constrains
*how*. Decision 2 inverts this. The replacement principle:

> *Nothing is sent to a model that the user cannot see and could not have written. Prompts
> are authored artifacts. A model may draft one; it may never conjure one at runtime.*

Assembled context (`upstreamContext()`) stays automatic — decision 10 deliberately left it
alone — but it becomes *visible* in the wire record, which satisfies the principle without
the cost of making it editable.

**Retired — "cost tracking" as a non-goal.** `GOALS.md` §Explicit Non-Goals lists cost
tracking, and `src/modelCost.js` carries a scope-discipline comment enforcing it
("they never see a token count, a run, or a total"). Decision 6 makes spend accounting a
first-class product surface. That comment and that discipline are deleted.

**Retired — DAG-only.** "Full general-purpose visual programming (loops, conditionals,
sub-flows)" was a non-goal in both `GOALS.md` and `PRODUCT-SPEC.md` §9. Decision 11
promotes conditionals and *bounded* loops out of it. The non-goal narrows to: no arbitrary
recursion, no unbounded iteration, no sub-flows-as-a-language.

**Retired — "non-file state store" as a non-goal, partially.** Decision 13 keeps files
authoritative but blesses a derived index. The narrowed non-goal: *no non-file store may
ever be the source of truth.*

**Unchanged and load-bearing:** file-based state (principle 1), human oversight
(principle 2), model-agnostic (principle 3), inspectability over convenience
(principle 5 — the pivot is this principle eating the product), feel and responsiveness
(principle 7).

---

## 4. The architectural centre: the call ledger

Everything in this plan rests on one new primitive.

### 4.1 What exists today

`core/adapters/index.js` exposes one chokepoint — `callModel()` — that every node, agent
turn and adapter passes through. It already returns `usage` and `durationMs`, and already
threads an `AbortSignal` and a retry loop. Three things go wrong from an investigator's
point of view:

1. **`core/agent.js` merges usage across loop iterations** (`addUsage`, line 73). A node
   that took six agent turns reports one summed number. Per-call granularity is destroyed
   at exactly the layer where it matters most.
2. **`durationMs` is measured across all retry attempts** — `started` is captured before
   the retry loop. A call that succeeded on attempt 3 reports the total including backoff
   sleeps, so latency data is silently wrong.
3. **The record dies at the retrospective.** `core/retrospective.js` stores `usage` and
   `durationMs` per node. There is no per-call artifact, no cost, no time-to-first-token,
   no throughput, and no wire capture anywhere.

### 4.2 The call record

One immutable file per model call — **per attempt**, not per node:

```
runs/<runId>/calls/<seq>.json           the record
runs/<runId>/calls/<seq>.request.json   wire: what was sent  (redacted, bounded)
runs/<runId>/calls/<seq>.response.json  wire: what came back (redacted, bounded)
```

```jsonc
{
  "seq": 7,
  "runId": "...", "nodeId": "implement", "taskId": "task-2", "attempt": 0,
  "provider": "openrouter", "model": "openai/gpt-5.6-luna-pro",
  "startedAt": "...", "firstTokenAt": "...", "endedAt": "...",
  "durationMs": 8412, "ttftMs": 640, "outputTokensPerSec": 31.2,
  "usage": { "inputTokens": 12400, "cachedInputTokens": 9800,
             "outputTokens": 243, "reasoningTokens": 0 },
  "cost": { "input": 0.0155, "output": 0.0024, "total": 0.0179,
            "currency": "USD", "estimated": false,
            "priceSource": "catalog@2026-07-25" },
  "finishReason": "stop", "protocol": "native",
  "error": null,
  "wire": { "request": "calls/7.request.json", "response": "calls/7.response.json",
            "truncated": false }
}
```

**Where it is captured:** a wrapper inside `callModel()` in `core/adapters/index.js`. That
is the one place every provider already funnels through, so no adapter needs to know the
ledger exists. Two consequences follow and both are deliberate:

- **Per attempt.** The record is written inside the retry loop, so a call that failed
  twice produces three records. Retries stop being invisible — they become the first thing
  the investigator shows you when a node was slow.
- **`durationMs` is fixed as part of this work** by moving `started` inside the loop.

**Time-to-first-token** comes free: adapters already call `onText` with accumulated text.
The wrapper timestamps the first invocation. Non-streaming adapters emit `ttftMs: null` —
never 0, never faked.

**`core/agent.js` stops merging.** `addUsage` is retained *only* as a derived rollup for
the retrospective's summary line. The ledger is the truth; the retrospective becomes a
view of it.

### 4.3 Wire capture, redaction and bounds

The wire record is the most valuable and most dangerous artifact in the app.

- **Redaction is mandatory and centralised.** API keys, `Authorization` headers, and
  anything matching the existing secret patterns are replaced before any byte is written.
  `core/tools/redact.js` already does exactly this for tool arguments (`redactArgs`,
  `redactUrl`, the `[redacted]` sentinel) and `core/tools/index.js` already writes only
  the redacted record. Extend that module; do not write a second one.
- **Bounded, with a pointer.** A call with a 200k-token context produces a multi-megabyte
  request body. Wire files are capped (proposed: 256 KB each) with head/tail preservation
  and a `truncated: true` flag, mirroring P2's bounded-preview pattern. Full bodies are
  opt-in per run via a setting, never the default.
- **Honest holes.** `claude-code` and `codex` adapters spawn a vendor CLI
  (`SUBSCRIPTION-AUTH-GUIDE`, D23). There is no HTTP wire to capture. Those calls get a
  **degraded record**: usage, timing and text, with `wire: null` and an explicit
  `wireUnavailable: "cli-delegate"`. The investigator must render that as a stated
  limitation, never as an empty panel.

### 4.4 Cost

New module `core/callCost.js`. Takes a usage object and a `core/modelCatalog.js` price
record, returns dollars. Rules:

- Cached input tokens are priced at the cached rate when the catalog knows one.
- An unpublished price or an off-catalog model yields `total: null, estimated: true`.
  **It must never collapse to 0** — a fabricated zero is worse than a blank, and
  `src/modelCost.js` already encodes this instinct for published prices.
- Subscription entries (`{ kind: 'plan' }`) cost plan capacity, not dollars. They report
  `cost: null` with a `costKind: 'plan'` marker and are excluded from spend charts —
  but *included* in token and latency charts.
- The catalog version is stamped into every record, so a later price change never
  retroactively rewrites history.

### 4.5 The derived index

```
runs/_index/calls.jsonl        one line per call, append-only
runs/_index/meta.json          schema version, last-scanned run, build timestamp
```

The `_index` prefix cannot collide with a runId (runIds are timestamp-prefixed). The index
is **derived and disposable**: `npm run metrics -- rebuild` walks `runs/*/calls/*.json`
and regenerates it from scratch, mirroring the existing `npm run flow -- lint|migrate`
CLI shape. If it is missing, corrupt, or a schema version behind, the app rebuilds it
silently on launch. Nothing reads it as truth; every number it serves can be re-derived.

---

## 5. The graph after the pivot

### 5.1 An empty library and a hidden kernel

- `nodes/*.json` no longer ships. The ten current templates move to `presets/nodes/`.
- `flows/*.flow.yaml` no longer ships as installed flows. The five pipelines move to
  `presets/flows/`.
- The **palette on an empty library shows the engine primitives** — `input`, `output`,
  `aiStep`, `agentTask`, plus the new `branch` and `loop`. You can always build from zero
  by hand, with no library at all. This is what makes "empty" survivable.
- **Create node** offers three doors: *Blank* · *Start from a preset* (the gallery of the
  ten) · *Describe it* (the copilot). **Create flow** offers the same three.
- The **kernel** is 2–3 nodes carrying `system: true`, stored under `nodes/_system/`.
  They are hidden from the palette and from the Nodes page, exist only to run the builder
  flow, and are fully visible in run view when it executes.

### 5.2 Prompts, models, retries

Three new first-class node fields, each with an instance-level override that follows the
existing `templateId` + `overrides` merge in `src/flowTypes.js`:

- **`prompt`** — the user-owned prompt. *Draft with AI* fills the field; it does not
  bypass it. Follows `src/ToolCopilot.jsx`'s established pattern: the model produces a
  **draft**, adding it to the library is a **separate human gesture**. That separation is
  already load-bearing for tool trust tiers and should be load-bearing here too.
- **`worker`** — model per node, promoted from "a property of the template" to a graph
  decision on every node. Retires static `categoryWorkers` routing. Requires
  `SETTINGS-MODELS-PLAN` P7's shared `ModelPicker`, which is why that plan is absorbed.
- **`limits`** — `{ attempts, backoffMs, timeoutMs }`. `timeoutMs` closes the gap recorded
  in `DESIGN-SPEC.md` §11.1: an `AbortSignal` is now threaded everywhere (RUN-CONTROL), but
  **nothing ever fires it on a timer**, so a stalled provider still hangs a node forever.
  A timer that aborts the signal is a handful of lines at the `callModel` wrapper — the
  same wrapper the ledger lives in.

### 5.3 Conditionals and bounded loops

The heaviest engine work in the plan. Two new node types in
`core/flowlang/schema.json`'s type enum:

- **`branch`** — evaluates an expression over upstream state and activates exactly one
  outgoing edge. Edges gain an optional `when` label.
- **`loop`** — a container that re-runs its body until a condition holds or a bound is
  hit. Implemented on the **orchestrator's existing inline sub-walk**, which already knows
  how to run a nested set of nodes within the parent walk — rather than back-edges, which
  would break the DAG lint the whole DSL rests on.

**The expression language must stay tiny and zero-dependency (D24).** A hand-written
evaluator in `core/flowlang/expr.js` over a fixed grammar: field access on upstream node
results, string comparison and `contains`, numeric comparison, `and`/`or`/`not`. No
arbitrary JS, no eval, no library.

**Expressions can read metrics.** `implement.cost.total > 0.50` and
`implement.usage.outputTokens > 4000` are valid conditions. This is where the pivot closes
its own loop: the investigator's data becomes an input to control flow, so a flow can
cheapen or escalate itself based on what it just spent.

**Every loop declares a bound or lint fails.** `maxIterations` is required; a token or
cost budget is optional but strongly encouraged. New lint rules join the existing six:
unbounded loop, unreachable branch arm, branch with no default arm, loop body with no exit
condition. Unbounded iteration against a metered API is the one way this feature becomes a
liability, and lint is the place to stop it.

### 5.4 The builder

A native chat surface (Nodes page and Flows page, following `src/ToolCopilot.jsx`'s left-
column layout) whose backend is a **hidden Flyt flow** running on `core/flowRunner.js`
with the user's chosen model. It writes `nodes/*.json` and `flows/*.flow.yaml`, lints via
`npm run flow -- lint --json` until `ok: true`, and presents the result as a **draft** the
user commits.

That it is a real flow is the point: you can open its run record and see what your builder
cost, how long it took, and exactly what it sent — the same as any flow you wrote. The
one part of the app that is *not* investigable would otherwise be the part that writes
everything else.

---

## 6. The investigator surfaces

### 6.1 On the run (primary)

- **Node cards, live:** tokens accruing, cost accruing, tok/s, and an attempt badge when
  a call is retrying. Motion stays within the D9 "deliberate and legible" policy — numbers
  tick, nothing spins.
- **Run header:** total cost, total tokens, wall time, calls made, retries.
- **Inspector → new *Calls* tab:** the per-attempt list for the selected node; selecting a
  call opens the wire viewer — request and response JSON, collapsible, redacted, with the
  truncation state stated rather than hidden.
- **Edges** already carry `edgeContext` byte counts in `meta.json`. Promote them to a
  visible weight so context growth along a chain is legible at a glance.

### 6.2 The Investigator page (cross-run)

Answers the three questions a single run cannot:

1. **Model leaderboard** — cost, latency, throughput and (where a judge ran) quality, per
   model, sliceable by node type. This is `PRODUCT-SPEC.md` §7's ranking→routing loop
   finally having data behind it.
2. **Spend and usage over time** — trended across runs, sliced by model, flow and node.
3. **Latency and throughput distributions** — p50/p95/max rather than averages. A p95 view
   would have surfaced the 347-second hang in `DESIGN-SPEC.md` §11.1 immediately.

Charts should be hand-rolled SVG, consistent with the existing craft in
`src/Constellation.jsx` and `src/sigil.js`, and with the repo's near-zero dependency
posture. Line, bar, histogram and box are the only shapes needed. *(Open question §10.1.)*

### 6.3 Compare and sweeps

D27's compare/judge is built; its sweeps design is settled but unbuilt. The pivot promotes
both. Sweeps (N configs × M prompts) already reuse `runFlow` and the comparison record —
what they gain is **cost and latency as first-class axes alongside judged quality**, and a
leaderboard that writes into the same index the Investigator page reads.

---

## 7. Phases

Three milestones. Each is independently shippable and each leaves the app in a coherent
state.

### Milestone A — the instrument exists

**P1 · The call ledger.** Wrapper in `callModel`; per-attempt records; TTFT via `onText`;
fix `durationMs` to be per-attempt; stop merging usage in `core/agent.js` (keep it as a
derived rollup); wire capture in `http.js` and `anthropic.js`; degraded records for the
CLI-delegate adapters; centralised redaction; size bounds. Tests: record shape per adapter,
redaction never leaks, retries produce N records, truncation flags correctly.

**P2 · Cost.** `core/callCost.js`; catalog lookup with cached-token rates; `estimated`
and `costKind: 'plan'` semantics; per-call → per-node → per-run rollups; delete the scope
comment in `src/modelCost.js`. Tests: never returns 0 for an unknown price; plan entries
excluded from dollars but present in tokens.

**P3 · Metrics on the run surface.** Node cards, run header, Inspector *Calls* tab, wire
viewer, edge weights. **This is the first phase where the pivot is felt.** Bump the run
record to v2; older runs render as "pre-metrics".

### Milestone B — the graph is yours

**P4 · Index + Investigator page.** `runs/_index/`; `npm run metrics -- rebuild`; silent
rebuild on schema drift; the three views. *TOOLS-PLAN P6–P10 is re-evaluated here.*

**P5 · Empty library + presets + kernel.** Move `nodes/` and `flows/` to `presets/`;
primitives on the palette; `system: true` kernel under `nodes/_system/`; the three-door
Create dialogs.

**P6 · Prompt, model and limits as node fields.** The `prompt` field and *Draft with AI*;
`worker` per node (absorbs `SETTINGS-MODELS-PLAN` P6–P7); `limits` with a real timeout
firing the existing `AbortSignal`. Retire `categoryWorkers`.

**P7 · The builder.** Native surface, hidden flow, user-chosen model, draft-then-commit,
lint-until-green, fully visible in run view.

### Milestone C — the lab

**P8 · Control flow.** `branch` and `loop` node types; `core/flowlang/expr.js`; schema,
parse, validate, serialize, lint; runner support via the orchestrator's sub-walk;
metric-reading conditions; four new lint rules; mandatory loop bounds. Update
`FLOW_LANG.md` and `FLOW_NODES.md`.

**P9 · Sweeps + compare on metrics.** Build sweeps; wire cost/latency into the comparison
record and the leaderboard.

**P10 · Doc reconciliation.** Rewrite `GOALS.md`'s one-sentence vision, principles and
non-goals; rewrite `PRODUCT-SPEC.md` §§1–5; rebuild `DESIGN-SPEC.md` §11's ledger; write
D35 into `DECISIONS.md`; retire `SETTINGS-MODELS-PLAN.md`.

**P11 · Verification.** See §9.

**Sequencing note.** P8 lands after P7, so the builder will not know about `branch` and
`loop` when it first ships. Either accept a builder that only emits DAGs until P8 closes,
or hold the builder's prompt-side flow-vocabulary in one place so P8 is a single edit. The
latter is cheap and worth doing in P7.

---

## 8. What is explicitly not in this plan

- **No proxy, no external-agent observation, no OTel import** (decision 1). If the app
  didn't make the call, it doesn't see it.
- **No budgets or spend caps** (decision 6). History and aggregates only; enforcement is a
  later chapter — though §5.3's metric-reading conditions give a flow-level approximation.
- **No context-assembly control and no explicit decomposition** (decision 10).
  `upstreamContext()` and orchestrator spawning stay engine concerns; they become visible,
  not editable.
- **No flow migration** (decision 15). Old flows referencing retired templates will break.
- **No TOOLS-PLAN P6–P10** until P4 closes.
- **No sub-flows, no recursion, no unbounded iteration** — the narrowed DAG non-goal.

---

## 9. Verification (P11)

The pivot is verified when all of the following hold:

1. **Ledger fidelity.** A live run against a real provider produces one call record per
   attempt, and the summed ledger cost matches the provider's own reported charge for that
   run within rounding. *A metrics product whose numbers are wrong is worse than no
   metrics product.* This must be checked against a real invoice, not a unit test.
2. **No secret ever reaches disk.** An automated scan of `runs/**/calls/*.json` for key
   patterns runs in CI and fails the build on a hit.
3. **Empty-library cold start.** A fresh install with an empty library can, using only the
   builder chat, produce a working flow that runs to completion.
4. **Manual cold start.** The same, using only the palette primitives and no builder — so
   a broken builder is never a broken product.
5. **Timeout works.** A deliberately stalled provider aborts at `timeoutMs` and the retry
   budget engages, directly retesting the §11.1 hang.
6. **Loop bounds hold.** A loop that would otherwise run forever stops at its bound, and
   lint rejects one declared without a bound.
7. **Index is disposable.** Delete `runs/_index/`, relaunch, and every Investigator number
   is identical after rebuild.
8. **The coding loop still passes.** `DESIGN-SPEC.md` §11.1's V1 acceptance is re-run and
   still lands the feature with a green suite. Positioning is "both" — the pivot is not
   permitted to quietly break the half it isn't working on.

Item 8 is the one most likely to be skipped and the one most worth not skipping.

---

## 10. Open questions

1. **Charting.** Hand-rolled SVG (consistent, zero-dep, slow to build) or a charting
   dependency (fast, breaks a strong repo convention)? D24's zero-dependency rule is
   written about the DSL parser, not the UI — so this is a judgement call, not a violation.
2. **Wire-capture default.** Off, on-with-bounds, or on-with-bounds-and-a-retention-policy?
   Runs currently accumulate forever; adding megabytes per call changes that calculus.
   A retention/prune policy for `runs/` may be forced by this plan.
3. **Cached-token pricing.** `core/modelCatalog.js` needs cached-input rates per model, and
   not every provider publishes one. What does the record say when the rate is unknown but
   the token count isn't?
4. **Leaderboard honesty.** Ranking models from organic run history means comparing across
   different prompts, node types and moments. How does the page avoid presenting
   incomparable samples as a ranking? (Sweeps produce controlled data; organic runs do not.
   Possibly: organic history shows distributions, only sweeps produce rankings.)
5. **Preset trust.** Do presets carry a provenance marker distinguishing shipped presets
   from user-saved ones, mirroring the tool trust tiers in `TOOLS-PLAN` §12.2?
6. **Kernel exact contents.** 2–3 system nodes — which? A `flow-architect` agentTask that
   writes and lints, and a `node-drafter`, is the minimum. Settle in P7.

---

## 11. Risks

**The two-front war.** Decision 8 keeps the coding-agent positioning while adding a full
observability product. That is two products' worth of surface area for one person. The
mitigation is real but partial: `TOOLS-PLAN` P6–P10 is paused, `SETTINGS-MODELS-PLAN` is
absorbed rather than run in parallel, and each milestone here ships standalone. **If
anything in this plan slips, this is why.** Watch for it at the P4 re-evaluation gate.

**Wire records are a data-loss liability.** They contain the full text of everything sent
to a model — source code, credentials pasted into prompts, private documents. Bounded,
redacted, opt-in-for-full is the design; getting it wrong once is a serious incident.

**Loops multiply spend.** A bounded loop is only as safe as its bound. Mandatory
`maxIterations` at lint is the guard; a cost budget per loop is the belt to that
suspenders and probably shouldn't stay optional.

**The empty library is a cold start.** A new user faces a blank canvas. Presets and the
builder are the two answers, and verification items 3 and 4 exist because *both* must work
independently.

**Metrics that are subtly wrong are worse than none.** An investigator product's entire
value is that you can trust the numbers. Verification item 1 is the load-bearing check in
this plan.

**Sunk plan cost.** `TOOLS-PLAN.md` is 1,464 lines of committed design. Pausing it is
correct and will feel bad. It is paused, not cancelled, and the P4 gate is when that
decision gets made again with better information.

---

## 12. Draft D35 — the investigator pivot

> **D35 (draft).** Flyt's value proposition moves from *doing things with LLMs* to
> *seeing what LLMs are doing*. Every model call produces an immutable, per-attempt record
> carrying usage, cost, latency, throughput and a bounded, redacted wire capture; those
> records are the truth and a disposable derived index makes them queryable across runs.
> The node library ships empty behind a hidden kernel, with the ten existing templates
> demoted to presets. Prompts, models, retries and timeouts become user-owned fields on
> the node; conditionals and bounded loops enter the DSL and may branch on metrics.
> A native builder chat, backed by a visible Flyt flow, replaces manual authoring as the
> default path. Retires three `GOALS.md` non-goals (cost tracking, DAG-only, non-file
> stores as strictly forbidden) and one non-negotiable principle (templates contain no
> hand-written prompts). Positioning stays *both* investigator and coding agent.
> Supersedes the relevant parts of D5 (AI-helper builder), D12 (matrix-first routing),
> D13 (retrospective→ranking loop) and D27 (configs/compare), and reshapes the still-draft
> D32 and D34 before either lands.
>
> *Numbering: `DECISIONS.md` currently ends at D33; D32 is reserved by
> `SETTINGS-MODELS-PLAN.md` §11 and D34 by `TOOLS-PLAN.md` §22, so D35 is the next free
> number. Lands in `DECISIONS.md` when P11 closes.*
