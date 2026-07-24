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
**Status.** **View mode done** (V1 task 9) — run header with progress/elapsed, the run form collapsing while watching, run-time-spawned tasks drawn on the canvas, and the outcome surfaced on completion; see `DESIGN-SPEC.md` §6.1. The **AI-helper builder** remains Provisional and out of V1 (UX undesigned — Q-P5).

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
**Status.** Provisional (mechanics Open — Q-P4). The BYO-key path itself is **validated** (V1 task 11): both acceptance flows run end to end on a real OpenRouter key, and five bugs that had made it silently unreliable are fixed — see `DESIGN-SPEC.md` §4.1. Anthropic BYO-key remains env-var-only (no Settings field).

### D19 — Distribution is not on the radar
**Context.** No packaging config; version `0.1.0`.
**Decision.** Installers, code-signing, auto-update are **explicitly deferred.**
**Status.** Decided (deferred).

### D20 — Documentation structure
**Context.** This grilling exercise.
**Decision.** Three docs — `PRODUCT-SPEC.md`, `DESIGN-SPEC.md`, `DECISIONS.md` — with a dedicated Open Questions section in each. `CRITICAL-REVIEW.md` is stale (2026-07-13) and should be retired or re-dated; `GOALS.md` needs the D9 correction.
**Status.** Decided.

### D21 — Follow-up turns: a finished run is re-openable and its flow grows (FU1–FU10)
**Context.** A run reaching a terminal stage ended the conversation; feedback meant a new run with no context. The full decision series (FU1–FU10) was recorded 2026-07-17 in `FOLLOWUP-PLAN.md`, retired after implementation (git history).
**Decision.** Implemented as designed: `FlowRunner.followUp(runId, text)` accepts a reply at any terminal stage (done/failed/rejected). A triage call classifies it — `question` (answered in place, `followups/<n>/answer.md`), `fix` (1–2 executor nodes), or `feature` (plan → gated plan-eval → stitch segment) — and the continuation subgraph is appended to the run's `flow.json` behind a visible `fu<n>-input` node carrying the feedback. Completed nodes are never re-run; prior outputs reach new nodes via edges only. A `feedback-review` node closes every turn (`solved` | `more-work`, bounded to 2 extensions, then the human escalation gate). Failed/rejected runs retire their unfinished path as `skipped` and route around it. Every turn snapshots `flow.json`/`meta.json` to `followups/<n>/before/` first. One turn at a time.
**Status.** Decided & implemented (engine + parsers + thread UI/composer + canvas turn badges; tests in `tests/followup.test.js`). Deferred by decision, not forgotten: **Q-FU1** collapse-by-turn UI for long multi-turn runs; **Q-FU2** edit/delete a follow-up turn; **Q-FU3** multi-feedback batching (reply while running).

### D22 — Project tabs: data model, architecture, and UX (T1–T19 resolved)
**Context.** Tabs A (baseline strip) + D (deck switcher) were in scope of the polish plan's Phase 4 (plan retired after implementation). The app had no project entity — `flows/`, `runs/`, `nodes/` were single global directories, and a workspace folder bound per run. The T1–T19 option space was enumerated in `TABS-DECISIONS.md` (retired; this entry is the authority, the reasoning record survives in git history); this entry resolves the Phase 4.0 gate set (2026-07-19).

**Decisions.**
- **T1 — A project IS a workspace folder.** Tab = folder, like tab = site. `.llmflow/` inside it is its config (D15).
- **T2 — Runs become per-project; flows and Node Library templates stay global for v1.** A flow is reusable expertise, a run is meaningless without its workspace. Templates keep the GOALS.md skills split (template names a skill; the project supplies `.llmflow/skills/`).
- **T2a — Storage location is a Settings choice, not a hardcode** *(owner call, 2026-07-19)*. A `projectStorage` setting on the Settings page selects where the app writes per-project files: **`workspace`** (default) = `.llmflow/runs/` etc. inside the repo, with an auto-written `.llmflow/.gitignore` so artifacts never enter version control; **`appdata`** = under userData keyed by project path, repo untouched. Applies to all per-project files the app creates, now and in the future. Read at project-open time; a per-project override may come later.
- **T3 — Existing globals become the implicit "default project".** Today's app-root `flows/`/`runs/`/`nodes/` are the unbound scratch tab's data; nothing migrates. Unbound tabs are allowed (the default project is one); a tab may bind a folder but doesn't have to.
- **T5 — Same folder twice → focus the existing tab** (VS Code model). RunStore's per-directory lock makes two live stores on one runs/ dir a real hazard.
- **T6 — Single renderer; tab switch swaps a per-tab state bundle.** No WebContentsView-per-tab: the app is one React tree over file-backed state, so process isolation buys little and costs the shared Settings/theme surfaces.
- **T7 — Every IPC call takes a `projectId`; pushes carry it; the renderer drops non-matching pushes** (the same guard shape as the existing `snapRef` rev-matching). Background projects keep executing (main process owns runs) and resync on activation.
- **T8 — The per-tab bundle is:** active section, activeFlowId, activeRunId, snapshot, selectedNode, undo/redo stacks, run-panel input + workspaceDir, flowViewMode, run-view mode + replay state, canvas viewport, newRunOpen. **Global:** theme, Settings modal, models list, templates, flows list (global data per T2). The debounced autosave flushes on tab switch, exactly as it does on section switch.
- **T13 — Closing a tab with a live run keeps the run executing.** The engine is main-process; closing a view must not kill work. Reopening the project (recents / restore) shows the run again; the close is confirm-free because nothing is lost.
- **T14 — Ctrl+Tab / Ctrl+Shift+Tab cycle tabs (hold ≥150ms opens the deck, per 4.2); Ctrl+1..9 STAY on sections.** Tabs get no number shortcuts in v1. Ctrl+T/Ctrl+W are deferred (Ctrl+W's close-window collision decides against it for now).
- **T17 — Session restore is browser-style:** reopen previous tabs + active tab from `settings.json`, restoring each tab's folder plus its last section/flow/run selection (T8 depth, best-effort). A folder missing at restore drops its tab from the strip with a notice; its recents entry stays.

**Riding defaults (explicitly not gated):** T4 per-project settings deferred — API keys and worker config stay global. T9 follows T7 (background runs execute; streams push only to the active project; resync on switch). T10/T11/T12/T15 follow demo A as specced in Phase 4.1 (strip in the titlebar; folder-name label, unsaved dot, live-run micro-indicator, hover ×, middle-click close, drag reorder, ＋ → recents/folder-picker page, Chrome-style shrink-then-scroll). T16 window title `<project> — LLM Flow`; drag-tab-out-to-new-window out of scope for v1. T18 project identity = absolute path for v1. T19 the run panel's workspace picker disappears in bound tabs (runs target the tab's folder) and remains only in unbound tabs.

**Status.** Decided & implemented (2026-07-19): `core/projects.js` registry (per-project `RunStore`/`FlowRunner`, T2a storage resolution, T17 persistence; tests in `tests/projects.test.js`), projectId-scoped IPC + active-only diffed pushes with a per-project activity channel, per-tab state bundling in `App.jsx`, `TabStrip.jsx` strip + new-tab page, `TabDeck.jsx` Ctrl+Tab deck, T2a Settings UI.

### D23 — Provider auth: delegate to vendor CLIs; ToS feasibility decides the provider list
**Context.** Multi-provider support raised how to authenticate each provider (`PROVIDERS-PLAN.md` §0, `SUBSCRIPTION-AUTH-GUIDE.md`; both plans now retired/shipped).
**Decision.** Never reimplement a vendor's OAuth — delegate authentication to the vendor's own CLI/SDK (Claude Code, Codex CLI). ToS feasibility verdicts: Claude and GPT *subscription* login dropped (subscription tokens are restricted to the vendor's own first-party clients); Kimi-Code subscription key allowed. Dropped options stay visible in the UI as disabled entries with the reason, so the user learns why rather than wondering where the button went.
**Status.** Decided & implemented (`core/adapters/claudeCode.js`, `codexCli.js`, `cliDelegate.js`, `SUBSCRIPTION_PROVIDERS` in `core/modelSource.js`; tests in `tests/subscription.test.js`). The underlying OAuth/ToS research is kept in `SUBSCRIPTION-AUTH-GUIDE.md`.

### D24 — Flow DSL is zero-dependency
**Context.** Choosing a YAML/validation stack for the `.flow.yaml` DSL (retired `REFACTOR-PLAN.md`).
**Decision.** Hand-written strict-subset YAML parser + custom validator instead of `yaml`/`ajv`, to keep the dependency footprint at zero.
**Status.** Decided & implemented (`core/flowlang/`). Living spec: `FLOW_LANG.md`.

### D25 — The lander is the home of every tab (L1–L6)
**Context.** With tabs = projects (D22), each tab needed a home surface (retired `LANDER-PLAN.md`).
**Decision.** The lander is the home of every tab, and its chat prompt is the tab's primary input; the chat unfolds into the live canvas on submit. App-open auto-creates an appdata project so there is no empty scratch state, and the old unbound scratch tab is retired — every tab is a project.
**Status.** Decided & implemented (`src/Lander.jsx`, `src/Constellation.jsx`, `core/projects.js`). Deferred stretch: the dot-morph unfold (constellation dots gliding to the real workflow's node positions on submit); the crossfade shipped instead — revisit only if the crossfade feels flat.

### D26 — Visual polish constraints: the anti-ideas list
**Context.** `DESIGN-POLISH-IDEAS.md` (now retired) enumerated techniques; a few were explicitly rejected, and the rejections are standing constraints on future work.
**Decision.** Never ship: large-area `backdrop-filter`, animated mesh gradients, 3D tilt, or skeleton shimmer — file-based state loads instantly, so shimmer would be fake latency theater. Because Electron pins the Chromium version, the app may use the newest CSS (oklch, `light-dark()`, `field-sizing`, anchor positioning, scroll-driven animations) years before the open web. The Tier 3 ideas (depth model, heartbeat chrome, zoom-level-of-detail canvas, command palette) are rejected as out of scope.
**Status.** Decided (constraints are permanent). The polish work itself (phases 0–4 of the retired `POLISH-IMPLEMENTATION-PLAN.md`) is fully implemented.

### D27 — One run-configuration primitive: the per-node override map
**Context.** Modes, run inputs, configs, and comparison looked like four separate features (retired `MODES-COMPARE-PLAN.md`; `CONFIGS-COMPARE-DESIGN.md`).
**Decision.** All four reduce to *a per-node override map applied at run start*. Precedence: **run input > mode > node override > template**. Comparison is a relationship between two runs, not a composer mode — the diff is computed from the runs' own snapshots, so it stays accurate even if the flow and its modes have been edited twenty times since. The judge is blind to contestant identity: a judge that knows the contestants grades the contestants, not the work.
**Status.** Decided & implemented (`core/judge.js`, `compare:begin/save/list` IPC, `src/CompareRun.jsx`, `src/ConfigsPanel.jsx`). Open remainder: P4 sweeps — see `CONFIGS-COMPARE-DESIGN.md` Part 4.

---

## Open questions (consolidated)

**Product (from `PRODUCT-SPEC.md` §10):**
- **Q-P1.** Sharpen the differentiator: what concrete, demonstrable win over Cursor/Claude Code does "mastery and control" cash out to?
- **Q-P2.** What ease-of-entry (quick/cheap/easy-to-start) bar must the app clear to survive, and how is it measured?
- **Q-P3.** Is a decomposed-vs-single-prompt comparison mode a v1 feature or a research aside?
- **Q-P4.** Subscription mechanics: key issuance, metering, cap-exhaustion mid-run, abuse prevention.
- **Q-P5.** What does the "AI helper as builder" authoring UX look like? *(Half answered: view mode is built and defined — `DESIGN-SPEC.md` §6.1 — so the remaining question is the builder itself and how it hands off to that view.)*

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
2. ~~Retire `CRITICAL-REVIEW.md`~~ **Done** — the file is no longer in the repo.
3. Also completed (2026-07-15 doc pass): aligned the stale format references in `README.md`, `GOALS.md`, and `FLOW_NODES.md` to `flows/<id>.flow.yaml` + `.layout.json`, and corrected the flow-DSL plan (custom parser/validator, no `yaml`/`ajv` dependency — D24).
4. ~~Prioritize the v1-critical planned items: real workspace binding + file/bash tools (D14, D15), parallel agentTasks (D7), and streaming UI (D10).~~ **Done** (V1 tasks 1–12; see D7, D10, D17, D18).
5. 2026-07-22 doc cleanup: retired the fully-implemented plans `V1-PLAN.md`, `REFACTOR-PLAN.md`, `MODES-COMPARE-PLAN.md`, `FOLLOWUP-PLAN.md`, `POLISH-IMPLEMENTATION-PLAN.md`, `PROVIDERS-PLAN.md`, `TABS-DECISIONS.md`, `DESIGN-POLISH-IDEAS.md`, and `LANDER-PLAN.md`. Their decisions are folded into D21–D27; the full text survives in git history. Remaining known gaps: README still doesn't mention modes/refiner/compare (MODES-COMPARE T14); the LANDER dot-morph stretch (D25); P4 sweeps (D27).
6. Work the Open Questions down, promoting each from Open → Provisional → Decided here as they're resolved. Current active plan: `OUTPUT-VIEW-PLAN.md`.
