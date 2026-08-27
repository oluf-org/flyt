# Flyt — Standard Example Nodes & Flowchart Patterns

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

> **Library templates vs. engine types.** Template nodes are stored in `nodes/<id>.json`. `orchestrator`, along with `input`, `output`, `fanout`, `loop`, and sub-flow call sites, are structural engine/DSL nodes added directly rather than instantiated from the library. See `DESIGN-SPEC.md` §3.

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

### 7b. Fan-out Node (lanes on one brief)

**type:** `fanout` (built-in structural node, kind `ai` — added from the
＋ Add node picker, like the Orchestrator)

**Input:** the brief + upstream context.

**Output ports:**
- `results` (primary) — every lane's output, one labelled section per lane
- `lanes` — the roster: label, id, model and intent for each lane that ran
- `brief` — *(`plan: auto` only)* why these lanes: the mission, what was treated
  as central, and each lane's reason for existing
- `peek` — *(`plan: auto` only)* the bounded read-only look at the subject that
  the planner read before choosing the roster

**Behavior:** the sibling of the Orchestrator. The node mints one child per lane
and runs them through the same scoped sub-walk every container uses
(`core/nodes/expand.js`). Lanes are independent by construction: no edges
between them, all of them in one wave up to `maxParallel`.

**Where the roster comes from.** By default the author wrote it — a lane list,
or a model set that mints one lane per member — and exactly that runs: no
planning call, no contract to violate, nothing to re-ask. Under `plan: auto`
(D37) the node instead peeks at the subject and asks a model which lanes this
particular brief needs. That is a real reversal of the "a fan-out never plans"
property D36 gave this node, and what makes it safe is the **enum**: the planner
*selects and duplicates* presets from the fixed list below, and may never write
what a lane is. A model that can pick lanes but not define them cannot turn the
adversarial read into a flattering one — which is the property "no planning
call" was protecting. The planner may put three architecture readers on a repo
when architecture is what was asked for; it may not invent a fourth kind of
reader.

**Divergence is the point (D36).** Each lane's assembled prompt carries the
shared goal, its own lane instructions, and the **labels + one-line intents of
its siblings**, plus the instruction to surface at least one finding no other
lane is positioned to reach. "Find something the others will not" is only
meaningful if a lane knows who the others are. Lane **outputs** never cross —
sharing them would make every lane converge on whatever the first one said.
Planning does not touch this.

**Lane presets** (`core/nodes/fanout.js`): `standard` (the brief, done well),
`architecture` (how it is put together, and what each decision costs),
`wildcard` (only the odd, hidden, undocumented, surprising), `adversarial`
(only what is fragile or wrong), `contrarian` (the case against the obvious
reading). Each preset carries **two prompt layers**: a `system` role prompt that
also fixes the lane's output shape, and `instructions` composed into the lane
brief. The role prompt replaces `DEFAULT_SYSTEM[role]` on purpose — one report
format imposed on every lane is the single biggest reason four lanes come back
reading alike. A lane may take a preset, its own text, or both.

**The two prompt layers.** A lane's system prompt is the **shared preamble**
(generated per run, identical in every lane: the mission, the subject, and any
focus/ignore) followed by the **role prompt** (the preset's fixed text, plus the
planner's one-sentence `emphasis` if it gave one). The split is load-bearing:
the preamble owns *mission and scope*, the preset owns *method and output
shape*. A `system:` written on the fan-out node itself is the author writing
that preamble by hand — it wins outright and skips both the peek and the
planning call.

**`ignore` is advisory, by decision.** It reaches every lane as "do not spend
effort here *unless it is load-bearing for something they did ask for*", and
nothing filters findings against it. "Don't focus on X" is a statement about
attention, not about relevance; a user who says *"ignore syntax errors"* still
wants to hear it when a syntax error is why the build is broken. No lane is ever
dropped for colliding with an ignore item.

**Planning keys:** `plan` (`auto` | `off`, default `off`), `minLanes` (default
2), `maxLanes` (default 6), and `maxToolIterations` (the agent-round limit for
each materialized lane). Each lane is a full read of the subject on a metered
API, so an unbounded roster is the same liability as an unbounded loop. The
planner's shape-only peek has its own hard ceiling of three rounds. Two
lanes sharing a preset are **always staffed on different models**; when the pool
runs dry the roster is truncated and each drop logged as
`fanout_lane_unstaffed`, because three identical role prompts on one model is
three correlated reads sold as coverage. A planner failure never fails the node:
it logs `fanout_plan_failed`, runs the **authored** lanes, and says so in
`.brief.md`.

Lanes inherit the fan-out's `toolCeiling` exactly as generated children inherit
an orchestrator's (`DESIGN-SPEC.md` §5), never pause at approval gates, and are stamped with
`laneId` (plus `lanePreset`) so a resumed run matches children back to their
lanes and never re-plans. The peek's grant is the *intersection* of the node's
own read-only tools with `read_file` / `search_references` / `glob`, capped at
six tool calls — it establishes shape, not content.

**Addressing the subject (D38).** When a `repo` run input feeds the fan-out, the
lanes hold two roots at once: the read-only clone they were sent to read, and
this project's own workspace, reachable from the same two tools with only a path
prefix between them. A lane that calls `read_file("src/index.js")` gets OUR code
and reports on it as if it were the subject. Three things close that:

- the shared preamble carries an **addressing block** naming the reference, the
  scoping rule, and — the line that does the work — what a bare path actually
  returns and why it is not evidence;
- every file tool result opens with the root it came from
  (`[from reference:<name> — a read-only clone, NOT this project]`);
- `search_references` defaults its `repo:` to the subject, because the library is
  shared and an unscoped search returns other people's repositories. `repo: "*"`
  opts out, deliberately; and
- `glob` accepts `dir: "reference:<name>[/subdirectory]"` and returns addresses
  that can be passed straight to `read_file`, so discovering a reference tree
  does not require guessing paths or falling back to workspace files.

A bare workspace read is **logged, not blocked** (`tool_target_unexpected`): a
lane comparing subject to home is legitimate, so this is visibility rather than a
wall. A node that reads the workspace by design (`orient`) is exempt.

**Where the mission comes from.** With an upstream `orient` node (§7f), the
planner inherits `mission`, `focus` and `ignore` from a step that has actually
read both repositories, and its job narrows to choosing a roster. Without one it
derives them from the prompt, as before.

Artifacts: `nodes/<id>.lanes.md` (the roster), `nodes/<id>.brief.md` (why these
lanes), `nodes/<id>.peek.md` (the look), `nodes/<id>.md` (the aggregate).

---

### 7c. Sub-flow Node (a flow as a brick)

**shape:** `flow: <flowId>` (the third node shape, beside `use:` and `type:`;
canonically `type: subflow`) · icon `⧉`

**Input:** whatever feeds the call site.

**Output ports:** one per node feeding the referenced flow's `output` node,
addressable as `<call>.<inner-node-id>`. The primary output is the sub-flow's
result.

**Behavior:** an **inline splice**, not a nested run (D36). At run start the
referenced flow is resolved and its nodes are spliced into the run graph as
children of the call site, ids namespaced `<callId>__<innerId>`. There is one
run folder, one snapshot and one canvas; gates, resume, the scheduler and the
run canvas all see an ordinary graph. A nested FlowRunner would fragment run
state across run folders and break the live canvas — the transparency window
the whole product rests on (D1, D4).

The inner `input` node is not spliced: its consumers are re-sourced to the call
site's own sources, so upstream context reaches them normally rather than
through a placeholder with no output. The inner `output` node IS the call site.

**Gates inside a sub-flow pause the run** (D36). An orchestrator or
fan-out forces its children autonomous because a MODEL invented them; a
sub-flow's nodes were authored by a human who put that gate there on purpose,
so `requiresApproval` survives the splice. With an inline splice there is one
run, so there is nothing separate to park into — and the runner already knows
whether anyone is watching, via the run's `approvalMode`.

**Parameterisation (D27/D36):** `mode:` picks one of the referenced flow's saved
configs, `overrides:` tweaks its inner nodes ad hoc. No new concept — a mode is
already "a per-node override map applied at a point in time" (D27), and a call
site is just another such point.

**Guards:** `unknown-flow`, `flow-cycle` and `flow-depth` (cap 3, counting
every container) run at lint time and again at run start. A run whose splice
would exceed 400 nodes fails at start with a clear error rather than degrading
the canvas silently.

**Versioning honesty (D36):** a sub-flow is referenced by id and resolved at
run start — editing the inner flow changes every caller. That is intended (a
brick you improve improves everywhere) and a real hazard, so the run snapshot
records the spliced graph verbatim. Pinning by version is deliberately not
built; revisit if it bites.

---

### 7d. Backlog Plan Node (flow → backlog contract)

**role:** `plan-backlog` · **template:** `backlog-plan` · icon `≡`

**Output ports:** `tasks` — a strict fenced JSON array of backlog task records.

**Behavior:** turns analysis into QUEUED WORK. Prose rationale first, then one
fenced JSON block matching `core/backlog.js` field-for-field:

```json
[{ "title": "...", "goal": "...", "doneWhen": ["..."], "value": 1-5,
   "effort": 1-5, "level": "low|medium|high|xhigh|max", "gates": ["npm test"],
   "blastRadius": ["src/x.js"], "dependsOn": ["title of another task here"],
   "evidence": [{ "claim": "behavior being transferred",
     "ref": "reference:repo/full/path.js", "line": 42,
     "excerpt": "exact text from that line" }] }]
```

Validated by `core/nodes/backlogPlan.js`. A task with no `goal`, or with no
checkable `doneWhen`, is rejected — **a task nobody can verify is not a task**,
and a backlog full of those is worse than an empty one. `dependsOn` names
another task in the same plan by title; ids do not exist until `Backlog.add()`
allocates them, so the reference is resolved after enqueue. Fields outside the
contract are dropped rather than written into the frontmatter forever, which is
also why a plan cannot declare its own work already `landed`.

Tasks that mention `reference:<name>/<path>` must include a matching structured
evidence entry. At the Loop hand-off, the repository name must belong to the
current run, the path and line must exist in the pinned clone, and the excerpt
must occur on that exact line. Any miss rejects the whole hand-off before
`Backlog.add()` runs, so a plan cannot partially queue verified and unverified
work. Verified evidence, including the machine-read commit, is written into the
task body for the worker that eventually claims it.

A Loop node may set `requireEvidence: true` for a reference-transfer workflow.
Then every proposed task needs at least one verified citation from a repository
pinned by that run, even if the task edits only local files. This keeps a weak
analogy from becoming durable work merely by omitting the external path from its
goal.

Ships gated (`requiresApproval: true`): handing a machine a night of work is
exactly the decision a human should see first.

**It can read this project** (`tools: ["glob", "read_file"]`, D38). `blastRadius`
and `gates` describe the workspace, and this node used to hold no tools at all —
so every path and every command in them was invented, and the loop was what
found out. With a read grant they are checkable claims: confirm a path before
naming it, take gates from the commands the project actually has, and where the
relation is `empty`, name the files the task will CREATE and say so.

---

### 7e. Loop Node (enqueue, then wait for terminal)

**type:** `loop` · icon `↻`

**Output ports:** `report` — what landed, what failed, what is waiting on you.

**Behavior:** the doorway into the loop D35 already built. It adds **no**
autonomy — every decision, edit and merge belongs to the supervisor, with its
budget ceilings, gates, heartbeats and canary. This node enqueues via
`Backlog.add` (never by writing files — `DESIGN-SPEC.md` §8's rule about the canonical
directory outside every worktree), starts or JOINS the project's supervisor
(one queue, one picker: two over one backlog would race), and waits.

`waitFor`: `all` (default) | `any` | `none`. A **parked** task keeps the node
waiting and marks it as a gate; a **failed** task is reported, not fatal.

The report is rewritten on every change, not only at the end, so a run that
waits three days says what it is waiting for the whole time.

**State is files (D36).** `runs/<id>/loop/<nodeId>.json` holds the queued ids
and the policy; the rest is re-derived from the backlog. After an app restart
the run reattaches by reading them — nothing is re-enqueued, nothing re-run.

**Budget (D35/D36):** one ledger is enough. `budgetUsd` rides on
the tasks this node enqueues, so the existing three ceilings — per task,
rolling window, project — apply unchanged. A separate worktree budget would be
a fourth ceiling that agrees with the other three until the day it does not.

---

### 7f. Orient Node (what is this workspace, and how does it relate?)

**role:** `orient` · **template:** `orient` · icon `⌖`

**Output ports:**
- `context` (primary) — the context file: what this project is, and its
  relationship to the subject
- `summary` — the same in ≤120 words, **capped in code**, safe to hand to every
  lane of a fan-out
- `stance` — the structured stance (JSON)
- `questions` — clarifying questions, present only when it had to ask

**Behavior (D38).** A flow that reads a foreign repository produces work for
**the workspace the user is standing in**, and nothing else in the flow ever
establishes what that workspace is. "What should we learn from this repo" has no
answer until you know whether we are empty, building the same thing, or building
something unrelated — the same repository read against those three situations
should produce three different rosters and three different backlogs.

It runs first, cheaply, and everything after it is aimed by its answer. It gets a
deterministic **seed** (`core/homeSeed.js`: manifest and its scripts, a depth-2
tree, the instruction files, `.flyt/config.json`, the `DECISIONS.md` titles, and
any existing context file) plus read-only tools, so it starts from the obvious
facts and spends its calls on the judgement instead.

**The four stances**, and what each one makes the rest of the flow do:

| `relation` | The reading is for | The backlog is |
|---|---|---|
| `empty` | what is worth adopting wholesale, and in what order | tasks that create files, scaffolding first |
| `similar` | where they solved what we solved worse | tasks that change existing files; "we already have X" is a finding |
| `adjacent` | the transferable mechanism, not the feature | adaptations, not ports |
| `unrelated` | say so early; read narrowly against the goal | few tasks, or an honest "nothing here transfers" |

**`unrelated` is a first-class outcome.** A flow that cannot conclude "this
repository has nothing for us" will manufacture six tasks to avoid saying it, and
those tasks reach the loop and spend real money. Orientation is the right place
to say it because it is the cheapest step in the flow — one call, before N lane
reads.

**It may ask.** Same gate as the refiner (`awaiting_input`), same one-round cap
(the per-node round budget of D46 leaves both of these at one),
same discipline: resolve ordinary ambiguity yourself as a stated assumption, ask
only about a fork you cannot responsibly pick. The case that earns a question is
an empty workspace whose prompt does not say what is being built. **Unattended
runs never park** (`approvalMode: always`): the questions are recorded as
`ASSUMED:` assumptions and logged as `orientation_assumed`, so a human reading
the run afterwards sees which forks were taken blind. A flow that can park
forever is not usable from the loop, and the loop is where these flows end up.

**`.flyt/context.md`.** On an attended run the context file is also written to
the project — per-project, version-controllable, hand-editable. The next run
seeds from it and becomes a confirm-or-revise rather than a full survey. It
carries a stamp (commit, date, subject, body hash) and is re-surveyed when HEAD
moves, when it ages past 30 days, or when it was written about a **different**
subject repository. A file edited by hand is **never** overwritten — the run
writes what it would have said to `<id>.divergence` and leaves yours alone.

Degrades all the way down (§6 of the plan): no workspace → `relation: empty`,
confidence low; unparseable stance after one re-ask → the prose stands as the
context and the stance defaults to `adjacent`, which assumes least; `.flyt/` not
writable → the run-folder copy only.

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

**Behavior (D27):** the refiner resolves ordinary ambiguity
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

### 9b. Interrogation Node (D46)

**Visual:** icon `?`, label "Interrogate", sub "interrogate · spec + questions"
**kind:** `ai`
**Type/role:** `aiStep` with `role: "interrogate"` (Node Library template
`interrogate`)

**Input:** an idea, not a request. That is the whole distinction from the
refiner above, and it is worth stating plainly: the refiner is *told* to
resolve ambiguity itself and ask only when it must, which is right for a
request that is already a request and wrong for an idea. Put a half-formed
idea through the refiner and it does not ask — it invents the missing half as
an assumption and hands the flow a confident brief for work nobody wanted.

**Ports:**

| Port | What it carries |
|---|---|
| `spec` (primary) | the settled specification: goal, non-goals, constraints, deliverable, acceptance, assumptions |
| `transcript` | every round of questions and the answers given, in order |
| `open` | what is still unsettled — assumptions taken, and questions the rounds ran out before asking |
| `questions` | the current round, while the run is parked at the gate |

**Behavior:** every turn it writes the specification as it currently stands
(never a bare list of questions — a person can only judge a question against
what the asker believes) and ends with ONE fenced JSON block:

```json
{
  "status": "asking",
  "confidence": "low",
  "questions": [{ "id": "shape", "text": "Node or flow?", "why": "changes the whole build",
                  "options": ["a node", "a flow", "both"] }],
  "assumptions": ["..."],
  "unknowns": ["..."]
}
```

`"asking"` parks the run at the same `awaiting_input` gate the refiner uses, at
most **6 questions per round**. `"settled"` ends the interrogation and releases
the spec downstream. `status` is required, and `"asking"` with no usable
question is rejected rather than coerced — otherwise a model that simply forgot
the fence would read as a finished specification.

**Rounds belong to the node (D46).** `refine` and `orient` get exactly one round
each: for them a question is an exception, and a second one means the first was
asked badly. `interrogate` gets `maxRounds` (default 3, hard ceiling 5). Each
re-run carries the whole transcript, and on the last round the node is *told* it
is the last — an interrogation that ends still asking has produced nothing.
Out of rounds, or unattended (`approvalMode: always`), the remaining questions
are recorded as explicit assumptions in `open` and the log rather than dropped.

**It reads before it asks.** The template holds `glob`, `read_file` and
`search_references` under a bounded `maxToolIterations`, and receives the same
workspace seed `orient` does. Without them it burns rounds asking what the
repository already answers, and then invents paths and command names in its
assumptions — observed, on the first tooled-up run of this very node.

Shipped in the `spec-an-idea` flow: idea → interrogation → specification →
backlog plan → queued tasks.

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

## Implementation sources

- `nodes/*.json` — shipped template records
- `src/flowTypes.js` — template resolution and renderer metadata
- `core/planEval.js` — structured contract parsers
- `core/flowRunner.js` — execution and materialization
- `FLOW_LANG.md` — structural node syntax and lint rules

Treat the files above as the implementation when this prose and code differ. Update this contract in the same change that alters a role, port, or structured output.

---

*This document exists so that both humans and AI agents have a precise, stable contract for the nodes they can pick from and the shape of the advanced planning + reflection flows the system is designed to support.*
