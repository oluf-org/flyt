# LLM Flow

**Read [GOALS.md](./GOALS.md) first.** It is the authoritative source of project intent, principles, current architecture (classic pipeline + custom flows), maturity, and non-functional requirements — especially performance, responsiveness, and feel.

**For custom flows / the flowchart canvas:** See [FLOW_NODES.md](./FLOW_NODES.md). It defines the standard example nodes (Start/Plan-Start, Plan Evaluation, template-based generated nodes with categories, Stitch, Final Evaluation, etc.), the contracts AI should use when generating nodes, and how the advanced planning + reflection pattern is intended to work.

Electron MVP for AI-first task orchestration: a live flowchart canvas over a
file-based multi-model pipeline.

**Pipeline:** Prompt → Planning → *(human approval)* → Routing → Execution (sequential tasks) → Verification

## Run it

```sh
npm install
npm start        # build renderer + launch Electron
npm run dev      # hot-reload dev mode (Vite + Electron)
```

Works out of the box with the built-in **mock** provider (no API key). To use
real models, edit `config.json` — e.g. swap the `workers` block for the
`anthropicExample` block — and set `ANTHROPIC_API_KEY` in your environment.

## Architecture

The core design constraint is **separation of concerns through file-based
state**. The planner, router, executor, and verifier are independent modules
that never call each other; they communicate only by reading and writing
files in `runs/<runId>/`:

```
runs/<runId>/
  prompt.md            the user request
  plan.md              planner output (human-approved before execution)
  tasks.json           router output: self-describing tasks with worker assignment
  tasks/<task-id>.md   executor output per task
  retrospectives/*.json  structured retrospective per node
  meta.json            pipeline position (stage, current task, errors)
  log.jsonl            append-only audit log of every action
```

Because state is plain files, every step is inspectable ("Open run folder" in
the UI), reproducible, and resumable — and a future adaptive graph (e.g. a
retrospective triggering a re-plan) is just another module rewriting the same
files.

### Layout

- `core/` — model-agnostic orchestration. No Electron imports; runnable headless.
  - `state.js` — `RunStore`, the file-based state contract everything shares
  - `adapters/` — unified `callModel()` worker interface; one file per provider (`anthropic`, `mock`); add providers here
  - `nodes/` — planner, router, executor, verifier; each has the uniform shape *input → work → retrospective → output*
  - `pipeline.js` — hardcoded linear sequencer with the approval checkpoint; extension point for graph-based workflows
  - `retrospective.js` — the structured retrospective schema (`status`, `problems`, `resolution`, `confidence`, `recommendation`)
- `electron/` — thin shell: window + IPC that forwards to `core/`
- `src/` — React renderer; a pure view over run-state snapshots (React Flow canvas + inspector panel)
- `config.json` — worker (provider/model) assignment per node; model changes are config changes

### Contracts every node obeys

1. Tasks are self-describing: goal, inputs, constraints, dependsOn, worker — no hidden state.
2. Every node emits a retrospective before the pipeline advances; retrospective
   recommendations from past runs are fed into future planning (`historyDigest`).
3. No node assumes which model ran a previous step; coordination is only through files.
4. Every model call is logged (`log.jsonl`) with worker, stage, and outcome.

### Deliberate extension points (not built yet)

- Parallel task execution (tasks already carry `dependsOn`)
- Drag-to-edit workflow graphs (canvas currently renders a fixed pipeline)
- Model registry / more providers (`core/adapters/index.js#registerProvider`)
- Adaptive re-planning from retrospectives (write a module that reads
  `retrospectives/` and rewrites `plan.md` / `tasks.json`)
