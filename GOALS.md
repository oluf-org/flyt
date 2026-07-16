# LLM Flow — Goals & Architecture

**Project:** llm-flow
**Status (as of 2026-07-14):** Product refocus implemented — Node Library + one engine ship; `core/pipeline.js` retired (see "Migration" below)
**Primary audience:** Future AI agents and human contributors. **Read this file first.**

> **One-sentence vision:**
> An easy-to-use desktop app for AI workflows: you build workflows from a library of reusable AI node templates, pick a workflow from a dropdown, type what you want, and watch it execute transparently on a live canvas.

---

## The Product Refocus (2026-07-14)

The original MVP grew two parallel systems (a hardcoded classic pipeline and a custom flow engine) plus an ad-hoc node catalog. That made the app conceptually messy. The refocus collapses everything into **one simple mental model**:

1. **Node Library** — reusable AI node templates (Code, Documentation, Test, …), managed on their own page, separate from any workflow.
2. **Workflows** — graphs composed by picking nodes from the library and wiring them on the canvas.
3. **Run** — select a workflow from a dropdown, enter your request, run it.

There is **one execution engine**. The classic linear pipeline (plan → approve → route → execute → verify) is no longer special-cased code; it ships as a **pre-built default workflow** made of library nodes. `core/pipeline.js` is retired once parity is reached.

---

## Non-Negotiable Principles

Unchanged. Judge every change against these:

1. **File-based state is the single source of truth.** All coordination between modules happens through plain files under `runs/<runId>/`. No hidden in-memory coordination. Node templates and workflows are also plain files (`nodes/<id>.json`, `flows/<id>.flow.yaml` + a `flows/<id>.layout.json` sidecar; see the Flow DSL section).
2. **Human oversight by default.** Approval gates are per-node (`requiresApproval`); the default workflow keeps the post-planning gate.
3. **Model-agnostic and multi-model by design.** The worker (provider + model) is a property of the node template, overridable per workflow.
4. **Self-describing artifacts.** Tasks carry goal, inputs, constraints, dependsOn, worker. Every executed node emits a structured retrospective.
5. **Inspectability > convenience.** "Open run folder" stays first-class; artifacts stay human-readable Markdown/JSON.
6. **Ease of use is now a first-class principle.** A new user should understand the app in one sentence: *pick a workflow, type your request, run it.* Complexity (prompts, context assembly, task decomposition) is the system's job, not the user's.
7. **Performance, responsiveness, and feel are incredibly important.** Slow AI steps are acceptable; a janky or confusing UI is not.

---

## Core Concepts

### 1. AI Node Templates (the Node Library)

Pre-defined, reusable node types that live **outside** any workflow, created and managed on a dedicated **Nodes page**. Examples: Code (general), Code (design), Documentation, Test-creation, Plan, Evaluation, Stitch.

A node template defines:

- **Name, category, icon** — how it appears in the palette.
- **Worker (provider + model)** — which model runs it.
- **Optional extra instructions** — short guidance appended to the auto-generated prompt.
- **Tool availability** — which agent tools (write_file, create_task, …) the node may use.
- **Skills** — optional skills/capabilities attached to the node.

**Crucially, templates do not contain hand-written prompts.** The model generates its own prompt from the task description and upstream context. The template constrains *how* (model, tools, instructions, skills), the task defines *what*.

Templates persist as files (e.g. `nodes/<id>.json`) per principle 1.

### 2. Workflows

A workflow is a DAG built by picking node templates from the library and wiring them on the canvas. The **Flows section in the sidebar is for browsing and creating workflows** — it is a catalog, not a run surface.

- Workflow nodes are **instances of templates**. An instance may carry **small local overrides** (model, instructions, tools, approval). Overrides are saved **in that workflow only** (`flows/<id>.flow.yaml`) and never write back to the template or leak to other workflows.
- Every runnable workflow starts from a **User Input node** and ends in an **Output node**.
- The classic pipeline ships as a read-write pre-built workflow ("Default pipeline") composed of library nodes — users can duplicate and modify it like any other.

### 3. Running a Workflow

The run panel (right side) has:

- A **workflow dropdown** — select which workflow to run.
- A **text input field** — what you type here becomes the content of the workflow's **User Input node** for that run.
- A **Run button**.

No separate "run pipeline" vs "run flow" paths. One dropdown, one input, one engine (`core/flowRunner.js`).

---

## UI / Interaction Model (target)

- **Sidebar:** Flows section (browse/create/duplicate workflows), Runs history, link to the Nodes page.
- **Nodes page:** create/edit/delete node templates; shows category, model, tools, skills.
- **Canvas (edit mode):** palette lists library node templates; drag to instantiate; inspector edits per-instance overrides and clearly marks "override (this workflow only)" vs template defaults.
- **Canvas (run mode):** live view driven by file snapshots over IPC; status glyphs; deliberate, legible animation for active node(s) — when nodes run in parallel, several may animate at once (see the "feel" policy in Quality Attributes).
- **Run panel (right):** workflow dropdown + user input field + run button; the input visibly maps to the User Input node.
- **Inspector:** live artifacts (plan, tasks, outputs, retrospectives, tool calls) during runs; template/override fields when editing.

---

## Execution Model

One engine: `core/flowRunner.js` (topological walk, agentTask phases, per-node approval gates, retrospectives, materialization of AI-generated nodes). The reflective planning pattern in `FLOW_NODES.md` (plan-start → plan-eval → categorized work nodes with minimal `contextSpec` → stitch/step-eval → final-eval) remains the recommended shape for complex workflows and is expressed entirely with library node templates.

Prompt assembly per node: task description + upstream context (`upstreamContext()`) + template instructions + instance override instructions → model generates its own working prompt. Context stays minimal via per-task `Context files:` declarations.

---

## Migration From Current State

All six steps landed on 2026-07-14 (branch `flow-builder`):

1. **Node Library backend** ✅ — `core/nodestore.js` mirroring `flowstore.js`; `nodes/*.json` seeded from the FLOW_NODES.md catalog (plan-start, plan-eval, code-general, code-design, documentation, test-creation, step-eval, stitch, final-eval).
2. **Nodes page UI** ✅ — `src/NodesPage.jsx`: CRUD for templates (name, category, worker, instructions, tools, skills, approval).
3. **Instance/override model** ✅ — workflow nodes store `templateId` + `overrides`; `resolveFlow()` in `src/flowTypes.js` merges them; the inspector marks "override (this workflow only)" vs template defaults.
4. **Unified run entry** ✅ — run panel (right): workflow dropdown + user input → User Input node; the separate "New run" prompt path is gone.
5. **Default pipeline as workflow** ✅ — shipped as `flows/default-pipeline.flow.yaml` (User Input → Plan → gated Plan evaluation → Final evaluation → Output) with parity verified in tests (post-planning gate, retrospectives, historyDigest); `core/pipeline.js` and the read-only builtin emulation are deleted.
6. **Cleanup** ✅ — dual-mode branching removed from `src/App.jsx`; README/GOALS/FLOW_NODES updated.

Remaining known gap: template `skills` are stored/edited but not yet injected into execution.

---

## Quality Attributes (Non-Functional Requirements)

Unchanged in spirit; ease of use added.

> The application must feel crisp and trustworthy even though individual AI steps are slow. The UI must remain interactive while a run is in progress. Status must reflect within one animation frame of the underlying file write. Animation must be deliberate and legible — avoid a screen full of competing motion — but there is no absolute one-animation rule: when nodes run in parallel, showing several as active at once is correct (see `DESIGN-SPEC.md` §2.2 / `DECISIONS.md` D9). "Open run folder" must remain a first-class debugging experience.

**Known gaps & risks:** no performance budgets/instrumentation; synchronous filesystem ops in RunStore/FlowStore (the full async rework is post-V1); tiny-graph assumption, manual layout.

**Resolved since:** full-snapshot IPC on every mutation → incremental diffed pushes (V1 task 5); sequential task execution despite `dependsOn` → bounded-parallel agentTasks (V1 task 6, D7); no streaming output → the runner consumes `onText` and the live panel surfaces it (V1 task 8, D10).

**Observable targets:** a 12-node workflow or 15–20-task run must not make the canvas laggy; status updates visually immediate; browsing/editing must stay possible during a run.

---

## Explicit Non-Goals (unchanged)

Full general-purpose visual programming (loops, conditionals, sub-flows); true parallel execution; streaming token-by-token UI; automatic adaptive re-planning; large graphs, cost tracking, A/B testing, auto-layout; any non-file state store; production-grade sandboxing.

---

## How to Keep This Document Alive

- Update the "Status (as of ...)" line on significant changes.
- Any edit to `core/{state,flowRunner,flowstore,nodestore}` or the canvas/run-entry paths should prompt a review of the relevant sections.
- For future AI work: the first instruction is "Read GOALS.md in full before making any changes or suggestions."

---

## Quick Start

```sh
npm install
npm run dev          # hot-reload Vite + Electron
```

Use the mock provider (default) for exploration. Edit `config.json` or in-app Settings for real models. The filesystem under `runs/`, `flows/`, and `nodes/` is the best documentation of what the system actually does.

## Flow DSL

Workflows are stored as `flows/<id>.flow.yaml` — a text-based, AI-authorable
DSL (spec: `FLOW_LANG.md`). The script is the source of truth for structure;
canvas positions live in `flows/<id>.layout.json`, written only by the app.
`npm run flow -- lint <file> --json` is the machine gate: an AI authors a
flow, lints until `ok: true`, and the app picks it up automatically. Legacy
`flows/*.json` still load and are migrated on save (or via
`npm run flow -- migrate`). Principle #1 is unchanged — the DSL file is just
a better file.
