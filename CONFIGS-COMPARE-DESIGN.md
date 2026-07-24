# Configs & Compare-Anything — Design Proposal

**Status:** 2026-07-22 — P1 (configs UX), P2 (compare-anything), and P3 (blind judge) are **implemented**; P4 (sweeps) is open.
**Read with:** `DECISIONS.md` D27 (the override-map primitive), `FLOW_LANG.md`, `src/flowTypes.js`,
`src/compareRun.js`, `core/state.js`.

## Problem

1. **Making variants of a workflow is unfriendly.** A "config" of e.g. the Low
   pipeline is a `modes:` block that can only be edited as raw YAML. No
   duplication, no visual editing, no way to see what a mode actually changes
   without reading override maps by eye.
2. **Comparison is launch-time only.** You can only compare two configs by
   firing two fresh runs from the composer, right now. You can't compare against
   a run from yesterday, can't re-match a finished run against a tweaked config,
   and once the tab is gone the pairing is gone.
3. **Future goal: adversarial optimization loops.** Sweep configs over prompts,
   judge outputs, mutate the winner, repeat. The entities we design now must
   make that loop a natural extension, not a rewrite.

## Principles

- **Keep the one primitive.** Modes, run inputs, and comparison already reduce
  to *a per-node override map applied at run start* (DECISIONS.md D27). The
  redesign changes **who assembles the map and when** — never the runner.
- **Everything stays data in the flow file.** No flow forks, no versions. A
  config is a named override bundle; the resolved `flow.json` snapshot in each
  run remains the reproducibility anchor.
- **Comparison decouples from launch.** A comparison is a relationship between
  two *runs*, not a composer mode. Any two runs can become a comparison.
- **Runs are self-describing.** Every run already stores its fully resolved
  flow + launch provenance, so "what actually differed?" is computable after
  the fact — for any pair of runs, weeks later, for free.

---

## Part 1 — Configs (modes, upgraded to first-class)

### 1.1 Model changes (small, backward compatible)

The `modes:` block stays in `.flow.yaml` (the DSL remains source of truth).
Add two optional fields per mode:

```yaml
modes:
  gpt5:
    name: GPT-5
    description: Baseline GPT-5 worker, medium effort everywhere.
    overrides:
      refine: { worker: { provider: openai, model: gpt-5 } }
      work:   { worker: { provider: openai, model: gpt-5 } }
  gpt5-strict:
    name: GPT-5 · strict refiner
    derivedFrom: gpt5            # provenance only — NOT resolution inheritance
    description: Same workers, refiner gets a stricter system prompt.
    overrides:
      refine: { worker: { provider: openai, model: gpt-5 } }
      work:   { worker: { provider: openai, model: gpt-5 } }
      refine.system: ...         # (schematic: full map is stored; see below)
```

- `description` — shown in pickers and cards.
- `derivedFrom: <modeId>` — **lineage metadata only**. Duplicating a config
  copies the full override map and records the parent; there is no `extends`
  merge semantics to reason about at run time. This gives the optimization
  loop a lineage tree ("which mutation beat which parent") for free, without
  resolution complexity. (If deltas-in-YAML ever become painful to hand-read,
  an `extends` resolution layer can be added later behind the same field.)

Parse/serialize/validate/lint treat both as pass-through scalar fields; lint
warns on a dangling `derivedFrom`.

### 1.2 The visual config editor (the actual UX fix)

A **Configs panel** on the flow canvas (the existing "modes" chip that jumps
to YAML becomes the panel's anchor):

- **One card per config**, each showing its *diff against Default* as badges:
  `work · model: claude-fable-5 → gpt-5` · `refine · system rewritten` ·
  `work · effort: medium → high`. "Default" = the flow as authored on the
  canvas; it's the implicit base config every diff is computed against.
- Card actions: **Run**, **Duplicate**, **Edit**, **Delete** (delete blocked /
  warned while the config is the tab's selected launch target).
- **Edit** reuses the existing Inspector: an edit-target toggle at the top of
  the Inspector switches between **Flow** (stored node overrides, today's
  behavior) and **Config: \<name\>** (that config's override map). Same fields,
  same per-field override tags, same `overridableFields` /
  `validateOverrideMap` validation — no new editing surface to learn.
  Selecting a node while a config is the edit target shows and edits that
  config's overrides *for that node*, which is exactly "small changes to one
  node".
- YAML editing stays fully supported; the panel and the YAML are two views of
  the same `modes:` block.

### 1.3 Promote a good run to a config

Run meta already records `launchOverrides`. Add **"Save as config"** on a
finished run (RunBar overflow / run header): writes those overrides as a new
mode on the run's flow (`derivedFrom` = the run's `modeId` if it had one).
This closes the loop: *tweak at launch → run → it works → one click promotes
it to a named, comparable config.* Ad-hoc experimentation stops being
disposable.

### 1.4 Picker upgrades

Everywhere a `{flowId, modeId}` is picked (composer chip, compare slots,
rematch picker): configs render with their diff badges, grouped under their
flow, so "Low · Fable vs Low · GPT-5" is scannable instead of a flat list of
names.

---

## Part 2 — Compare anything

A comparison is redefined as **a persisted relationship between two runs in
the same project**, viewed in the existing `CompareRun` split view. Three ways
to create one, one view to consume it:

### 2.1 Entry points

1. **Launch compare (exists, upgraded).** The composer's ⚖ Compare toggle,
   with the 1.4 pickers. Unchanged mechanics: one prompt → two `runFlow`
   calls.
2. **Rematch (new, the headline flow).** On any finished run:
   **"Compare against…"** → pick a config (defaulting to another config of the
   same flow) → the app re-fires the run's original `prompt.md` + workspace
   with the chosen config → split view opens with the *original* run as pane A
   and the fresh run as pane B. This is the one-click answer to "did my prompt
   tweak actually help?" — no re-typing, no re-launching the baseline.
3. **Compare existing runs (new).** Runs list gets a select mode: tick any two
   runs → Compare. Same prompt recommended (hint shown when prompts differ);
   still allowed, because sometimes the question is "which run of these five
   was better" and the answer is inspection, not a new run.

### 2.2 Persistence & provenance

- `meta.json` gains an optional `compareGroup: { id, label: 'A'|'B' }`.
  Launch-compare and rematch both write it; sibling runs become discoverable
  from either side (Runs list can show a ⚖ badge that reopens the pairing).
- A **comparison record** is stored per project,
  `comparisons/<id>.json`:
  ```js
  { id, runIds: [a, b], createdAt, origin: 'launch' | 'rematch' | 'manual',
    verdict: null | { summary, winner?, axes?, judgeModel, at } }
  ```
  Verdict lives here (Part 3); the record survives tab switches and restarts,
  unlike today's `compareRunIds` tab state (which stays as the *open view*
  pointer).

### 2.3 Automatic "what differed" header

Both runs carry `flow.json` (fully resolved) and `meta.launchOverrides`.
`CompareRun` diffs the two resolved flows and renders a header between the
panes: **Model: fable vs gpt-5 · work.effort: medium vs high · refine.system:
differs (view)**. Identical configs collapse to "same configuration — outputs
differ only by sampling".

This is what makes historical comparison trustworthy: the diff is computed
from the runs' own snapshots, so it's accurate even if the flow and its modes
have been edited twenty times since. Pure function in `src/compareRun.js`
(e.g. `diffResolvedFlows(flowA, flowB)`), test-covered like the rest of that
module.

---

## Part 3 — Judge (T13) as designed end-state

Wire T13 as planned, with two additions that set up the optimization future:

- **Structured verdict.** The `compare` role's output contract gains a fenced
  JSON block: `{ winner: 'A'|'B'|'tie', axes: { correctness?, completeness?, ... }, notes }`.
  Human-readable summary renders between the panes as planned ("a summary, not
  a gate"); the structured half lands in the comparison record's `verdict`.
- **Judge model is configurable** (falls back to the default worker), and the
  judge call records which configs were compared — the comparison record knows
  the runs, the runs know their configs.

## Part 4 — Head room for adversarial loops (design now, build later)

With Parts 1–3 in place, the optimization loop needs exactly one new entity:

- **Sweep** — `sweeps/<id>.json` per project:
  ```js
  { id, flowId, configIds: [...], prompts: [...],
    runs: { [promptIdx]: { [configId]: runId } },
    status, createdAt }
  ```
  A sweep is a compare group generalized to N configs × M prompts. Execution
  reuses `runFlow` unchanged; judging reuses the Part 3 verdict call per
  pairing; aggregation is a per-flow **leaderboard** (win rates per config,
  per axis) computed from comparison records.
- **Mutation** is Duplicate + one-field edit + `derivedFrom` lineage (1.1) —
  which Parts 1 already ships. The loop driver (sweep → score → mutate best →
  re-sweep) is then a thin automation over existing IPC, and its every step is
  inspectable as ordinary runs, comparisons, and configs in the UI.

Nothing in Parts 1–3 is throwaway: sweeps are compare groups, leaderboards
aggregate verdicts, mutations are config duplicates.

---

## Phasing

### P1 — Configs UX (no runner changes)
`core/flowlang/*` (parse/serialize/lint `description`, `derivedFrom`),
`core/flowstore.js` (duplicate/promote helpers + `flow:saveConfig`,
`flow:duplicateConfig`, `flow:promoteRunConfig` IPC), new
`src/ConfigsPanel.jsx` + config cards with diff badges, Inspector edit-target
toggle, picker diff badges, "Save as config" on runs. Pure diff logic
(`diffOverrides`) alongside `src/flowTypes.js` helpers, tested like
`tests/modes.test.js`.

### P2 — Compare anything
`meta.compareGroup` writes (launch + rematch), `comparisons/` store in
`core/state.js` (+ `compare:save`/`compare:list` IPC), **Rematch** action +
picker, Runs-list select-compare, `diffResolvedFlows` + diff header in
`CompareRun.jsx`. Tab bundles unchanged (`compareRunIds` remains the view
pointer; the record makes it restorable).

### P3 — Judge (lands T13)
`run:judge` IPC running the `compare` role over both output nodes, structured
verdict parsed into the comparison record, verdict panel between panes.

### P4 — Sweeps (future)
Sweep entity + matrix runner + leaderboard view; adversarial loop driver on
top. Out of scope for P1–P3 except that nothing in them precludes it.

### Suggested order within the phase line
P1 and P2 are independent and can run in parallel; P3 depends on P2's
comparison records; each phase ships standalone value (P1: friendly configs;
P2: rematch; P3: verdicts).

## Non-goals (for these phases)

- No N-way (>2) split *view* — sweeps (P4) present as a matrix of run links +
  leaderboard, not N live panes.
- No config inheritance resolution (`extends`) — lineage metadata only.
- No cross-project comparison (runs are per-project by design).
- No temperature/top-p style sampling params — the override whitelist stays as
  is; adding sampling knobs is a separate decision.
