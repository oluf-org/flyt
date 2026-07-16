# LLM Flow — Design Specification

**Status:** Design specification. Mixes *current reality* with *intended design*. Every subsection is tagged.
**Last defined:** 2026-07-15 (design interview) + code verification against the `flow-builder` state.
**Read alongside:** `PRODUCT-SPEC.md` (why), `DECISIONS.md` (decisions + open questions), `GOALS.md` (principles), `FLOW_LANG.md` / `FLOW_NODES.md` (existing contracts).

> **Legend.** Each section is marked:
> **[BUILT]** — exists and works in the current code.
> **[PARTIAL]** — a real implementation exists but is incomplete or not surfaced to the user.
> **[PLANNED]** — specified here; not implemented.
>
> **Note on `CRITICAL-REVIEW.md`:** that file (dated 2026-07-13) predated the flow-builder work and is **superseded and no longer maintained** — it should be deleted. Several things it called "aspirational or broken" (parallelism, node materialization, restart resilience) are now partially built. This document, together with `PRODUCT-SPEC.md` and `DECISIONS.md`, is the current source of truth.

---

## 1. Foundational principle (unchanged) — [BUILT]

File-based state is the single source of truth. Modules never coordinate in memory; they read and write plain files:

```
nodes/<id>.json                 Node Library template
flows/<id>.flow.yaml            workflow structure (DSL)
flows/<id>.layout.json          canvas positions (app-written sidecar)
runs/<runId>/
  prompt.md                     user request (User Input node content)
  flow.json                     resolved workflow snapshot for this run
  plan.md, tasks.json           planning + executor tasks
  tasks/<id>.md, nodes/<id>.md  per-task / per-node outputs
  retrospectives/*.json         structured retrospective per node
  workspace/                    where agent write_file output lands (see §7)
  meta.json                     stage, per-node status, approvedGates, errors
  log.jsonl                     append-only audit log of every action
```

Everything below must preserve this: new behavior is expressed as files, not hidden state.

---

## 2. Execution engine — [BUILT], with [PLANNED] extensions

One engine: `core/flowRunner.js`. It performs a **dynamic topological walk**: readiness is recomputed after every wave, so nodes created mid-run join the schedule.

Node kinds today:
- `input` / `output` — implicit entry/exit; `output` collects upstream into `result.md`.
- `aiStep` — one `callModel()` with context assembled from upstream outputs.
- `agentTask` — runs through the agent loop (`core/agent.js` → `core/nodes/executor.js`) with tools.
- `orchestrator` — a container that plans and spawns child nodes (see §5).

### 2.1 Parallelism — [DONE]
Independent `aiStep` **and `agentTask`** nodes run concurrently, bounded by `config.maxParallel` (default 4), in both the main walk and the orchestrator's inline sub-walk (V1 task 6, D7 — resolves Q-D1). The scheduler batches ready, side-effect-safe nodes into waves. Still serialized on purpose: `plan-eval` (it rewrites the flow), nodes behind an approval gate, and any task whose node opted into `approveToolCalls` (the gate promise is per-run, so two tasks pausing at once would collide over it).

An `agentTask`'s `runNode` only *queues* a task; the queue then drains through the executor with the same bound. Tasks are **claimed** — `FlowRunner.claimNextTask` flips `pending` → `running` in a synchronous read-modify-write of `tasks.json`, which Node runs to completion before any other continuation, so two concurrent schedulers can never claim the same task. Claiming respects `dependsOn`.

The three hazards this had to clear (`Q-D1`), and how:
- **Readable log under concurrent writers.** `appendLog` uses `appendFileSync` — one synchronous open/append/close, so lines can never interleave or be lost (no locking needed; this is a benefit of the sync-I/O choice in §10). Readability comes from *attribution*: entries carry `node: executor:<taskId>`, so one task's story stays followable while others overlap. `task_claimed`/`task_wave` events record what ran together.
- **Multi-active status.** A claimed task persists `status: 'running'` in `tasks.json`, and per-node status lives in `meta.nodeStatus` — both are maps, so any number of nodes/tasks show active at once. (`meta.currentTaskId` is a legacy single-task signal, kept only for runs recorded before this.) Consistent with the relaxed animation rule (D9).
- **Workspace write interference.** Each write is already atomic (synchronous whole-file writes), so a same-path collision is a clean last-writer-wins, not corruption. What was missing was *visibility*: `core/writeLedger.js` tracks which in-flight task last wrote each path and flags a second concurrent writer to `log.jsonl` (`workspace_write_conflict`) and into the tool record → retrospective → inspector. This is **detection, not isolation** — true isolation (per-task worktrees + merge) is a much larger design decision, and `bash` can write files invisibly to the ledger.

### 2.2 The "feel" policy — [CLARIFIED]
`GOALS.md` previously said "only one element on screen should ever animate at once." **That was a misstatement of intent.** The real goal: animation should be *deliberate and not messy* — avoid a screen full of competing motion — **without an absolute one-animation rule.** When parallel nodes run, showing several as active is correct; the constraint is tasteful, legible motion, not a single spinner. `GOALS.md` has been updated to match.

---

## 3. Context assembly — [PARTIAL] → [PLANNED]

**Today:** `upstreamContext()` concatenates every incoming node's full output. When a node declares a `contextSpec`, the runner builds a *minimal* context from only the declared files/parts (`buildMinimalContext`) — this already implements "use no more context than necessary" when the spec is present. Planning nodes are instructed to emit a `Context files:` section per task with the smallest sufficient context.

**Gap:** without a `contextSpec`, context still balloons — full upstream concatenation. There is no automatic step that *decides* how much context a task needs.

**[PLANNED] — Context Analysis step.** A dedicated (cheap-model) node that runs *before* work and outputs a context strategy, choosing among:
- **none** — task is self-contained (e.g. "write a general utility function"); give no project context.
- **pointers-only** — a list of *candidate files + a one-line rationale each*, plus read tools so the working node fetches only what it actually needs.
- **summarized** — a cheap model summarizes the relevant context instead of passing it raw.
- **full** — pass the content directly (small, clearly-needed context only).

Design intent: make context strategy *data* (a node output), consistent with the file-based philosophy, rather than a hardcoded behavior. Different strategies can be A/B compared. The working node receives file *pointers + descriptions* by default and reads on demand, rather than being handed everything.

---

## 4. Model routing (the multi-model core) — [PARTIAL] → [PLANNED]

**Today:** routing is **static**. `config.json` sets a default `executor` worker and `categoryWorkers` per category (Code design, Code general, documentation, Test-creation). A node template can set its own worker; instances can override per workflow. Everything currently defaults to the `mock` provider.

**[PLANNED] — Routing as policy over a capability matrix.** A matrix maps *(task type / language / complexity / cost ceiling)* → preferred model, seeded and refined by the ranking data from `PRODUCT-SPEC.md` §7.2. Routing policy:
1. **Matrix-first (the ~90% case).** Static rules resolve the obvious calls — known-good language, complexity tier, cost ceiling. Fast, no extra model call.
2. **LLM tiebreaker (the ambiguous case only).** When the matrix is ambiguous, an orchestrator/router model makes the call. It is the *tiebreaker*, not the default — to avoid an expensive routing call on every task.

Example rules the matrix should express: "model X is strong at language Y → prefer X for Y tasks"; "task is trivially simple and model Z is very cheap → always route to Z."

**Design caution:** do not make the router itself an expensive per-task model call. Keep the common path deterministic.

---

## 5. Sub-agents & the orchestrator hierarchy — [PARTIAL] → [PLANNED]

In this app, **a node is an agent.** Spawning a node and spawning an agent are the same act: the new node/agent gets its own *limited context* scoped to its single task.

**Today [PARTIAL]:**
- `plan-eval` can **materialize new nodes mid-run**; they are written into the run's `flow.json` with provenance and join the topological walk.
- The **`orchestrator` node** is a real container: one autonomous planning call decides a set of child nodes, materializes them *inside the box* (`parentId` + `managedBy`), runs an inline sub-walk over them (same wave/parallel semantics, bounded by `maxParallel`), and aggregates every child's output into the orchestrator's single `results` output. Downstream nodes see only the orchestrator, not its children. Children already materialized on a prior pass are reused on resume.

**[PLANNED] — the spawning model and its guardrails.** The intended full picture:
- Any orchestrator can spawn **work nodes** (its children), each an agent with its own scoped context.
- To prevent unbounded recursion, orchestration is **two-tier**:
  - An **orchestrator-orchestrator** may spawn **orchestrators**.
  - A **spawned orchestrator may spawn work nodes but NOT further orchestrators.**
  - Net effect: a **depth cap of one orchestrator level** — the infinite-spawn guard.
- Spawned nodes should appear on the canvas **live**, and (design decision, see open questions) may carry their own approval gates and emit their own retrospectives like any other node.

**[PLANNED] — additional guards to define:** besides the depth cap, a **budget** (token/cost) ceiling and/or a total-node ceiling per run, so a misbehaving orchestrator can't fan out without bound. Not yet designed.

---

## 6. Streaming & live output — [PARTIAL] → [PLANNED]

**Today:** the adapter layer already supports streaming. `callModel({ ..., onText })` is defined so streaming adapters call `onText(fullAccumulatedText)` after each chunk (full text, not deltas, so a mid-stream retry is always a consistent prefix). **But `onText` is not consumed** by the runner/executor/UI — output appears only when a node completes. With the mock provider this is masked by deliberate latency + edge animation ("good theater"); with real models it means minutes of apparent silence.

**[PLANNED] — surface streaming in v1.** Token streaming is a **v1 requirement**, not later polish. Intended UX:
- A **sidebar showing the latest streaming update** (the currently-working node's live output).
- **Future:** a *status sidebar* that runs a summarizer over *all* currently-active nodes, giving a running digest of everything in flight during parallel execution.

Wiring: consume `onText` in the executor/runner → write incremental `nodes/<id>.md` → push to the renderer. The IPC side of this is done: pushes are incremental (§10), so a streaming chunk ships only the changed node's output rather than the whole run.

---

## 7. The Toolbox — [PARTIAL] → [PLANNED]

**Today [PARTIAL]:** a real tool registry exists (`core/tools/index.js`): a tool is `{ name, description, parameters (JSON Schema), run(args, ctx) }`; `ctx = { store, runId, taskId, defaultWorker }` gives sandboxed access to the run's files; every call is validated and logged to `log.jsonl`. Registered tools:
- `write_file` — writes into `runs/<runId>/workspace/` only; path traversal rejected.
- `create_task`, `write_task_md` — task spawning / task-output authoring.

The agent loop (`core/agent.js`) runs tools two ways: **NATIVE** (OpenRouter function-tool calling when `worker.supportsTools`) and **TEXT** (a fenced ```` ```tool ```` block protocol, used by mock and non-tool models). Iteration cap: 8.

**[PLANNED] — Toolbox as a first-class page.** A creation suite, peer to the Nodes page:
- **View and author custom tools** in-app (not only in code).
- Ship the core coding-agent tools: **`read_file`, `create_file`, `write_file`, and likely `bash`/shell.**
- Support **user-defined tools** — e.g. arbitrary HTTP GET requests as a tool, and basic computer-control primitives.
- "Transparent" = tool creation/usage is visible and logged; "extensible" = a user can add capabilities without touching source.

---

## 8. Workspace binding — [PLANNED]

**Today:** there is **no** binding to a user's real project. `write_file` writes land in `runs/<runId>/workspace/` — a per-run scratch area, *not* the user's repo. So the coding-agent loop does not yet operate on real code.

**[PLANNED] — target workspace + project config.**
- On use, the app is **given a target workspace** (a project folder). Runs operate against it: reads, creates, writes, and (planned) shell commands act on the real project.
- **Per-project configuration lives in a `.llmflow/` folder inside the project** (not in appdata) — so it travels with the repo and is version-controllable/shareable.
- **Binding model (to define):** a workflow template is reusable across workspaces; the *workspace* is selected at run time, not baked into the workflow. Confirm and specify.

---

## 9. Safety model — [PLANNED]

A coding agent with `write_file` + `bash` against a real workspace has real blast radius (destructive commands, mass deletes, network exfiltration). Intended layers, mirroring norms from existing agent tools with the ability to opt out:

- **Human approval gates** — per-node (`requiresApproval`), already the default oversight mechanism. **[BUILT]**
- **Sandboxing / path confinement** — writes confined to the workspace; today they're confined to the run's own workspace dir (§7). Extend to a confined-but-real workspace with path-traversal rejection. **[PARTIAL]**
- **Opt-out** — approvals and sandboxes should be *skippable* by choice, for speed, at the user's risk. **[PLANNED]**
- **Command-guard evaluator node** — a dedicated evaluator model, running as its own node, that inspects commands (especially shell) for danger before they execute. Because it's a node, its verdict is a logged, inspectable artifact. **[PLANNED]**

**Open items:** command allowlist/denylist, dry-run/diff preview before writes land, network policy for HTTP tools, and what "skip safety" is allowed to reach.

---

## 10. Known architectural tensions to design around

Carried forward (some from `CRITICAL-REVIEW.md`, re-validated):

- **Full-snapshot IPC — [RESOLVED]** (V1 task 5, resolves Q-D7). Mutations no longer push the whole run snapshot. `electron/main.js` keeps the last snapshot it sent per run plus a monotonic `rev`, and pushes only a diff (`core/snapshotDiff.js`): whole-value fields (`meta`/`prompt`/`plan`/`tasks`/`flow`) replace when changed, while the growing maps (`nodeOutputs`/`taskOutputs`/`retrospectives`) diff per entry — so a streaming flush ships one node's markdown. The renderer applies patches onto the snapshot it fetched via `run:snapshot`; a `rev`/`base` mismatch (e.g. a push missed during a run switch) triggers a resync. Because each patch is "current minus baseline", applying it to any state at/after that baseline converges.
- **Synchronous filesystem.** `RunStore`/`FlowStore` use sync I/O. Fine for small runs; a liability under many concurrent tool calls (§2.1) and large files. Changing it is a philosophical shift, so decide deliberately.
- **Restart resilience — [DONE for completed steps]** (V1 task 7, D17 near-term). Completed steps survive the app dying and are never redone. At startup nothing is live yet, so any run left in a non-terminal stage was cut off: `FlowRunner.reconcileInterrupted` flags it `meta.interrupted` and **rewinds** what was mid-flight — node statuses that aren't `done` go back to `pending`, and tasks stuck at `running` return to the queue (including agent-spawned ones with no node). The rewind happens at *reconcile*, not resume, so a reopened run reads honestly: nothing spins, because nothing is running. Resuming is an **explicit user action** (a Resume button in the run view, `run:resume`) — the app never re-runs bash/file tools against a real repo on launch without the user deciding to. `execute(resume)` rebuilds `completed` from `meta.nodeStatus`, so the walk continues from exactly where it stopped. Liveness is tracked in `FlowRunner.live` (process state, not file state — which is precisely what a crash destroys), so a running run can never be resumed from underneath itself.
  Still fragile by design (post-V1): a gate pending *at the moment of restart*. A pre-node/escalation gate recovers (approve/reject → `resumeFromGate`), but a **tool** gate is abandoned honestly — its call stack died with the app, so the task is failed rather than pretending the call can be approved.
- **Canvas at scale.** Manual layout, new node/edge arrays per update, no memoization. Fine for small graphs (the stated scope); revisit before large graphs or heavy inspector content.

---

## 11. Built-vs-planned summary

| Area | State | Notes |
|---|---|---|
| File-based state, RunStore/NodeStore/FlowStore | BUILT | Single source of truth |
| Node Library + Nodes page (9 templates) | BUILT | Template/instance/override model |
| Canvas (React Flow), Inspector, run panel, Settings | BUILT | Canvas is authoring + run view |
| Flow DSL (`.flow.yaml`), lint/parse/serialize/migrate/CLI | BUILT | See `FLOW_LANG.md` |
| One engine, dynamic topological walk | BUILT | `core/flowRunner.js` |
| Parallel `aiStep` + `agentTask` execution (`maxParallel` 4) | BUILT | Atomic task claiming; gated tasks stay solo (§2.1) |
| Mid-run node materialization | BUILT | `plan-eval` + orchestrator spawn nodes |
| Orchestrator node (spawns children, inline sub-walk) | PARTIAL | Seed of sub-agents; no depth/budget guard yet |
| Agent loop + tool registry (native + text) | BUILT | `write_file`, `create_task`, `write_task_md` |
| Adapters (mock/anthropic/openrouter), retry/backoff | BUILT | Default = mock |
| Streaming (`onText` contract) | PARTIAL | Adapter-ready; not surfaced in UI |
| Retrospectives + `historyDigest` | BUILT | One-way into planning today |
| Approval gates + restart resume | BUILT | Completed steps survive a crash; explicit Resume (§10). Pending *tool* gates still abandon |
| Two-tier orchestrator depth guard | PLANNED | Design rule; not enforced in code |
| Model routing matrix + LLM tiebreaker | PLANNED | Today: static `categoryWorkers` |
| Context Analysis step (cheap-model strategy) | PLANNED | `contextSpec` honored when present |
| `read_file` / `create_file` / `bash` tools | PLANNED | Only `write_file` (run-scoped) today |
| Toolbox creation page (user-authored tools) | PLANNED | Registry exists in code only |
| Real workspace binding + `.llmflow/` config | PLANNED | Writes are run-scoped, not repo |
| Safety: command-guard node, opt-out, diff preview | PLANNED | Approvals + run-scoped sandbox today |
| Model comparison / ranking mode | PLANNED | Feeds routing matrix |
| Streaming status-summary sidebar | PLANNED | After single-node streaming |
| AI-helper workflow builder + view mode | PLANNED | Canvas is manual today |
| Subscription / capped-key backend | PLANNED | BYO key today |
| Packaging / distribution | NOT STARTED | Explicitly not on radar |

---

## 12. Open questions (design)

Consolidated in `DECISIONS.md`; summarized here:

1. ~~**Parallel agentTasks:** how to run tool-using tasks concurrently with a readable log, correct multi-active status, and workspace write-isolation.~~ **Resolved** (V1 task 6) — see §2.1. Note the write hazard landed as *detection*, not isolation.
2. **Spawn guards beyond depth:** budget/node-count ceilings; whether spawned nodes get their own gates and retrospectives.
3. **Context strategy selection:** who runs the analysis step, what model, and how "none/pointers/summarized/full" is chosen and represented.
4. **Routing matrix schema:** exact axes (task type, language, complexity, cost) and how ranking data updates it.
5. **Workspace binding:** run-time selection vs. workflow-bound; `.llmflow/` contents and schema.
6. **Safety envelope:** allowlist/denylist, diff preview, network policy, and the limits of "skip safety."
7. ~~**Streaming vs. snapshot IPC:** incremental update path so streaming doesn't re-send the whole snapshot.~~ **Resolved** (V1 task 5) — see §10.
8. **Retrospective loop scope:** keep narrow (which model wins which task type → routing) vs. broader adaptation.
