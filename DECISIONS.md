# LLM Flow — Decisions Log

**Purpose:** Capture the decisions made during the 2026-07-15 design interview, and collect every unresolved question in one place. This is the "why we chose it" companion to `PRODUCT-SPEC.md` (what) and `DESIGN-SPEC.md` (how).

Each decision: **Context → Decision → Status.** Status is `Decided`, `Provisional` (decided for now, may revisit), or `Open` (still to define).

---

## Decisions

### D1 — The project is a coding agent *and* a visual builder, together
**Context.** The prior `CRITICAL-REVIEW.md` posed a fork: (A) reliable inspectable pipeline vs. (B) general visual canvas. A third framing emerged: a coding agent that replaces the Claude Code / Codex chat window.
**Decision.** It is not a choice — the **engine and the canvas work hand-in-hand**; without either, the app falls apart. The product is a coding agent whose *transparency window* is the canvas. The text input is the primary interface; the canvas is the live view into the run.
**Status.** Decided.

### D2 — Core thesis: structure beats raw model power
**Context.** Origin insight from using Fable — the power may be in structured task-handling, not just the model.
**Decision.** The app's reason to exist is to make that structure explicit and, ideally, *demonstrable* (same model: decomposed vs. single prompt).
**Status.** Decided (as thesis). Demonstration feature is Open (see Q-P3).

### D3 — The differentiator is mastery/control, not speed/cost
**Context.** Won't beat Cursor/Claude Code on speed, cost, or ease of entry.
**Decision.** Compete on the *feeling of mastery and control* — an AI builder that makes the developer feel in command. Customizability serves that feeling.
**Status.** Provisional — direction is set; the concrete, provable user win is Open (Q-P1).

### D4 — Primary interface is text; canvas is the window
**Context.** Ambiguity over whether the canvas is the product or a debug view.
**Decision.** The user describes what they want in text; the canvas is the **live transparency view** of execution, not the primary authoring surface for the everyday user.
**Status.** Decided.

### D5 — Workflow authoring: manual canvas today, AI-helper builder + view mode planned
**Context.** Canvas is the only authoring surface now; DSL is AI-authorable text.
**Decision.** Keep the canvas, add an **AI helper as the builder**, and a distinct **view mode** for runs. Canvas and DSL remain two views of the same file; humans use canvas, AI writes DSL.
**Status.** Provisional (UX undesigned — Q-P5).

### D6 — Workflow selection: curated dropdown, not per-request generation
**Context.** The DSL being AI-authorable raised the option of generating a workflow per request.
**Decision.** For now, **pick a workflow from a dropdown.** AI *choosing* or *reconfiguring* a workflow from templates is a future possibility, explicitly not v1.
**Status.** Decided (v1); future extension Open.

### D7 — Parallelism is a v1 requirement
**Context.** Independent `aiStep` nodes already ran in parallel (`maxParallel` 4); executor/agentTasks were still sequential.
**Decision.** Parallelism is **required**, both because of the capability it unlocks and because it underpins agents spawning other agents mid-run. Extending it to agentTasks is the key upgrade.
**Status.** Decided — **done** (V1 task 6; Q-D1 resolved). agentTasks run bounded-parallel in the main walk and inside orchestrators, via atomic task claiming. See `DESIGN-SPEC.md` §2.1.

### D8 — Sub-agents = spawned nodes; two-tier orchestrator depth cap
**Context.** "Agents spawning agents" mid-run. Orchestrator nodes already spawn children.
**Decision.** A node *is* an agent with its own scoped context. Guard infinite spawning with a **two-tier rule**: an orchestrator-orchestrator may spawn orchestrators; a spawned orchestrator may spawn only work nodes, not further orchestrators → **one orchestrator level deep.**
**Status.** Decided (the rule). Budget/node-count guards and gate/retrospective behavior for spawned nodes are Open (Q-D2).

### D9 — The "one animation at a time" rule is relaxed
**Context.** `GOALS.md` says only one element should animate at once — which conflicts with showing parallel work.
**Decision.** Intent is **deliberate, non-messy** animation, *not* an absolute single-animation rule. Parallel active nodes may all animate. Update `GOALS.md`.
**Status.** Decided — applied to `GOALS.md`.

### D10 — Streaming is a v1 requirement
**Context.** Adapters support `onText` streaming; the UI doesn't consume it, so real-model runs look idle.
**Decision.** Ship **token streaming in v1** — a sidebar showing the latest update; later, a status sidebar that summarizes all active nodes.
**Status.** **Done** (V1 task 8). The runner consumes `onText` into the run's own artifact files and the live panel shows the working node's output; the agentTask/executor path streams too, so the coding loop is watchable. The status-summary-over-all-active-nodes sidebar stays post-V1. See `DESIGN-SPEC.md` §6.

### D11 — Context via an explicit analysis step
**Context.** `upstreamContext()` over-concatenates unless a `contextSpec` is set.
**Decision.** Add a **cheap-model Context Analysis step** that chooses among **none / pointers-only / summarized / full**, defaulting to giving *file pointers + descriptions + read tools* rather than raw content. "No context" is a legitimate output.
**Status.** Provisional (approach agreed; mechanism Open — Q-D3).

### D12 — Routing = matrix-first, LLM as tiebreaker
**Context.** Routing is static `categoryWorkers` today; the multi-model story needs more.
**Decision.** Route via a **capability matrix** (task type / language / complexity / cost) for the common case; escalate to an **LLM router only when the matrix is ambiguous** — never an expensive routing call per task.
**Status.** Provisional (schema Open — Q-D4).

### D13 — Retrospective loop scoped to model-ranking → routing
**Context.** "Self-improving from retrospectives" was over-claimed in older docs.
**Decision.** Keep retrospectives, but the honest adaptive loop is narrow: **which model wins which task type**, feeding the routing matrix (D12). Ranking → routing → better ranking. Not general self-improvement.
**Status.** Provisional (recommendation accepted in interview; confirm scope — Q-D8).

### D14 — Toolbox is a first-class creation page
**Context.** A tool registry exists in code (`write_file`, `create_task`, `write_task_md`).
**Decision.** Build a **Tools page** (peer to Nodes) to *view and author* tools, including `read_file`/`create_file`/`bash` and user-defined tools (HTTP requests, computer-control primitives). This is the app's capability-extensibility surface.
**Status.** Decided (intent); scope/UX Open.

### D15 — Real workspace binding; config in `.llmflow/` in the project
**Context.** `write_file` currently writes to `runs/<runId>/workspace/`, not the user's repo.
**Decision.** The app is given a **target workspace**; per-project config lives in a **`.llmflow/` folder inside the project** (version-controllable), not appdata.
**Status.** Decided (location); binding model (run-time vs. workflow-bound) Open (Q-D5).

### D16 — Safety: reuse agent-tool norms, opt-out, plus a command-guard node
**Context.** `write_file` + `bash` on a real repo is dangerous.
**Decision.** Layer **approvals + sandbox/path-confinement**, make them **skippable by choice**, and add an **evaluator node that guards dangerous commands** (its verdict is a logged artifact).
**Status.** Provisional (envelope Open — Q-D6).

### D17 — Restart resilience: preserve completed steps now, full resilience later
**Context.** Gates are an in-memory Map, but `meta.approvedGates` persists and resume logic exists.
**Decision.** Near-term: ensure **completed steps survive an app restart.** Fuller crash/restart resilience for pending gates is a later goal.
**Status.** Decided — near-term half **done** (V1 task 7). Interrupted runs are detected at startup and resumed by an explicit **Resume** action; completed nodes are kept and never re-executed. Resuming stayed a user action rather than automatic, so a crash can't make agent tool calls hit a real repo on launch — consistent with the approvals-first posture of D16. Pending *tool* gates still abandon honestly; that's the "later goal" half. See `DESIGN-SPEC.md` §10.

### D18 — Business model: BYO key now, capped-key subscription at ship
**Context.** Users add their own OpenRouter/Anthropic key today.
**Decision.** Keep **bring-your-own-key** near term. At ship, a **~$20/month subscription issues a key capped at ~$20 of OpenRouter spend** — bounding inference cost by construction.
**Status.** Provisional (mechanics Open — Q-P4).

### D19 — Distribution is not on the radar
**Context.** No packaging config; version `0.1.0`.
**Decision.** Installers, code-signing, auto-update are **explicitly deferred.**
**Status.** Decided (deferred).

### D20 — Documentation structure
**Context.** This grilling exercise.
**Decision.** Three docs — `PRODUCT-SPEC.md`, `DESIGN-SPEC.md`, `DECISIONS.md` — with a dedicated Open Questions section in each. `CRITICAL-REVIEW.md` is stale (2026-07-13) and should be retired or re-dated; `GOALS.md` needs the D9 correction.
**Status.** Decided.

---

## Open questions (consolidated)

**Product (from `PRODUCT-SPEC.md` §10):**
- **Q-P1.** Sharpen the differentiator: what concrete, demonstrable win over Cursor/Claude Code does "mastery and control" cash out to?
- **Q-P2.** What ease-of-entry (quick/cheap/easy-to-start) bar must the app clear to survive, and how is it measured?
- **Q-P3.** Is a decomposed-vs-single-prompt comparison mode a v1 feature or a research aside?
- **Q-P4.** Subscription mechanics: key issuance, metering, cap-exhaustion mid-run, abuse prevention.
- **Q-P5.** What does the "AI helper as builder" authoring UX look like, and how does it relate to view mode?

**Design (from `DESIGN-SPEC.md` §12):**
- ~~**Q-D1.** Parallel `agentTask`/executor execution: readable concurrent log, multi-active status, workspace write-isolation.~~ **Resolved** (V1 task 6): atomic task claiming + bounded parallel drain; log safe by sync append + per-task attribution; status via persisted `running` + `nodeStatus`. The write hazard landed as **detection** (`core/writeLedger.js` flags concurrent same-path writes), not isolation — per-task worktrees remain post-V1.
- **Q-D2.** Spawn guards beyond depth (budget/node-count); do spawned nodes get their own gates and retrospectives?
- **Q-D3.** Context Analysis step: which model runs it, how the none/pointers/summarized/full choice is made and represented.
- **Q-D4.** Routing matrix schema: exact axes and how ranking data updates it.
- **Q-D5.** Workspace binding: run-time selection vs. workflow-bound; `.llmflow/` contents/schema.
- **Q-D6.** Safety envelope: allowlist/denylist, diff preview before writes, network policy, limits of "skip safety."
- ~~**Q-D7.** Streaming vs. snapshot IPC: incremental update path so streaming doesn't re-send the whole snapshot.~~ **Resolved** (V1 task 5): diffed pushes via `core/snapshotDiff.js`; see `DESIGN-SPEC.md` §10.
- **Q-D8.** Retrospective loop scope: confirm narrow (ranking→routing) vs. broader adaptation.

---

## Suggested next actions

1. ~~Apply the D9 correction to `GOALS.md` (relax the one-animation rule).~~ **Done** — `GOALS.md` principle text and NFR updated.
2. Retire `CRITICAL-REVIEW.md` — it is superseded by `DESIGN-SPEC.md`/`DECISIONS.md`. **Action still required: delete the file manually** (it is marked superseded in the docs but not yet removed from the repo).
3. Also completed (2026-07-15 doc pass): aligned the stale format references in `README.md`, `GOALS.md`, and `FLOW_NODES.md` to `flows/<id>.flow.yaml` + `.layout.json`, and corrected `REFACTOR-PLAN.md` (custom parser/validator, no `yaml`/`ajv` dependency).
4. Prioritize the v1-critical planned items: real workspace binding + file/bash tools (D14, D15), parallel agentTasks (D7), and streaming UI (D10) — these three are what turn the scaffolding into a daily-use coding agent.
4. Work the Open Questions down, promoting each from Open → Provisional → Decided here as they're resolved.
