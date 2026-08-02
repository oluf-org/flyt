# Flyt — Goals & Architecture

**Project:** flyt (formerly LLM Flow — D29)
**Status (as of 2026-08-02):** **The investigator pivot (D35) is landing.**
P1–P6, P8 and P10 of `PIVOT-PLAN.md` are in: every model call now writes an
immutable per-attempt record (usage, cost, latency, throughput, bounded redacted
wire), the run surface and a cross-run Investigator page read them, the node
library ships empty behind a hidden kernel with the old templates demoted to
presets, prompts/models/retries/timeouts are user-owned node fields, and the DSL
has conditionals and bounded loops that can branch on those metrics. P7 (the
builder) and P9 (sweeps) are outstanding. Earlier: **V1 tasks 1–12 complete.** The coding-agent loop runs end to end on a real repo with a real model: plan → human gate → decomposed work with real file/bash tools → verify → the change landed and the suite green. Validated live (`DESIGN-SPEC.md` §4.1, §12) with known gaps recorded there. Earlier: product refocus implemented — Node Library + one engine ship; `core/pipeline.js` retired (see "Migration" below).
**Primary audience:** Future AI agents and human contributors. **Read this file first.**

> **One-sentence vision (D35):**
> An instrument for LLM work: build the pipeline yourself, then see exactly what
> every model call cost, sent, and returned — down to the wire.

The canvas survives. The engine survives. What changed is where the value sits.
The old pitch was *capability* — the app does things with LLMs. The pitch now is
*legibility and control*: it is the only place you can watch an LLM pipeline run
and interrogate it afterwards, and every part of the pipeline is something you
built.

Positioning is **both**. Flyt is still aimed at replacing a chat box for
building software (`PRODUCT-SPEC.md` §3), and the V1 coding loop stays green.
The investigator is the layer that makes the builder trustworthy, not a
replacement for it.

---

## The Product Refocus (2026-07-14)

The original MVP grew two parallel systems (a hardcoded classic pipeline and a custom flow engine) plus an ad-hoc node catalog. That made the app conceptually messy. The refocus collapses everything into **one simple mental model**:

1. **Node Library** — reusable AI node templates (Code, Documentation, Test, …), managed on their own page, separate from any workflow.
2. **Workflows** — graphs composed by picking nodes from the library and wiring them on the canvas.
3. **Run** — select a workflow from a dropdown, enter your request, run it.

There is **one execution engine**. The classic linear pipeline (plan → approve → route → execute → verify) is no longer special-cased code; it ships as a **pre-built default workflow** made of library nodes. `core/pipeline.js` is retired once parity is reached.

---

## Non-Negotiable Principles

Judge every change against these. Principle 6 was rewritten by D35 and principle
8 is new; the rest are unchanged and load-bearing.

1. **File-based state is the single source of truth.** All coordination between modules happens through plain files under `runs/<runId>/`. No hidden in-memory coordination. Node templates and workflows are also plain files (`nodes/<id>.json`, `flows/<id>.flow.yaml` + a `flows/<id>.layout.json` sidecar; see the Flow DSL section).
2. **Human oversight by default.** Approval gates are per-node (`requiresApproval`); the default workflow keeps the post-planning gate.
3. **Model-agnostic and multi-model by design.** The worker (provider + model) is a property of the node template, overridable per workflow.
4. **Self-describing artifacts.** Tasks carry goal, inputs, constraints, dependsOn, worker. Every executed node emits a structured retrospective.
5. **Inspectability > convenience.** "Open run folder" stays first-class; artifacts stay human-readable Markdown/JSON.
6. **Ease of use, without hiding the machine.** A new user should understand
   the app in one sentence — *build a pipeline, run it, see what it did.* Some
   complexity stays the system's job (context assembly, task decomposition, D35
   decision 10); prompts and model choice explicitly do not. Convenience never
   buys itself an invisible decision.
8. **Nothing is sent to a model that the user cannot see and could not have
   written (D35).** Prompts are authored artifacts. A model may draft one; it
   may never conjure one at runtime. Assembled context stays automatic, but it
   is *visible* in the wire record — which satisfies the principle without the
   cost of making it editable.
7. **Performance, responsiveness, and feel are incredibly important.** Slow AI steps are acceptable; a janky or confusing UI is not.

---

## Core Concepts

### 1. AI Node Templates (the Node Library)

**The library ships empty (D35).** Templates live **outside** any workflow and
are created on the **Nodes page**; nothing is installed on your behalf. The ten
templates the app used to seed are now *presets* under `presets/nodes/`, offered
inside *Create node* alongside *Blank* and *Describe it*. Beneath that floor sits
a hidden **kernel** (`nodes/_system/`, `system: true`) — two or three nodes the
builder runs on, absent from the palette and the Nodes page, fully visible in
run view when they execute.

Reusable node types, created and managed on a dedicated **Nodes page**. Examples: Code (general), Code (design), Documentation, Test-creation, Plan, Evaluation, Stitch.

A node template defines:

- **Name, category, icon** — how it appears in the palette.
- **Worker (provider + model)** — which model runs it.
- **Optional extra instructions** — short guidance appended to the auto-generated prompt.
- **Tool availability** — which agent tools (write_file, create_task, …) the node may use.
- **Skills** — reusable expertise attached to the node *by name*; the bound project supplies the content as `.flyt/skills/<name>.md`. The template says which expertise it wants, the project says what that means here.

**Templates carry a real, user-owned `prompt` field (D35).** This inverts what
this document said until 2026-08-02, which was that templates contain no
hand-written prompts and the model generates its own. It does not any more: the
prompt is a field you write and can read, *Draft with AI* fills that field
rather than bypassing it, and adding a draft to the library stays a separate
human gesture. The template still constrains *how* (model, tools, limits,
skills); the prompt now says *what*.

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

Prompt assembly per node: the node's own `prompt` field (D35) + the run
request + goal + upstream context (`upstreamContext()`) + template and instance
instructions. Context stays minimal via per-task `Context files:` declarations.

**Every model call writes a record (D35).** `runs/<id>/calls/<seq>.json`, one per
*attempt* — usage, cost, latency, time-to-first-token, throughput, finish reason,
and a bounded, redacted capture of the literal request and response. Written from
one wrapper inside `callModel()`, so no adapter knows the ledger exists; adapters
that spawn a vendor CLI produce an honest degraded record instead of an empty
panel. The records are the truth; `runs/_index/calls.jsonl` is a disposable
derived index that makes them queryable across runs.

---

## Migration From Current State

All six steps landed on 2026-07-14 (branch `flow-builder`):

1. **Node Library backend** ✅ — `core/nodestore.js` mirroring `flowstore.js`; `nodes/*.json` seeded from the FLOW_NODES.md catalog (plan-start, plan-eval, code-general, code-design, documentation, test-creation, step-eval, stitch, final-eval).
2. **Nodes page UI** ✅ — `src/NodesPage.jsx`: CRUD for templates (name, category, worker, instructions, tools, skills, approval).
3. **Instance/override model** ✅ — workflow nodes store `templateId` + `overrides`; `resolveFlow()` in `src/flowTypes.js` merges them; the inspector marks "override (this workflow only)" vs template defaults.
4. **Unified run entry** ✅ — run panel (right): workflow dropdown + user input → User Input node; the separate "New run" prompt path is gone.
5. **Default pipeline as workflow** ✅ — shipped as `flows/default-pipeline.flow.yaml` (User Input → Plan → gated Plan evaluation → Final evaluation → Output) with parity verified in tests (post-planning gate, retrospectives, historyDigest); `core/pipeline.js` and the read-only builtin emulation are deleted.
6. **Cleanup** ✅ — dual-mode branching removed from `src/App.jsx`; README/GOALS/FLOW_NODES updated.

Template `skills` are injected into execution as of V1 task 10 — the bound project supplies each one as `.flyt/skills/<name>.md`, so a template names the expertise it wants and each repo answers with its own. See `DESIGN-SPEC.md` §6.2.

---

## Quality Attributes (Non-Functional Requirements)

Unchanged in spirit; ease of use added.

> The application must feel crisp and trustworthy even though individual AI steps are slow. The UI must remain interactive while a run is in progress. Status must reflect within one animation frame of the underlying file write. Animation must be deliberate and legible — avoid a screen full of competing motion — but there is no absolute one-animation rule: when nodes run in parallel, showing several as active at once is correct (see `DESIGN-SPEC.md` §2.2 / `DECISIONS.md` D9). "Open run folder" must remain a first-class debugging experience.

**Known gaps & risks:** no performance budgets/instrumentation; synchronous filesystem ops in RunStore/FlowStore (the full async rework is post-V1); tiny-graph assumption, manual layout.

**Resolved since:** full-snapshot IPC on every mutation → incremental diffed pushes (V1 task 5); sequential task execution despite `dependsOn` → bounded-parallel agentTasks (V1 task 6, D7); no streaming output → the runner consumes `onText` and the live panel surfaces it (V1 task 8, D10).

**Observable targets:** a 12-node workflow or 15–20-task run must not make the canvas laggy; status updates visually immediate; browsing/editing must stay possible during a run.

---

## Explicit Non-Goals

Automatic adaptive re-planning; large graphs; auto-layout; production-grade
sandboxing. Plus the three D35 narrowed rather than kept:

- **No arbitrary recursion, no unbounded iteration, no sub-flows-as-a-language.**
  What used to read "no loops or conditionals" is now this. `branch` and
  `loop` are in the DSL; every loop declares a bound or lint fails.
- **No non-file store may ever be the source of truth.** A *derived* index is
  blessed (`runs/_index/`) — disposable, rebuildable, and never read as truth.
- **No budgets or spend caps.** History and aggregates only. Enforcement is a
  later chapter, though a loop's `maxCost` and a branch reading
  `node.cost.total` give a flow-level approximation.

**Promoted out of this list** (kept visible so the list is not read as current):
parallel execution (D7), streaming token-by-token UI (D10), A/B testing (D27,
shipped as compare + blind judge), and — as of D35 — **cost tracking**, which is
now the product's centre rather than something it declines to do.

**Also out of scope, and stated so it is not mistaken for an omission:** Flyt
observes **its own runs only**. No proxy, no external-agent observation, no OTel
import. If the app didn't make the call, it doesn't see it — the graph is the
only way to produce data, which is what makes "you built every part of this
pipeline" true of everything the investigator shows you.

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
