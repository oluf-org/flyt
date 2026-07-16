# LLM Flow

**Read [GOALS.md](./GOALS.md) first.** It is the authoritative source of project intent, principles, current architecture, maturity, and non-functional requirements — especially performance, responsiveness, and feel.

**For the node catalog / flowchart patterns:** See [FLOW_NODES.md](./FLOW_NODES.md). It defines the standard nodes (Plan, Plan Evaluation, template-based generated nodes with categories, Stitch, Final Evaluation, …), the contracts AI should use when generating nodes, and the reflective planning + execution pattern.

An easy-to-use desktop app for AI workflows: build workflows from a library of
reusable AI node templates, pick a workflow from a dropdown, type what you
want, and watch it execute transparently on a live canvas.

**One mental model:**

1. **Node Library** — reusable AI node templates (Code, Documentation, Test, …), managed on the Nodes page, stored as `nodes/<id>.json`.
2. **Workflows** — DAGs composed by picking templates from the library and wiring them on the canvas. Each workflow is a text-based, AI-authorable DSL file (`flows/<id>.flow.yaml`, spec: [FLOW_LANG.md](./FLOW_LANG.md)) with canvas positions in a `flows/<id>.layout.json` sidecar written only by the app. Workflow nodes are template *instances*; small per-workflow overrides (model, instructions, tools, approval) never write back to the template.
3. **Run** — one entry point: select a workflow, type your request (it becomes the workflow's User Input node), press Run. One engine: `core/flowRunner.js`.

The classic pipeline (plan → *human approval* → route → execute → verify)
ships as the editable **Default pipeline** workflow built from library nodes.

## Run it

```sh
npm install
npm start        # build renderer + launch Electron
npm run dev      # hot-reload dev mode (Vite + Electron)
npm test         # headless test suite (node --test)
```

Works out of the box with the built-in **mock** provider (no API key). To use
real models, add an OpenRouter key in the in-app Settings, or edit
`config.json` (see the `anthropicExample` block).

## Architecture

The core design constraint is **file-based state as the single source of
truth**. Modules never call each other; they communicate only by reading and
writing files:

```
nodes/<id>.json        Node Library: one reusable AI node template per file
flows/<id>.flow.yaml   workflow definitions (DSL: template instances + overrides)
flows/<id>.layout.json canvas positions (app-written sidecar; presentation only)
runs/<runId>/
  prompt.md            the user request (the User Input node's content)
  flow.json            the resolved workflow this run executes (self-contained snapshot)
  plan.md              planning output (human-approved before routing)
  tasks.json           self-describing executor tasks with worker assignment
  tasks/<task-id>.md   executor output per task (streamed while running)
  nodes/<node-id>.md   per-node outputs (streamed while running)
  retrospectives/*.json  structured retrospective per node
  meta.json            run position (stage, per-node status, errors)
  log.jsonl            append-only audit log of every action
```

Because state is plain files, every step is inspectable ("Open run folder" in
the UI), reproducible, and resumable — approval gates survive an app restart.

### Layout

- `core/` — model-agnostic orchestration. No Electron imports; runnable headless.
  - `state.js` — `RunStore`, the file-based state contract everything shares
  - `nodestore.js` — `NodeStore`, the Node Library (seeds itself from the FLOW_NODES.md catalog)
  - `flowstore.js` — `FlowStore`, workflow definitions + the shipped Default pipeline (reads/writes the `.flow.yaml` DSL + `.layout.json` sidecar; legacy `.json` flows still load and migrate on save)
  - `flowlang/` — the Flow DSL: parse / serialize / lint / migrate + `npm run flow` CLI (spec: `FLOW_LANG.md`)
  - `flowRunner.js` — THE execution engine: topological walk, parallel waves, per-node approval gates, retrospectives, materialization of AI-generated nodes
  - `planEval.js` — strict JSON contracts for plan-eval / step-eval / stitch outputs
  - `nodes/executor.js` + `agent.js` + `tools/` — the agent executor for `agentTask` nodes
  - `adapters/` — unified `callModel()` worker interface; one file per provider (`anthropic`, `openrouter`, `mock`)
  - `retrospective.js` — the structured retrospective schema (`status`, `problems`, `resolution`, `confidence`, `recommendation`)
- `electron/` — thin shell: window + IPC that forwards to `core/`
- `src/` — React renderer; a pure view over file-state snapshots (React Flow canvas, Nodes page, inspector, run panel)
  - `flowTypes.js` — the shared template/instance model: seed catalog, `resolveFlow()` (template defaults + per-workflow overrides → runtime nodes)
- `config.json` — default worker + per-category workers; model changes are config changes

### Contracts every node obeys

1. Tasks are self-describing: goal, inputs, constraints, dependsOn, worker — no hidden state.
2. Every executed node emits a retrospective; retrospective recommendations
   from past runs are fed into future planning (`historyDigest`).
3. Templates constrain *how* (model, tools, instructions, skills); the task
   defines *what*. No hand-written prompts in templates.
4. Every model call is logged (`log.jsonl`) with worker, node, and outcome.

### Skills — per-project expertise

A node template attaches skills **by name**; the bound project supplies them as
`.llmflow/skills/<name>.md`, committed alongside its code. At run time each name
is resolved against the run's workspace and appended to that node's prompt, so
one template ("Code (general)", say) follows whichever project it is pointed at.
A name the project doesn't define is skipped and recorded in `log.jsonl`
(`skills_injected` / `skill_missing`) — never silently. Skills add instructions
only; what an agent may *do* stays governed by the template's tool allowlist and
the approval gates.

### Deliberate extension points (not built yet)

- Model registry / more providers (`core/adapters/index.js#registerProvider`)
- Adaptive re-planning from retrospectives (write a module that reads
  `retrospectives/` and rewrites `plan.md` / `tasks.json`)
