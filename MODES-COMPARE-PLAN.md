# Modes, Default Pipelines, Run Inputs & Comparison — Implementation Plan

**Status:** 2026-07-22 — Phases 1–4 landed (T1–T10 + T3). Phase 5 comparison
T11 + T12 landed (Compare launch + split-view CompareRun), 430 tests pass.
T13 (the optional Judge action) remains.
**Read with:** `FLOW_LANG.md`, `FLOW_NODES.md`, `src/flowTypes.js`, `core/flowRunner.js`.

## Progress

- **T1 Launch overrides** — `resolveFlow(flow, templates, launchOverrides)`, the
  `overridableFields` / `validateOverrideMap` / `mergeOverrideMaps` primitives,
  `start({ modeId, overrides })`, provenance in run meta. Tests: `tests/modes.test.js`.
- **T2 `modes:` DSL** — parse/serialize/schema/lint + flowstore persistence,
  round-trip stable. Tests: `tests/modes.test.js`.
- **T3 Modes UI** — lint surfaces `mode`/`expose` findings; a modes chip on the
  flow header jumps to the YAML editor.
- **T4 Mode picker** — the launch picker expands a flow into its modes; `runModeId`
  persists per tab; ChatRun header shows the mode. Verified in the preview.
- **T5 `refine` role + `prompt-refiner`** template + questions parser. Tests: `tests/refiner.test.js`.
- **T6 `awaiting_input` gate** — `run:answerInput` IPC, one-round cap, restart-safe;
  inline questions card in ChatRun. Tests: `tests/refiner.test.js`.
- **T7 Seed pipelines** — Low/Medium/High/Ultra with two example modes each, seeded
  idempotently. Tests: `tests/seedPipelines.test.js`.
- **T8 Planner tiering** — the High planner brief is a `system` override (data, not
  a code fork); orchestrator honors `minNodes`/`maxNodes` overrides.
- **T9 `expose:` DSL** — first-class node field, `exposedFields`, `expose` lint. Tests: `tests/modes.test.js`.
- **T10 Launch controls** — `flow:launchInputs` IPC + `LaunchInputs` composer controls
  (model / effort / steppers), values layered as launch overrides, persisted per flow per tab.
- **T11 Compare launch** — a Compare toggle on the lander composer splits the
  workflow chip into A/B slots (each an independent flow+mode). One prompt fires
  two `runFlow` calls; `compareRunIds = [a, b]` takes over the home surface.
  Slot B is seeded with a distinct mode so the two aren't identical. The picker
  is extracted to a shared `WorkflowPicker` (Lander.jsx).
- **T12 Split-view CompareRun** — `src/CompareRun.jsx` streams both snapshots
  itself (subscribes to `run:update`, same merge rules as App), rendering two
  independent panes (own RunBar, feed, stage, and gate dock — a compact dock,
  never the blocking modal, so two panes never fight over the surface). One
  thread header + one shared composer with a Both/A/B target selector: broadcast
  reaches only settled panes, a single target routes follow-up **or** answers an
  input gate. The pair persists in the tab bundle (`comparePair`). Pure logic in
  `src/compareRun.js`; tests in `tests/compare.test.js` (10). Verified in the
  browser preview (feed-based, so it renders outside Electron).
- **T13 Comparison verdict** — not started (optional, last). The pure prep helper
  `judgeAlternatives` exists + tested; wiring needs a `run:judge`-style IPC that
  runs the existing `compare` role over the two panes' output nodes, rendered
  between the panes. Human stays the judge — a summary, not a gate.

Four features, one foundation. Modes, run-time user inputs, and comparison all
reduce to the same primitive: **a per-node override map applied at run start**,
layered on top of the flow's stored overrides before `resolveInstance`. Build
that once (Phase 1) and everything else is UI + seed content.

## Concepts & decisions

- **Launch overrides** — `{ [nodeId]: { worker?, effort?, system?, minNodes?, maxNodes?, ... } }`
  passed to `run:start`, applied during flow resolution, persisted in the run
  snapshot (`runs/<id>/flow.json` already snapshots the resolved flow — the
  override map is additionally recorded in meta for reproducibility/replay).
- **Mode** — a *named, saved* launch-override bundle stored in the flow file
  (`modes:` block). One graph, N configurations ("High — Fable", "High — GPT").
  Picked at launch; not a fork, not a version.
- **Run input** — an *ad-hoc* launch override the flow author chose to expose
  (`expose:` list on a node). Rendered as controls in the composer when that
  flow is selected. Precedence: **run input > mode > node override > template**.
- **Comparison** — two independent, ordinary runs (own run folders, gates,
  follow-ups) launched from one prompt and shown side by side. No new runner
  semantics.
- **Prompt refiner** — new `refine` role. May emit clarifying questions, but
  the contract pressures it not to: questions only when the answer would
  materially change the work. Questions park the run at a new gate
  (`awaiting_input`, sibling of `awaiting_approval`) answered from the chat
  composer. One round max, then it proceeds on stated assumptions.
- **Default pipelines** — seed flows `low`, `medium`, `high` (+ optional
  `ultra`), shipped like `default-pipeline`, using the refiner.

---

## Phase 1 — Launch-override foundation

### T1. Runner accepts launch overrides
`core/flowRunner.js`, `core/flowstore.js`, `src/flowTypes.js` (resolveFlow),
`electron/main.js` IPC, run meta.

- Extend `run:start` payload with `overrides` (per-node map) and `modeId`.
- `resolveFlow(flow, templates, launchOverrides)` merges launch overrides into
  each node's `overrides` (launch wins) before `resolveInstance`.
- Validate: unknown nodeId → reject start; unknown field → reject (whitelist
  per node type: `worker`, `effort`, `instructions`, `system`, `category`,
  `evalType`, `language`, `minNodes`/`maxNodes` (orchestrator),
  `requiresApproval`, `approveToolCalls`).
- Record `{ modeId, overrides }` in run meta; replay/resume uses the snapshot,
  so no runner change needed there.
- Tests: precedence order, rejection cases, snapshot round-trip.

### T2. `modes:` block in the Flow DSL
`core/flowlang/schema.json`, `parse.js`, `serialize.js`, `validate.js`,
`lint.js`, `core/flowstore.js`, `FLOW_LANG.md`.

```yaml
modes:
  fable-high:
    name: High — Fable
    overrides:
      refine:  { worker: { provider: anthropic, model: claude-fable-5 } }
      orchestrate: { maxNodes: 10 }
  gpt-high:
    name: High — GPT
    overrides:
      refine:  { worker: { provider: openai, model: gpt-5 } }
```

- Same field whitelist as T1; validate nodeIds exist; empty/absent block =
  single implicit default mode.
- Round-trips through serialize; lints (mode overriding a deleted node warns).
- Tests: parse/serialize/validate fixtures.

### T3. Mode editing UI (minimal)
`src/Inspector.jsx` or `src/FlowYamlEditor.jsx`.

- V1: modes are edited in the YAML editor only (it already exists and the DSL
  is the source of truth). Add lint surfacing + a "Modes" summary chip on the
  canvas header. A dedicated visual mode editor is a later polish task.

### T4. Mode picker at launch
`src/Lander.jsx` (workflow chip), `src/App.jsx` (run-flow state per tab),
`src/ChatRun.jsx` header.

- Workflow picker shows flows; a flow with modes expands to its modes
  (flat list: "High — Fable", "High — GPT"). Selection = `{flowId, modeId}`,
  persisted per tab like `runFlowId` today.
- `startRun` passes `modeId`; ChatRun header shows the mode next to the flow
  name.

---

## Phase 2 — Prompt refiner node

### T5. `refine` role + template
`src/flowTypes.js` (TYPE_META untouched — it's an aiStep; ROLE_PORTS,
SEED_NODE_TEMPLATES), `core/flowRunner.js` role prompt, `FLOW_NODES.md`.

- Template `prompt-refiner`, role `refine`, effort medium, ports:
  `prompt` (primary — the refined run request) and `questions` (aux).
- System contract: rewrite the user's request into a precise, self-contained
  brief (goal, constraints, deliverable, acceptance). **Only** emit questions
  when an ambiguity would change the deliverable materially; otherwise state
  assumptions inline and proceed. Questions = fenced JSON
  `{ "questions": [{ "id", "text", "why" }] }` (max 3).
- Tests: refined-prompt passthrough, questions JSON parsed, malformed JSON =
  no questions (proceed).

### T6. `awaiting_input` gate + answer flow
`core/flowRunner.js`, `core/state.js` stages, `electron/main.js` IPC,
`src/ChatRun.jsx`, `src/ApprovalModal.jsx` (or a lighter inline card),
`src/RunBar.jsx` stage copy.

- When a refine node emits questions: write `nodes/<id>.questions.json`, set
  stage `awaiting_input`, notify like the approval gate (OS notification +
  flash reuse).
- Chat UI: questions render as an inline card above the composer; the composer
  submits answers (free text per question, or one combined reply). Answers
  written to `runs/<id>/nodes/<id>.answers.md`; node re-runs with answers
  appended to its context; **one round hard cap** — second-round questions are
  ignored and logged.
- Follow-up path (`run:followUp`) stays untouched; this is a distinct IPC
  (`run:answerInput`).
- Tests: gate set/cleared, answers file, one-round cap, resume-while-gated.

---

## Phase 3 — Default pipelines

### T7. Seed flows low / medium / high (+ ultra)
`flows/` seeds + startup seeding in `core/flowstore.js` (same pattern as the
node library seeding; don't overwrite user edits — seed only when absent),
layout sidecars.

- **low.flow.yaml — "Low"**: `input → prompt-refiner → work (Code general,
  effort medium) → output`. Work node `expose: [worker, effort]` (see T9).
- **medium.flow.yaml — "Medium"**: `input → prompt-refiner → plan (plan-start,
  effort medium) → orchestrator (1–5) → output`.
- **high.flow.yaml — "High"**: medium's graph; planner effort high with an
  enriched system prompt (decomposition guidance, parallelism hints, context
  specs per task); orchestrator budget 2–10. Expose orchestrator
  `minNodes`/`maxNodes`.
- **ultra.flow.yaml — "Ultra"** (optional, ship last): high + `evaluation`
  (final) between orchestrator and output, feedback edge for one bounded
  retry.
- Each ships with 2 example modes (e.g. Fable / GPT worker bundles) so the
  mode picker and comparison have something to chew on day one.
- Tests: seeds parse + validate + resolve; seeding idempotent.

### T8. Planner tiering
`core/flowRunner.js` (plan-start prompt already exists).

- Parameterize the plan-start system prompt so the enriched "high" guidance is
  template/override data (`instructions`/`system` on the node), not a code
  fork — keeps T7 pure data. Verify orchestrator honors per-node
  `minNodes`/`maxNodes` overrides from T1 (it reads node data today).

---

## Phase 4 — Run inputs (exposed node fields)

### T9. `expose:` in the DSL
`core/flowlang/*`, `src/flowTypes.js`, `FLOW_LANG.md`.

- Per node: `expose: [worker, effort]` — subset of the T1 whitelist, validated
  per node type (`maxNodes` only on orchestrator, `language` only on
  translation, etc.).
- Resolved flow carries the exposure list so the UI can render without
  re-parsing YAML.

### T10. Launch controls in the composer
`src/Lander.jsx`, `src/ChatRun.jsx` (new-chat composer), `src/App.jsx`.

- When the selected flow (or flow+mode) exposes inputs, render compact
  controls under the composer: model dropdown (providers with keys, via
  `core/modelPriority.js` / model source), effort segmented control,
  numeric steppers for node budgets. Label = node title + field.
- Values become the `overrides` map at `run:start` (they sit on top of the
  chosen mode — precedence from T1). Untouched controls send nothing.
- Persist last-used values per flow per tab (same pref pattern as
  `chatrun:view`).
- Tests: override map assembly; control rendering per exposure list.

---

## Phase 5 — Comparison mode

### T11. Compare launch UX
`src/Lander.jsx`, `src/App.jsx`.

- A "Compare" toggle on the composer splits the workflow chip into slots A/B.
  Each slot = flow + mode + (its own exposed-input values). Same flow with two
  modes is the headline case; two different flows also legal.
- One prompt, one Enter → two `run:start` calls; tab records the pair
  `{ compare: [runIdA, runIdB] }`.

### T12. Split-view ChatRun
`src/ChatRun.jsx`, `src/App.jsx`, `src/TabDeck.jsx`/`TabStrip.jsx`.

- A compare tab renders two ChatRun columns (shared scroll container, one
  thread header). Each pane keeps its own feed, gates, sidebar, and stage —
  approval/input gates resolve per pane and never block the sibling.
- Composer semantics: default **broadcast** follow-up to both runs; a per-pane
  send affordance for steering one side. Composer disabled-state = "either run
  busy" per pane, not global.
- Narrow widths stack panes with an A/B switch. Tab restore rebuilds both
  snapshots.
- Tests: pair restore, per-pane gating, broadcast follow-up.

### T13. Comparison verdict (optional, last)
- A "Judge" action on a settled compare tab: runs the existing `compare` role
  over the two output nodes' results (one-shot aiStep, its own mini-run or a
  direct adapter call) and renders the report between the panes. Human stays
  the judge; this is a summary, not a gate.

---

## Phase 6 — Close-out

### T14. Docs + migration + polish
- Update `FLOW_LANG.md` (modes, expose), `FLOW_NODES.md` (refine role,
  default pipelines section), `README.md`.
- Lint rules: mode referencing missing node, exposed field not overridable,
  refiner absent in seeds (info only).
- Full `npm test` pass; a smoke compare run against the mock adapter.

---

## Sequencing & dependencies

```
T1 ─┬─ T2 ── T3 ── T4 ─────────┐
    │                          ├─ T11 ── T12 ── T13
    ├─ T9 ── T10 ──────────────┘
    ├─ T8 ─┐
T5 ── T6 ──┴─ T7 (seeds need refiner + tiering)
                                T14 last
```

Standalone-shippable checkpoints: after T4 (modes usable), after T7 (default
pipelines usable), after T10 (run inputs on Low), after T12 (comparison).
