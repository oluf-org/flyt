# LLM Flow — Goals & Architecture

**Project:** llm-flow  
**Status (as of 2026-07-13):** Early MVP (3 git commits total)  
**Primary audience:** Future AI agents and human contributors. **Read this file first.**

> **One-sentence vision:**  
> An Electron desktop application that lets people visually author, inspect, and execute multi-model AI orchestration workflows on a live flowchart canvas, with radical transparency achieved through a file-based single source of truth.
>
> **For the flowchart / custom flows:** See `FLOW_NODES.md` for the documented standard example nodes (plan-start, plan-eval, categorized template work nodes, stitch, final-eval, …) and the intended reflective planning pattern that lets AI safely create and categorize nodes.

---

## Non-Negotiable Principles

These are the soul of the project. Any proposed change should be judged against them:

1. **File-based state is the single source of truth.**  
   Every stage (planner, router, executor tasks, verifier, aiSteps, etc.) communicates **only** by reading and writing plain files under `runs/<runId>/` (prompt.md, plan.md, tasks.json, tasks/*.md, nodes/*.md, retrospectives/*.json, result.md, log.jsonl, flow.json, meta.json).  
   No hidden in-memory coordination between modules. This enables inspectability ("Open run folder"), reproducibility, resumability in principle, and auditability.

2. **Human oversight by default.**  
   There is an approval checkpoint after planning. Custom flows support per-node `requiresApproval`. The UI makes the current stage, errors, and artifacts obvious.

3. **Model-agnostic and multi-model by design.**  
   Different workers (provider + model) can be assigned per classic stage or per custom node. Adapters live in `core/adapters/`. The system must not assume a single model or provider.

4. **Self-describing artifacts.**  
   Tasks carry `goal`, `inputs`, `constraints`, `dependsOn`, `worker`. Every node emits a structured retrospective before the pipeline/flow advances. History from prior retrospectives can inform future planning (`historyDigest`).

5. **Inspectability > convenience.**  
   "Open run folder" is a first-class action. Artifacts must remain human-readable Markdown/JSON even when produced by LLMs.

6. **Deliberate separation of concerns.**  
   Nodes (planner, router, executor, verifier, aiStep) are independent modules. The classic `Pipeline` and custom `FlowRunner` are separate execution engines that happen to share the same file contract.

7. **Performance, responsiveness, and feel are incredibly important.**  
   See the Quality Attributes section below. Slow AI steps are acceptable; a janky or confusing UI is not.

---

## Current Realization (What Ships Today)

### Two Co-Existing Execution Modes

**1. Classic Linear Pipeline** (the original MVP, still primary for reliability)
- Hardcoded sequence in `core/pipeline.js`:
  `prompt → planning (LLM) → awaiting_approval (human gate) → routing (LLM → tasks.json) → execution (sequential agent tasks with tools) → verification (LLM) → done | failed | rejected`
- Uses the full agent loop (`core/agent.js`) only for executor tasks.
- Retrospectives + history feed only the classic planner today.

**2. Custom Graph Flows** (newer capability)
- User-authored DAGs persisted in `flows/<id>.json`.
- Node types (see `src/flowTypes.js` and the full catalog + contracts in `FLOW_NODES.md`):
  - `input` — user brief (becomes the prompt)
  - `agentTask` — contributes a self-describing task executed by the existing executor (full tools + agent loop)
  - `aiStep` — direct single-shot `callModel` with assembled upstream context (plan/execute/verify/custom roles + advanced roles: plan-start, plan-eval, step-eval, stitch, final-eval)
  - `output` — collects upstream into `result.md`
- **Standard example nodes** (documented in `FLOW_NODES.md`): plan-start, plan-eval, template-based work nodes (categorized Code general / Code design / documentation / Test-creation), step-eval, stitch, final-eval. These are the nodes an AI can pick from or generate. The recommended advanced pattern is the reflective planning + minimal-context + repair loop (Start produces scoped `tasks.md` → Plan-Eval declares parallel/seq + categories + template nodes → work with `contextSpec` → Stitch + evals → Final-Eval that notes differences + reasoning).
- Execution in `core/flowRunner.js`:
  - Topological sort
  - Phase 1: non-task-dependent nodes + agentTask registration
  - Phase 2: run contributed + dynamically created tasks (sequential)
  - Phase 3: downstream nodes that need real task outputs
  - Optional per-node approval gates
  - Materialization of AI-generated nodes (plan-eval can cause nodes to be added to the run's `flow.json`)
- Custom flows can mix user-defined structure with the powerful executor.

The built-in "Linear pipeline" flow visible in the editor is a **read-only emulation**. Running it from the flow editor throws; use the "New run" prompt box instead. This preserves identical behavior for the classic path.

### UI (React + React Flow)

- Dual mode in one window (`src/App.jsx`):
  - Flow editing (palette, drag, connect, inspector fields, autosave, "Run flow")
  - Run viewing (live canvas driven by file snapshots pushed over IPC)
- Canvas: vertical/top-down cards with icons, mono sub-labels (worker or kind), status glyphs (✓ active spinner ⏸ ✕), animated edges only for the active item.
- Sidebar: flows list, new prompt + "Run pipeline", run history, "Open run folder".
- Inspector: shows live file artifacts (plan, tasks, outputs, retrospectives, tool calls) or editable node fields (for flows).
- Theming (light/dark) with native titlebar sync.
- Polish: 240ms theme/status transitions, 140ms micro interactions, single continuous animation policy, reduced-motion support.

### Core Contracts & Implementation Notes

- `core/state.js` (RunStore) — pure sync filesystem contract. All readers/writers go through here.
- `core/flowstore.js` — same philosophy for flow definitions + `builtinLinearFlow()`.
- Every node emits a retrospective via `makeRetrospective()` before advancing.
- Agent tooling (`write_file`, `create_task`, `write_task_md`) is sandboxed to the run's `workspace/`.
- Two agent protocols: native OpenAI tools (when supported) and a text ` ```tool ` protocol.
- Updates: main process pushes full `store.snapshot(runId)` on every meaningful change.

### Maturity & How Long It's Come

- **3 commits total** (baseline linear MVP → flow builder UI + persistence → full graph runner).
- Development visible in `runs/` directories from ~July 9–12 2026.
- Rapid iteration: the file-based contract and retrospective system were present from the first commit. The visual canvas and custom flows were added on top without breaking the original pipeline.
- Current state: functional end-to-end with mock provider (real providers work with keys). Both execution modes can be exercised. Many deliberate "extension points" remain unimplemented (see below).

---

## Node Types & Contracts

(See `src/flowTypes.js`, `FLOW_NODES.md` for the polished example nodes + pattern, `core/flowRunner.js` comments, `README.md` "Contracts every node obeys")

**Classic stages** (for reference): prompt, planner, router, execution (with per-task nodes), verifier.

**Custom flow nodes**:
- Tasks are (or become) fully self-describing.
- `aiStep` nodes receive `USER PROMPT` + labeled upstream outputs via `upstreamContext()`.
- Every executed node (or task) writes a retrospective.
- `dependsOn` and `inputs` are honored for ordering and context.

---

## UI / Interaction Model

- Sidebar navigation between Flows and Runs.
- Canvas is always the source of truth for layout in edit mode (positions persisted).
- Selection drives the inspector.
- Approval bars appear contextually.
- "Save" dot + debounced persistence for flows.
- Everything that can be derived is derived from files (renderer is a pure view).

---

## Quality Attributes (Non-Functional Requirements)

**Performance, responsiveness, and general feel are incredibly important.**

### Stated Intent
> The application must feel crisp and trustworthy even though individual AI steps are slow. The UI must remain interactive (switching views, inspecting past runs, editing other flows) while a run is in progress. Stage and task status must reflect within one animation frame of the underlying file write. Only one element on screen should ever be in continuous motion. File artifacts must remain small enough and human-readable enough that "open run folder" is a first-class debugging experience.

### Current Implementation
**Strengths (intentional):**
- Careful CSS transition policy (see `src/styles.css`).
- Only the active node/edge shows continuous animation (spinner or `animated` edge).
- Debounced (500ms) flow autosave.
- Mock adapter sleeps deliberately so UI progress is visible.
- Full-snapshot push keeps the React side a pure view.
- Reduced-motion media query support.

**Known gaps & risks (documented so future work respects them):**
- No performance budgets or instrumentation.
- Every mutation → full JSON snapshot → IPC → React render + React Flow node/edge recreation.
- Inspector `<pre>` blocks have limited height but can contain large LLM output.
- `upstreamContext` and `snapshot()` re-read files on demand (repeats work).
- All RunStore/FlowStore operations are synchronous (`writeFileSync` etc.). Acceptable on main for orchestration, but large outputs or high tool-call volume can slow stage advancement.
- Graphs are assumed tiny (3–6 nodes). Manual layout only. No virtualization.
- No streaming of partial LLM results to the canvas/inspector.
- Flow approval gates are persisted to `meta.json` (`pendingNodeId` + `pendingGateKind`): approving/rejecting after an app restart resumes the run from file state (completed nodes from `nodeStatus`, agentTask mappings from `flow.json`). Step-eval retry budgets reset on restart (they are bounded either way).
- Task execution (both modes) is strictly sequential even though `dependsOn` exists.

**Observable targets for changes:**
- Adding a run with 15–20 tasks or a 12-node custom flow should not make the canvas or inspector feel laggy.
- Status updates after an IPC `run:update` should be visually immediate.
- The user should be able to browse other runs or edit a different flow while one is executing.
- "Open run folder" must still be useful when outputs are non-trivial.

---

## MVP Scope & Explicit Non-Goals / Deliberate Extension Points

**In scope for MVP (current reality):**
- Classic pipeline + basic custom graph execution with the four node types.
- File transparency, human approval gates, retrospectives, multi-worker assignment.
- Live canvas visualization + basic editing + persistence.
- Mock + OpenRouter + Anthropic adapters.
- Tool use inside executor/agentTasks.

**Explicitly not goals today (or only aspirational):**
- Full general-purpose visual programming (loops, conditionals, sub-flows, data transformation nodes).
- True parallel task execution.
- Streaming LLM output or live token-by-token UI.
- Automatic adaptive re-planning from retrospectives (only `historyDigest` feed exists).
- Restart-resilient long-running flow approvals.
- Large graphs, cost tracking, model A/B testing, auto-layout.
- Database or in-memory alternative to the file contract (philosophical choice).
- Production security / sandboxing beyond current workspace path checks.

**Deliberate extension points (from README and code comments):**
- Replace `pipeline.js` with a general graph walker (partially realized by FlowRunner).
- Parallel execution using `dependsOn`.
- More providers via `adapters/index.js#registerProvider`.
- Retrospective-driven modules that rewrite plans/tasks.
- Richer editing surface on the canvas.

---

## How to Keep This Document Alive

- Update the "Status (as of ...)" line and add a short "Last verified against <short-sha>" note on significant changes.
- Any edit to `core/{state,flowRunner,pipeline,flowstore}` or the canvas execution/visualization paths should prompt a review of the relevant sections.
- For future AI work: the first instruction should be "Read GOALS.md in full before making any changes or suggestions."

---

## Quick Start for Humans & Machines

```sh
npm install
npm run dev          # hot-reload Vite + Electron
# or
npm start
```

Use the mock provider (default) for exploration. Edit `config.json` or use the in-app Settings for real models.

The filesystem under `runs/` and `flows/` is the best documentation of what the system actually does.

---

*This document exists so that future AI models (and humans) have clear, stable context about intent, constraints, and non-functional priorities — especially performance, responsiveness, and feel.*
