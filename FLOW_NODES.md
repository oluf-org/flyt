# LLM Flow — Standard Example Nodes & Flowchart Patterns

> **Node rework (2026-07-20).** The catalog below describes the original
> per-role templates; the shipped library has since been combined:
>
> - **Pinned structural nodes** — every flow always carries its User Input and
>   Output node. They are created automatically, cannot be deleted on the
>   canvas, and removing them from the YAML fails the save
>   (`core/flowstore.js`).
> - **`work`** — the one work node (agentTask). Its *task type* is the
>   category (`Code general | Code design | documentation | Test-creation`);
>   the tool grant follows the task type (`WORK_TOOLS`): only Test-creation
>   gets `bash`, and it alone defaults the per-call approval gate on.
>   Replaces `code-general-step`, `code-design-step`, `documentation-step`,
>   `test-creation-step`.
> - **`evaluation`** — the one evaluation node. Its `evalType`
>   (`plan | step | final`) resolves to the `plan-eval` / `step-eval` /
>   `final-eval` role, so the contracts below are unchanged. Replaces the
>   three separate evaluation templates.
> - **`combine`** / **`split`** — Combine merges parallel outputs into one
>   coherent deliverable (the stitch contract, including `fixTasks`); Split
>   divides work into labeled independent parts for parallel branches.
>   Replace `stitch`.
> - **`general-analysis`** / **`translation`** — general text analysis, and
>   faithful translation with a per-node target `language`.
> - **`compare`** (2026-07-20) — reviews multiple upstream *alternatives*
>   (the same task fanned out to different models, competing drafts/plans)
>   and reports agreements, differences, per-alternative strengths, and a
>   keep-the-best recommendation. Combine's contract now covers alternatives
>   too (best-of merge, not concatenation), so `compare → combine` implements
>   the dual-model bake-off pattern below; `requiresApproval` on the Combine
>   makes the human the judge.
> - **Effort level** — every AI node carries `effort: low | medium | high`.
>   It drives the default model pick (`core/modelPriority.js`: per-provider
>   rankings plus a general cross-provider priority per task kind × effort,
>   restricted to providers with keys) and the response token budget. An
>   explicit worker always wins; `config.categoryWorkers` still beats the
>   priority table.
> - **Feedback point** — every AI node (not input/output) has a `feedback`
>   source handle at its top. A feedback edge (`node.feedback -> upstream`)
>   points backwards, is excluded from ordering/cycle rules, and carries the
>   step-eval verdict contract: a `retry` verdict re-runs the judged node
>   with `retry-for-<id>.md` guidance (bounded), then re-evaluates.
> - **Orchestrator node budget** — `minNodes`/`maxNodes` (default 1–5) bound
>   how many nodes the planning call may declare; on the canvas a swarm
>   larger than 8 collapses into a stack with a modal list.
> - Stored flows referencing retired template ids are migrated on load
>   (`LEGACY_TEMPLATE_MAP` in `src/flowTypes.js`); generated-node specs may
>   also carry an optional per-node `effort`.

**Status:** 2026-07-13 — Initial version produced as part of flowchart refinement.  
**Purpose:** Define the nodes that AI (and humans) can reliably pick from, categorize work into, or instantiate when authoring custom flows. This is the authoritative reference for "how the flowchart part of the application should work" for sophisticated planning + execution + reflection workflows.

> **Read this together with** `GOALS.md` (principles) and the source (`src/flowTypes.js`, `core/flowRunner.js`).

---

## How the Flowchart Part of the Application Is Intended to Work

The **flowchart** system consists of:

- The visual editor (`src/FlowCanvas.jsx` + `FlowEditor`, `src/App.jsx`) for authoring static DAG definitions stored as the Flow DSL `flows/<id>.flow.yaml` (+ a `flows/<id>.layout.json` position sidecar; spec: `FLOW_LANG.md`). Legacy `flows/<id>.json` still loads and migrates on save.
- The execution engine (`core/flowRunner.js`) that performs a topological walk, with special phases for `agentTask` nodes (which feed the existing powerful executor + tools).
- All coordination through plain files under `runs/<runId>/` (the single source of truth).

### Core Philosophy (unchanged)
- File-based state is sacred.
- Nodes are self-describing.
- Human oversight by default (per-node `requiresApproval`).
- Model pluralism via per-node or category-driven worker assignment.
- Radical inspectability ("Open run folder").

### The Advanced Reflective Planning Pattern (new focus)

For complex work (especially code), the recommended pattern is a **multi-stage planning + categorized execution + self-reflection loop** expressed as a custom flow:

```
input (prompt)
   │
   ▼
plan-start  (or aiStep role=plan-start)
   │   writes tasks.md  (well-defined tasks + explicit "Context files:" with per-file descriptions)
   ▼
plan-eval   (aiStep role=plan-eval)
   │   writes plan-eval.* (parallel groups, dependsOn order, categories, list of nodes using templates)
   │   (this step "creates" the AI-generated nodes via template references)
   ▼
[ generated work nodes — aiStep or agentTask carrying template + category + contextSpec ]
   │   each receives *minimal* context (only the files + descriptions declared for it)
   │   (can run in declared parallel groups conceptually; currently sequential)
   ▼
step-eval / stitch  (reflection after work or after a parallel wave)
   │   notes plan impact, makes small fixes, or creates corrective task nodes
   ▼
final-eval
   │   produces final-eval.md with completeness + explicit differences from original plan + reasoning
   ▼
output (collector)
```

**Why this structure?**
- The Start node forces explicit minimal-context declarations ("which files to add to context per file, so we dont use any more context than necessary").
- The Plan Evaluation node is the decision point that produces executable structure (parallel/sequential) **and** categorization so the right model can be chosen.
- "AI generated nodes" are created by referencing a small documented catalog of templates. The runner can materialize them into the live run's `flow.json` and `tasks.json` so they appear on the canvas with provenance.
- Multiple evaluation points close the loop: immediate feedback, stitching, and final delta reporting.
- Everything stays auditable.

This pattern makes it safe and effective for an AI to *emit* flow fragments, because the catalog of pickable nodes and the expected artifact shapes are explicit.

---

## Node Catalog — Example / Standard Nodes

These are **example / standard nodes**. They are the reference set that AI should pick from or categorize work into. They are implemented primarily as `aiStep` (or `agentTask`) nodes carrying a `role` and/or `template` + rich `data`.

They appear in the editor's ＋ Add node picker (via `TYPE_META`) and have first-class support in the inspector.

> **Library templates vs. engine types.** Nodes 1–6 below are **Node Library templates** (`nodes/<id>.json` — the nine seeded templates). `orchestrator` (§7), along with `input` and `output`, are **engine/DSL node *types*, not Node Library templates**: they are built-in structural nodes added from the picker directly, not instantiated from the library. See `PRODUCT-SPEC.md` §5.

### 1. Start / Plan-Start Node

**Visual:** icon `▶`, label "Start / Planner", sub "plan · tasks.md + context specs"  
**kind:** `ai`  
**Recommended type/role:** `aiStep` with `role: "plan-start"` (or dedicated visual `planStart`)

**Input:** The user prompt (usually from an upstream `input` node).

**Output (primary):** `tasks.md`

**Behavior (user requirement):**
> "Start node. Basically plan mode, creating tasks in a .md file, the tasks should be well defined and have descriptions of which files to add to context per file, so we dont use any more context than neccecary."

Each task must be actionable and independently verifiable. The **Context files** section is mandatory and uses descriptions (not just paths) so downstream nodes and the context assembler can be surgical.

**Example `tasks.md` fragment (ideal output shape):**

```markdown
# Tasks

## task-1: Design the public API for the new config loader
Goal: Produce a clean TypeScript interface + default implementation contract in src/config/loader.ts
Category: Code design
Context files:
- src/types.ts (only the top-level AppConfig interface and related types)
- docs/architecture.md (the "Configuration" subsection)
- (no other files)
Constraints:
- Must be pure (no side effects)
- Follow existing naming conventions
Depends on: none
Suggested template: code-design-step

## task-2: Implement the loader
...
```

The Start node may also write a classic `plan.md` for compatibility.

**Suggested template name:** `plan-start`

---

### 2. Plan Evaluation Node

**Visual:** icon `▤⇄`, label "Plan Evaluation", sub "eval · structure + categories + nodes"  
**kind:** `ai`  
**role:** `plan-eval`

**Input:** `tasks.md` (plus prompt and any prior context).

**Outputs:**
- Structured `plan-eval.json` (or fenced JSON block) describing:
  - `parallelGroups`
  - dependency order / `dependsOn`
  - `categories` per task
  - `nodes` list using template names (this is how AI-generated nodes are specified)

**Behavior (user requirement):**
> "Next is a plan evaluation node. Input is task.md output should be the next nodes, with defined what can be done in paralell and what is dependent on that, eg a and B can start paralell, then we need to do C, before dooing D and E. The evaluation node should also categorize the tasks, so we can chose models based on that, the categories i envision are atleast Code general, Code design, documentation, Test-creation."

> "The AI generated nodes are created by the last node based on templates."

This node is the primary "creator" of the rest of the flow.

**Categories (minimum set):**
- `Code general`
- `Code design`
- `documentation`
- `Test-creation`

**Suggested template name:** `plan-eval`

---

### 3. Template-based Work Nodes (AI-Generated Nodes)

These are **not** a single type — they are concrete instances created from the catalog.

**Pre-defined reference templates (AI must use these names when generating nodes):**

| Template name         | Base     | Category        | Purpose                              | Prefers          |
|-----------------------|----------|-----------------|--------------------------------------|------------------|
| `code-general-step`   | aiStep   | Code general   | Straightforward implementation work | balanced model   |
| `code-design-step`    | aiStep   | Code design     | Interfaces, architecture, data models | stronger model   |
| `documentation-step`  | aiStep   | documentation   | Docs, READMEs, comments              | lighter/faster   |
| `test-creation-step`  | agentTask| Test-creation   | Unit/integration tests + fixtures    | code-capable     |

**Data carried by materialized nodes:**
- `template`
- `category`
- `contextSpec: { files: [{path, description}, ...] }`
- `goal` (from tasks.md)
- provenance: `generatedBy: "<plan-eval-node-id>"`

**Key property:** When executed they receive **only** the declared context files, each prefixed with the exact description the planner provided. This is the main mechanism for "do not use any more context than necessary".

**Suggested usage:** Plan-eval emits them → runner materializes them into the run's flow + tasks.

---

### 4. Step / Intermediate Evaluation Node

**role:** `step-eval`

**Input:** Output(s) of the immediately preceding work node + relevant plan-eval decisions + tasks.md.

**Outputs:** Enhanced retrospective + optional `eval-*.md`. May contain:
- Plan impact notes
- "Escalate to human" signal
- Auto-retry directive + enriched "what went wrong" context (written to `retry-for-*.md`)

**Behavior (user requirement):**
> "The next model is again a evaluation model, based on the last node, it should note changes to the plan that could affect the next nodes, or in worst case escalate to human review for retry, it could also attempt a automatic retry, giving a better context in what went wrong."

**Suggested template name:** `step-eval`

---

### 5. Stitch Together Node

**role:** `stitch`

**Input:** All outputs from a parallel wave or the preceding batch of work nodes.

**Outputs:**
- Integrated/coherent deliverable
- `stitch-report.md`
- Small inline fixes (via tools or writes)
- Or creation of new corrective `task` nodes (using the existing `create_task` mechanism or by registering new agentTasks)

**Behavior (user requirement):**
> "Finally we need a stitch together node, to review if theese tasks have been completed in a way where we can stitch them together, and to make small changes if needed, if larger changes are needed for making everything work, this step should also be able to create a task node to fix it."

**Suggested template name:** `stitch`

---

### 6. Final Evaluation Node

**role:** `final-eval`

**Input:** Full history (prompt, tasks.md, plan-eval artifacts, all outputs, retrospectives).

**Output:** `final-eval.md` (plus retrospective) that must include:
- Completeness assessment vs original plan
- Explicit differences between final product and what was planned
- Reasoning for each difference

**Behavior (user requirement):**
> "Finally we have the last evaluation node, that evaluates the completeness of the tasks, and notes differences in the final product from what was originally planned, with the reasoning."

Usually placed before the final `output` collector.

**Suggested template name:** `final-eval`

---

### 7. Orchestrator Node (autonomous container)

**type:** `orchestrator` (built-in structural node, kind `ai` — added from the
＋ Add node picker like User Input / Output, not from the Node Library)

**Input:** the brief + upstream context (typically `tasks.md` from Plan-Start).

**Output ports:**
- `results` (primary) — the aggregated outputs of every node it created
- `summary` — the orchestration plan summary + node inventory

**Behavior:** one planning call (role `orchestrate`, same strict JSON contract
as plan-eval, one bounded re-ask) decides the set of work nodes. They are
materialized **inside the orchestrator's box** (`parentId` + `managedBy`) and
executed by an inline sub-walk — parallel waves for independent aiSteps,
sequential agent tasks — with **no human intervention**: children never pause
at approval gates. When every child is done, their outputs are aggregated into
`nodes/<id>.md`; downstream nodes only ever see the orchestrator itself.
Unlike plan-eval (which degrades gracefully), an invalid plan **fails the
node** — creating nodes is its entire job.

**Authored children (alternative to planning):** nodes you drag into the box
yourself (`parent` in the DSL, no `managedBy`) ARE the plan — when any exist,
the planning call is skipped and exactly those nodes run in the same inline
sub-walk, with the same aggregation and summary sidecar.

On the canvas the box shows its children live and gets an animated purple
gradient border while active. Artifacts: `nodes/<id>.plan.md` (the streamed
planning output), `nodes/<id>.summary.md`, `nodes/<id>.md` (aggregate).

---

### 8. Compare Node

**role:** `compare` · **template:** `compare` · icon `⇄`

**Input:** two or more upstream outputs that are *alternatives* — the same task
completed independently (typically by different models via per-node `worker`
overrides), or competing drafts, plans, or solutions.

**Output port:** `report` — a structured comparison: alternatives inventory,
agreements, substantive differences (with which side handles each better and
why), per-alternative strengths/weaknesses, and a **Recommendation** section
stating exactly what to keep from which alternative. Also mirrored to
`nodes/compare-report.md` for inspectability (like `combine-report`).

**Behavior:** judges, never redoes or merges the work. Grounds every judgment
in the actual outputs; judges correctness and fitness for the brief, not style
or length; says so when alternatives are equivalent instead of inventing a
winner. Deliberately general: works for model bake-offs, draft A/B reviews,
plan alternatives — anything with competing versions of the same deliverable.

#### The dual-model bake-off pattern

Run the same task on two models, compare, and keep the best of both:

```
        ┌── work A (worker: model 1) ──┐
input ──┤                              ├── compare ── combine ── …
        └── work B (worker: model 2) ──┘        (A + B + report feed combine)
```

- **Fan-out needs no new node:** wire the same upstream into two `work` (or
  AI-step) instances and give each a different per-node `worker` override.
- **Compare** reads both alternatives and writes the difference report.
- **Combine** reads both alternatives *plus* the report and produces the
  single best-of deliverable — its contract distinguishes complementary parts
  from alternatives and follows the comparison's recommendations, crediting
  where each element came from (larger gaps still become `fixTasks`).
- **Model as judge:** run as-is. **Human as judge:** set `requiresApproval`
  on the Combine node — the run pauses after Compare with the report (and both
  alternatives) on screen, and the human approves, rejects, or adjusts before
  the merge runs. For a fully human comparison, drop the Compare node and gate
  the Combine directly.

### 9. Prompt Refiner Node

**Visual:** icon `✍`, label "Prompt refiner", sub "refine · brief + questions"
**kind:** `ai`
**Type/role:** `aiStep` with `role: "refine"` (Node Library template `prompt-refiner`)

**Input:** the raw run request (usually straight from the `input` node).

**Output (primary port `prompt`):** the request rewritten into a precise,
self-contained brief — goal, constraints, deliverable, acceptance. This is what
the rest of the flow executes, so the planner/work nodes never see the original
loose prompt. **Auxiliary port `questions`:** clarifying questions, present only
when an ambiguity would *materially* change the deliverable.

**Behavior (MODES-COMPARE T5/T6):** the refiner resolves ordinary ambiguity
itself by stating an assumption inline and proceeding. It asks a question only
when it cannot responsibly pick for the user — and when it does, it ends its
brief with ONE fenced JSON block:

```json
{ "questions": [{ "id": "scope", "text": "Web or CLI?", "why": "changes the whole build" }] }
```

(at most 3). That parks the run at the **`awaiting_input`** gate — a sibling of
the approval gate. The user answers from the composer; the answers are written
to `nodes/<id>.answers.md`, the node re-runs with them in context, and it
proceeds without asking again (**one round, hard cap**). A malformed or absent
block means "no questions — proceed". The refiner is the first node of every
default pipeline (below).

---

## Default Pipelines (Low / Medium / High / Ultra)

Beside the classic **Default pipeline**, the app seeds four **tiered pipelines**
on first launch (`core/flowstore.js` `ensureSeedPipelines`; seeded only when
absent, so user edits and deletions are respected):

| Pipeline | Graph | For |
|---|---|---|
| **Low** | `input → refine → work (Code general) → output` | a quick, well-scoped task |
| **Medium** | `input → refine → plan → orchestrator (1–5) → output` | planning with a small swarm |
| **High** | Medium at high effort: enriched planner + orchestrator (2–10) | substantial, decomposable work |
| **Ultra** | High + a final evaluation wired back to the orchestrator for one bounded retry | when completeness must be checked |

Each ships with **two example modes** (`Fable` / `GPT`) — the same graph on a
different model brain — so the launch mode picker and the comparison view have
something to run day one. The **High** tier's planner runs the enriched brief as
a `system` override on the plan node (data, not a code fork — T8), and exposes
the orchestrator's `minNodes`/`maxNodes` as composer run inputs (`expose:`, T9).

---

## Output Ports — what every node CREATES

Every node declares named outputs (`src/flowTypes.js` `ROLE_PORTS` /
`TYPE_PORTS`; Node Library templates may override with an `outputs` array).
The first port is the **primary** output (`nodes/<id>.md`); auxiliary ports
are written as `nodes/<id>.<port>.md`:

| node | ports |
|---|---|
| plan-start | `tasks` |
| plan-eval | `plan` (primary), `summary` |
| step-eval | `report` (primary), `verdict` (the structured JSON decision) |
| stitch / final-eval / verify | `report` |
| work steps / agent tasks | `result` |
| orchestrator | `results` (primary), `summary` |

On the canvas each node shows a "creates" footer with one chip per port and
one bottom **source handle per port** — drag an edge from a specific handle to
send that output downstream. The edge stores `sourceHandle`; edges without one
carry the primary output (legacy behavior, nothing to migrate). A missing port
artifact falls back to the primary output rather than dropping the edge.

---

## Strict JSON Contracts (implemented in `core/planEval.js`)

These are enforced at runtime. Invalid output is rejected as a whole, the
violations are written to `nodes/plan-eval-errors.md` + `log.jsonl`, and the
run continues without the structured effect (graceful failure).

### plan-eval → node materialization

One ```json block (or raw JSON). `nodes` is required and every entry needs
`id` (unique, `[a-zA-Z0-9_-]`) + `template` (a `NODE_TEMPLATES` key):

```json
{
  "nodes": [{
    "id": "gen-impl", "template": "code-general-step", "taskRef": "task-2",
    "category": "Code general", "title": "...", "goal": "...",
    "dependsOn": ["gen-design"],
    "contextSpec": { "files": [{ "path": "gen-design", "description": "exactly which part is needed" }] }
  }],
  "parallelGroups": [["task-1"], ["task-2", "task-3"]],
  "categories": { "task-1": "Code design" },
  "summary": "one line"
}
```

`dependsOn` may reference generated node ids or taskRefs. When `dependsOn` is
omitted, consecutive `parallelGroups` become sequential waves. Valid nodes are
materialized into the run's `flow.json` with `generatedBy: <plan-eval-node-id>`
provenance, wired between the plan-eval node and its downstream targets, and
appear live on the canvas. A generated node without a `contextSpec` defaults
to `{ files: [{ path: "tasks-md", ... }] }`.

### step-eval → verdict

The report must end with one ```json block:

```json
{ "verdict": "pass" | "retry" | "escalate", "reason": "one line", "guidance": "required for retry" }
```

- `retry`: the runner writes `nodes/retry-for-<target>.md` with the guidance,
  re-runs the evaluated upstream node (aiStep re-call, or agentTask reset to
  pending with the guidance as an extra input), then re-runs the step-eval.
  Bounded by `data.maxRetries` (default 1); exhaustion escalates.
- `escalate`: the run pauses at the standard human approval gate
  (approve = continue, reject = run rejected).
- No valid block = pass (noted as a problem in the node's retrospective).

### stitch → fix tasks

```json
{ "fixTasks": [{ "title": "...", "goal": "fully self-describing", "constraints": [], "dependsOn": [], "worker": { "provider": "...", "model": "..." } }] }
```

Each valid entry is routed through the existing `create_task` tool (same
schema/validation/logging) with `createdBy: <stitch-node-id>` and executed by
the executor before the flow continues. Invalid entries are dropped and
reported; omitting the block or `"fixTasks": []` means nothing to fix.

### followup-triage → turn classification (DECISIONS.md D21)

Not a node role: a direct call `FlowRunner.followUp()` makes when the user
replies to a finished run. One ```json block:

```json
{
  "class": "question" | "fix" | "feature",
  "reason": "one line",
  "contextNodes": ["<done node id whose output the new work needs>"],
  "answer": "question-class only: the answer, as Markdown",
  "nodes": [{ "id": "...", "template": "code-general-step", "title": "...", "goal": "...", "dependsOn": [], "contextSpec": { "files": [] } }],
  "goal": "feature-class only: what to plan and build"
}
```

`question` answers in place (`followups/<n>/answer.md`, no graph change).
`fix` materializes the declared nodes (fu`<n>`- prefixed) between a visible
`fu<n>-input` feedback node and a closing `feedback-review` node. `feature`
materializes the standard reflective segment: plan → plan-eval (human approval
gate) → materialized executors → stitch → feedback-review. `contextNodes`
become edges from the selected done nodes into the turn's entry nodes — edge
context is the only context mechanism. One bounded re-ask on contract misses;
an unparseable triage restores the run's stage and notes the miss in the thread.

### feedback-review → turn verdict

Closes every follow-up turn. The report must end with one ```json block:

```json
{ "verdict": "solved" | "more-work", "reason": "one line", "nodes": [{ "id": "...", "template": "...", "goal": "..." }] }
```

- `solved`: the walk drains and the run is done again.
- `more-work`: the declared nodes are materialized upstream of the review
  (prefixed `fu<n>x<k>-`), the review re-runs after them. Bounded to 2
  extensions per turn; hitting the bound — or `more-work` with nothing
  materializable — escalates through the standard human gate.
- No valid block = solved (noted as a problem in the retrospective).

### contextSpec resolution order

`buildMinimalContext` resolves each declared path against, in order:
`workspace/<path>` → well-known artifacts (`prompt`, `plan`, `tasks`/`tasks-md`)
→ `nodes/<id>.md` → `tasks/<id>.md`. Unresolvable files are surfaced to the
model as an explicit `[NOT FOUND: ...]` block and logged as
`context_file_missing` — never silently dropped.

---

## Supporting Concepts

### NODE_TEMPLATES Catalog
See `src/flowTypes.js` for the machine-readable version. The keys above (`plan-start`, `plan-eval`, `code-design-step`, etc.) are the stable names an AI should emit when generating flows or sub-plans.

### ContextSpec
The contract that enables minimal context:

```json
"contextSpec": {
  "files": [
    { "path": "src/types.ts", "description": "Only the exported interfaces. Do not include implementation." }
  ]
}
```

The runner's context builder must honor this.

### Categories Drive Worker Choice
Resolution: explicit `worker` on the node > `categoryWorkers` map in config > default executor.

### Materialization of Generated Nodes
After a plan-eval (or plan-start) node succeeds, the runner may parse a `nodes` array from its output and materialize real canvas nodes into the *run's copy* of `flow.json`. These appear live on the canvas for that run and carry `generatedBy` + `template`.

The source definition on disk is never mutated by execution.

### Human Oversight
All the above node kinds support `data.requiresApproval`. Evaluation nodes that need to escalate simply pause here.

---

## How to Use These Nodes (for Humans and AI)

**When authoring a flow:**
1. Start with an `input` + `plan-start`.
2. Wire `plan-eval` immediately after.
3. Let the plan-eval (or a small follow-on step) declare the work using the template names above.
4. Add `stitch` after parallel work and `final-eval` near the end.
5. Terminate with `output`.

**When an AI is asked to design a flow:**
- Read this file first.
- Emit JSON nodes that use the documented `template` and `category` fields.
- Produce `tasks.md`-style structure from the start node.
- The resulting run artifacts will be predictable and reviewable.

**Example minimal flow skeleton (conceptual):**

```json
{
  "nodes": [
    {"id":"in", "type":"input", "data":{"text":"..."}},
    {"id":"start", "type":"aiStep", "data":{"role":"plan-start", "title":"Start"}},
    {"id":"eval", "type":"aiStep", "data":{"role":"plan-eval", "title":"Evaluate Plan"}},
    {"id":"work1", "type":"aiStep", "data":{"template":"code-design-step", "category":"Code design", "contextSpec":{...}}},
    {"id":"stitch", "type":"aiStep", "data":{"role":"stitch"}},
    {"id":"final", "type":"aiStep", "data":{"role":"final-eval"}},
    {"id":"out", "type":"output"}
  ],
  "edges": [ ... ]
}
```

---

## Current Implementation Status (updated 2026-07-14)

- **This catalog now lives in the Node Library** (`nodes/<id>.json`, managed on
  the Nodes page, seeded from `src/flowTypes.js` `SEED_NODE_TEMPLATES`).
  Workflow nodes are template instances (`templateId` + per-workflow
  `overrides`); `resolveFlow()` merges them at edit/run time. Plan-eval may
  reference any library template id in addition to the built-in names above.
- Strict contracts + parsers: `core/planEval.js` (plan-eval, step-eval verdict, stitch fixTasks)
- Runner: dynamic topological walk with real materialization (library
  templates preferred), minimal-context resolution, honest aiStep failure
  handling, bounded step-eval retry / escalation, and stitch fix tasks via
  `create_task`: `core/flowRunner.js`
- Editor support: instance/override inspector in `src/Inspector.jsx` + library palette in `App.jsx`
- Mock outputs that exercise the pattern (incl. structured verdicts): `core/adapters/mock.js`
- Shipped flow: `flows/default-pipeline.flow.yaml` (the classic pipeline as library nodes)

See the code and run a flow using these roles/templates to observe the produced artifacts.

---

## Future Evolution

- True parallel scheduling for declared groups.
- Richer template parameters.
- More categories and templates as real usage reveals needs.
- Optional streaming of partial results from long eval nodes.

All changes must preserve the file contract and the inspectability guarantees.

---

*This document exists so that both humans and AI agents have a precise, stable contract for the nodes they can pick from and the shape of the advanced planning + reflection flows the system is designed to support.*