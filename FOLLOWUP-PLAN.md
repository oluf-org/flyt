# Follow-up Turns — Continuation Plan

**Problem.** When a run reaches a terminal stage (done, failed, rejected), the conversation is over. The user has no way to respond to the result — report a bug, ask for a tweak, request a feature — without starting a new run and losing all context.

**Solution shape (decided).** A finished run gets a reply box. Feedback does **not** re-run existing nodes. Instead the flow **grows**: a triage step selects finished nodes to draw context from, materializes a *continuation subgraph* appended after the finished output, and the normal walk executes it. A closing **feedback-review** node checks whether the feedback is solved and can materialize further nodes if not. The run is a living document: each turn is an append-only extension of the same graph, in the same run folder, with full context.

This deliberately reuses three things that already exist: the dynamic topological walk re-computes readiness every wave and already accepts nodes materialized mid-run (plan-eval); edges are already the context-passing mechanism; gates/eval verdicts/resume already survive restarts. A follow-up turn is "plan-eval materialization, triggered by a human instead of a plan".

---

## Decisions

Format follows DECISIONS.md (Context → Decision → Status). Numbered FU1… to keep them separable from D-series; fold into DECISIONS.md when implemented.

### FU1 — Turns extend the graph; completed nodes are never re-run
**Context.** First design re-ran affected nodes with feedback as context. That mutates history, fights the file-based audit model, and makes "finished" ambiguous.
**Decision.** A turn appends new nodes and edges to the run's `flow.json`. Existing nodes keep status `done` and are never re-executed; the walker skips them (they're in `completed`). Prior outputs reach new nodes **via edges** — context selection is literally "which done nodes get an edge into the new subgraph". No new context mechanism.
**Status.** Decided.

### FU2 — Terminal stages become re-openable via a dedicated entry point
**Context.** `TERMINAL_STAGES` blocks `resume()`; that guard is correct and stays.
**Decision.** New runner entry point `followUp(runId, text)`, legal **only** from a terminal stage when the run is not live and has a `flow.json`. It extends the flow, sets stage back to `execution`, and calls `launch(runId, flow, resume=true)` — `completed` is rebuilt from `meta.nodeStatus`, so only the new nodes are ready. `resume()`/`resumeBlocker` are untouched; a crash mid-turn is handled by the existing `reconcileInterrupted` → `resume()` path with zero new code.
**Status.** Decided.

### FU3 — Triage classifies into question / fix / feature
**Context.** "What is most useful varies" — from asking about the output to requesting a new feature.
**Decision.** One LLM call (strict-JSON contract in `core/planEval.js` style, total parser, never throws) returns:
- `question` — no graph change. Answer written to `followups/<n>/answer.md`, shown in the thread; run stays done.
- `fix` — materialize a small subgraph: 1–2 executor nodes (from Node Library templates, category-driven model selection as in plan-eval) + the feedback-review node. Skips planning and approval.
- `feature` — **continue the pipeline**: materialize the standard reflective segment — Plan → Plan Evaluation (approval gate) → materialized executors → Stitch → feedback-review. Gates fire naturally because they're just new gate nodes.

Triage also returns `contextNodes` (done nodes to wire in as inputs) and per-node guidance. Misclassification safety net: FU6.
**Status.** Decided.

### FU4 — The feedback itself is an input node on the canvas
**Context.** New nodes need the feedback text; the app's transparency principle says every input should be visible on the canvas.
**Decision.** Each turn materializes `fu<n>-input` (type `input`, data = feedback text) as the subgraph's source node, alongside edges from `contextNodes`. The canvas shows exactly what the turn was asked to do and what it could see. `prompt.md` stays turn 0's request; turn prompts live in `followups/<n>/prompt.md`.
**Status.** Decided.

### FU5 — Node namespacing and provenance
**Decision.** Turn-n nodes get ids prefixed `fu<n>-` (collision-proof against plan-eval's ids) and provenance `{ origin: 'followup', turn: n }` in node data, mirroring plan-eval provenance. `meta.json` gains `turn: <n>` and new `nodeStatus` entries (pending).
**Status.** Decided.

### FU6 — feedback-review closes every turn
**Context.** User requirement: after the continuation runs, review whether the feedback is actually solved, and whether more nodes are needed.
**Decision.** New eval role `feedback-review` (parser in `planEval.js`, alongside step-eval/stitch). Input: the feedback, the turn's node outputs, workspace diff. Contract: `{ verdict: 'solved' | 'more-work', reason, nodes?: [...] }`. `more-work` materializes additional nodes upstream of itself (identical mechanism to plan-eval), **bounded to 2 extensions per turn**; hitting the bound escalates through the existing human-escalation gate. `solved` lets the walk drain → run is done again. This is also the misclassification safety net: a `fix` turn that turns out to be a feature gets caught here.
**Status.** Decided.

### FU7 — Reply box on failed and rejected runs too
**Decision.** The composer appears at every terminal stage. On `failed`, triage is told which node failed and why (from meta/log) and routes the continuation around or past it — feedback like "skip that step" or "use approach B" becomes a turn. On `rejected` (plan rejected), a turn is the natural "here's what was wrong with the plan" path.
**Status.** Decided (per 2026-07-17 interview).

### FU8 — Archive per turn
**Context.** Nothing is overwritten (FU1), but `flow.json` and `meta.json` do mutate when the graph extends.
**Decision.** Before extension, snapshot both to `followups/<n>/before/`. Every turn boundary is reconstructable; `log.jsonl` records `followup_received`, `followup_triaged`, `turn_started`, `turn_done`.
**Status.** Decided (per 2026-07-17 interview).

### FU9 — Context payload discipline
**Context.** Done-node outputs can be large; a long run's full context won't fit a triage prompt.
**Decision.** Triage sees a **digest**: flow topology, per-node first ~40 lines of output, the write-ledger summary (`core/writeLedger.js`) of files touched, and failure info. Executor nodes in the subgraph get full outputs of their direct edge-parents only (normal edge semantics). Workspace-bound runs include the ledger so turn n knows what turns 0…n-1 changed on disk.
**Status.** Decided.

### FU10 — Turn concurrency guard
**Decision.** One turn at a time: composer disabled while the run is live (`this.live`), and `followUp` throws if live. No queueing of feedback in v1 — the user watches the turn, then replies again.
**Status.** Decided (v1).

## Open (deferred, not blockers)

- **Q-FU1** Turn budget/pruning: runs that accumulate many turns will grow large canvases. Collapse-by-turn in the UI is the likely answer; not needed for v1.
- **Q-FU2** Editing a turn's feedback / deleting a turn. Out of v1; `followups/<n>/before/` makes rollback possible later.
- **Q-FU3** Multi-feedback batching (reply while running). Excluded by FU10 for now.

---

## File model (per run)

```
runs/<runId>/
  prompt.md                      turn-0 request (unchanged)
  flow.json                      grows append-only each turn
  meta.json                      + turn: n, new nodeStatus entries
  nodes/fu<n>-*.md               turn outputs (new files, nothing overwritten)
  followups/<n>/
    prompt.md                    the feedback text
    triage.json                  classification + contextNodes + materialized spec
    answer.md                    (question-class only)
    before/flow.json, meta.json  pre-turn snapshot (FU8)
  log.jsonl                      turn events appended
```

## Engine changes (all in existing files)

1. **`core/flowRunner.js` — `followUp(runId, text)`** (~new 80 lines): guards (FU2) → snapshot (FU8) → triage call → materialize per FU3/FU4/FU5 (reuse the plan-eval materialization path) → stage `execution` → `launch(resume=true)`.
2. **`core/flowRunner.js` — `feedback-review` role**: one new branch next to the `plan-eval`/`step-eval` role handling; materialization + bound (FU6).
3. **`core/planEval.js`**: `parseTriage`, `parseFeedbackReview` — same total-parser style.
4. **`core/state.js`**: `writeFollowup(runId, n, ...)`, `snapshotBeforeTurn`, `nextTurn` helpers.
5. **Prompts**: triage + feedback-review system prompts alongside the existing role prompts; feedback-review added to the eval-roles set.

## UI changes

1. **`src/RunResult.jsx`** → thread view: segments per turn (feedback → outcome), composer at terminal stages, disabled while live (FU10). Question-class answers render inline.
2. **Canvas**: turn-n nodes drawn via the existing run-time-spawned-node path (D5 view mode); badge nodes with their turn number; `fu<n>-input` shows the feedback.
3. **`src/RunsList.jsx`**: show turn count.

## Implementation order

1. Engine: `followUp` + triage (fix-class only) + materialization + resume-walk. Test headless against a mock provider.
2. feedback-review node + more-work loop + bound.
3. feature-class path (plan → gate segment) — mostly prompt + template wiring, gates already work.
4. question-class + `answer.md`.
5. UI thread view + composer + canvas badges.
6. failed/rejected entry (FU7) — triage prompt additions.

Each step is shippable; step 1 alone already delivers "reply to a finished run and it continues".
