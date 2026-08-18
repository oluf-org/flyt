# FLOW_LANG — the Flow DSL (`*.flow.yaml`)

The AI-facing contract for authoring Flyt workflows as text. A flow file
defines **structure** (nodes, template refs, overrides, relations, ports,
approval gates); canvas positions are presentation and live in a sidecar
`flows/<id>.layout.json` written only by the app. A flow with no layout file
renders via auto-layout, so you never need to think about coordinates.

## Authoring loop (for an AI)

```
1. npm run flow -- templates --json      # what templates, ports, overrides exist
2. write flows/<id>.flow.yaml
3. npm run flow -- lint flows/<id>.flow.yaml --json
4. fix findings, repeat 3 until "ok": true
```

The flow then appears in the app's workflow dropdown automatically; a human
runs and approves it. The runner refuses to start a flow that fails the
structural rules, so linting first is not optional in practice.

## File format

```yaml
version: 1                   # required, always 1
id: my-flow                  # required, [a-zA-Z0-9_-]+, must match the filename
name: My flow                # required, human label
description: One line.      # optional

nodes:                       # node id -> definition; ids are YAML keys, so unique by construction
  plan:
    use: plan-start          # a Node Library template id ...
    title: Planning          # ... plus any allowed overrides, flattened
  route:
    use: plan-eval
    requiresApproval: true   # human gate before this node runs
  draft:                     # OR a raw node: `type:` instead of `use:`
    type: agentTask
    title: Draft
    goal: Draft the copy.
    worker: { provider: openrouter, model: some/model }

flow:                        # relations; the ONLY non-YAML syntax in the file
  - input -> plan            # `input` / `output` are implicit built-in nodes
  - plan.tasks -> route      # `.port` picks a named output of the source
  - route -> draft -> output # chains are allowed
```

### `flow` entry grammar

```
source[.port] -> target [-> target2 ...]
```

Each element is a node id (`[a-zA-Z0-9_-]+`) with an optional `.port` naming
which declared output of the source feeds the edge (omitted = primary output,
i.e. the template's first declared port). A port on the last element is an
error — nothing consumes it. That one regex-checked arrow string is the whole
custom syntax; everything else is plain YAML.

### Nodes

Template instances (`use:`) accept these overrides: `title`, `worker`
(`{ provider, model }`), `instructions`, `requiresApproval`, `goal`,
`category`, `contextSpec`, `skills`, and — on agentTask templates only —
`tools` (registry: `write_file`, `create_task`, `write_task_md`).

`skills` names expertise the **bound project** supplies as
`.flyt/skills/<name>.md`; it is appended to that node's prompt at run time,
so the same flow adapts to whichever project it runs against. See
`DESIGN-SPEC.md` §6.

Raw nodes (`type:`) are the structural/legacy shape: `input`, `output`,
`aiStep`, `agentTask`, `orchestrator`, `fanout`, with their data fields flattened
(`role`, `system`, `text`, `goal`, `worker`, ...). Prefer templates; raw
nodes exist mainly so older flows keep loading.

`input` / `output` are implicit: referencing them in `flow` declares them.
Declare an input explicitly only to attach default `text:` to it.

### Fan-out lanes (`type: fanout`)

A fan-out runs **N deliberately different takes on ONE brief**, each in its own
node inside the box. By default its children come from a lane list you wrote, so
it needs no planning call and has no contract to violate; `plan: auto` (below)
lets it choose the roster from the brief instead.

```yaml
nodes:
  look:
    type: fanout
    title: Five reads
    goal: Read this repository and say what matters.
    template: general-analysis      # which template each lane instantiates
    lanes:
      - standard                    # a bare string is shorthand for that preset
      - id: wild
        preset: wildcard
        worker: anthropic/claude-sonnet-5   # a plain model id, or { provider, model }
      - id: attack
        preset: adversarial
        instructions: Focus on the auth module.   # appended after the preset
```

Lane fields: `id`, `label`, `intent` (one line, shown to the OTHER lanes),
`preset` (`standard` | `architecture` | `wildcard` | `adversarial` |
`contrarian`), `instructions`, `system` (this lane's role prompt, composed after
the preset's), `emphasis` (at most one sentence narrowing the lane inside its
preset), `worker`, `template`, `tools`. Everything is optional — an id is
derived from the label, then the preset, then the position.

Instead of (or as well as) `lanes:`, point the node at a named model set with
`modelSet: <setId>` (Settings → Models → Model sets) and it mints **one lane
per member**, optionally shaped by `modelSetPreset:`. Members that are no
longer active models are skipped rather than minted as lanes that cannot run.

Each lane's prompt carries the shared `goal`, its own instructions, and the
labels + intents of its siblings, with the instruction to surface at least one
finding no other lane is positioned to reach. **Lane outputs never cross** —
sharing them would collapse the divergence the node exists to produce.

**Planning the roster (`plan: auto`, D37).** Off by default. Set it and the node
takes one bounded read-only look at the subject, then asks a model which lanes
*this* brief needs — repeating a preset where the brief calls for it (three
architecture readers when the question is structural) and dropping one it does
not. The planner picks from the preset list and cannot write what a lane is.

```yaml
    plan: auto        # 'auto' | 'off' (default)
    minLanes: 2       # default 2
    maxLanes: 6       # default 6
```

Your authored `lanes:` stay as the fallback — a planner that fails runs them
instead, so deleting them turns a degraded run into a failed one. Two lanes of
the same preset are always staffed on different models; when the models run out
the roster is truncated rather than doubled up. A `system:` on the fan-out node
is the shared preamble written by hand: it wins outright and skips the planner.

Ports: `results` (primary, one labelled section per lane), `lanes` (the roster:
label, id, model, intent), and — under `plan: auto` — `brief` (why these lanes
ran) and `peek` (what the planner looked at).

### Typed run inputs (`inputs:`)

A flow could always take ONE free-text prompt. That is enough for "write me a
thing" and useless for "read THIS repository, looking for THAT" — a link pasted
into prose is just prose, and nothing downstream can act on it.

```yaml
inputs:
  repo:
    type: repo
    label: Repository
    required: true
    description: Cloned read-only before the run starts.
  depth:
    type: choice
    options: [quick, thorough]
    default: quick
flow:
  - inputs.repo -> look
  - inputs.depth -> look
```

Types: `text`, `url`, `repo`, `choice`, `file`, `model`, `modelSet`. Each gets a
control in the composer; a required one with no value **refuses the start**, so
there is no run folder and no wasted call.

Declared inputs become **one node** whose output ports are the inputs, so
`inputs.repo` is an ordinary ported edge — no templating, no `{{ }}`, no hidden
binding. Edges, ports, context assembly and the canvas all work on it without
knowing run inputs exist. As everywhere else, the PRIMARY (first-declared) port
is also the node's main output.

A **`repo`** input is the only one with a side effect: the URL is adopted into
the read-only reference library before the walk starts, and what downstream
nodes receive is `reference:<name>` rather than the URL — a name they can search
beats a URL they cannot fetch. Nodes fed directly by a repo port are granted
`search_references` and `read_file` (both read-effect, which is all an aiStep
may hold anyway), because a node handed a repository and no way to open it is
just a node holding a string.

Such a node is also **stamped with the subject** (`subjectRepo`, D38), which is
what scopes its `search_references` to that one repository, gives a fan-out's
lanes their addressing block, and makes a read of this project's own workspace
show up in the log as `tool_target_unexpected` instead of passing for a finding
about the subject. `repo: "*"` on a search opts out of the scoping.

A flow with no `inputs:` block is unchanged in every respect; the implicit
`input` node stays exactly as it is.

### Orientation (`use: orient`)

A flow that reads someone else's repository produces work for **the workspace you
are standing in**, and nothing else in the flow establishes what that workspace
is. The `orient` template (D38) runs first and cheaply, and says what this
project is and how it relates to the subject — `empty`, `similar`, `adjacent` or
`unrelated`. The same repository read against those four stances should produce
four different backlogs.

```yaml
nodes:
  orient:
    use: orient
    title: Where are we standing?
flow:
  - inputs.repo -> orient
  - orient.summary -> read      # ≤120 words, safe for every lane
  - orient -> plan              # the whole picture, for the roster and the backlog
```

Ports: `context` (primary), `summary` (capped at 120 words **in code**, because
it reaches every lane of a fan-out and a detailed shared prior collapses the
divergence a fan-out exists to produce), `stance` (JSON) and `questions`.

It may park the run at the `awaiting_input` gate exactly as the prompt refiner
does, under the same discipline and the same one-round cap — and never on an
unattended run, where the questions become recorded `ASSUMED:` assumptions
instead. On an attended run it also writes `.flyt/context.md` in the project:
stamped, re-surveyed when HEAD moves or the subject changes, and **never**
overwritten once you have edited it by hand.

### The loop node (`type: loop`)

The doorway from a flow into the autonomous improvement loop (D35). It adds no
autonomy: it enqueues the tasks a `backlog-plan` node produced, starts — or
JOINS — the project's supervisor, and stays running until they settle.

```yaml
nodes:
  plan:
    use: backlog-plan          # strict JSON contract, output port `tasks`
  work:
    type: loop
    waitFor: all               # all | any | none. Default all.
    budgetUsd: 5               # per enqueued task
    parallelism: 2
    maxTasks: 10
flow:
  - input -> plan
  - plan.tasks -> work -> output
```

`waitFor: none` is fire-and-forget: the tasks are queued and the run moves on.
A **parked** task does not fail the node and does not end the wait — D35 rule 7
says a gate parks a task and never blocks the loop, so the node surfaces the
park (its card shows `Waiting on you`, and the node reads as a gate on the
canvas) and keeps waiting. A **failed** task is reported, not fatal: "three
landed, one failed" is a result, and failing the node would throw away the
three that worked.

The state is files. `runs/<id>/loop/<nodeId>.json` records which task ids this
node queued and under what policy; everything else is re-derived from the
backlog on every poll. A run that waits three days across an app restart
reattaches by reading that file and the backlog — nothing is re-enqueued and
nothing is re-run.

Each queued task carries `sourceRunId` and `sourceNodeId` in its frontmatter,
so the Loop page can link a task back to the run that queued it.

### Sub-flows (`flow:`)

The third node shape, beside `use:` (a template) and `type:` (a raw node): a
flow used as a single node.

```yaml
nodes:
  learn:
    flow: learn-from-repo     # the flow id to run here
    mode: deep                # optional: one of that flow's saved configs
    overrides:                # optional: ad-hoc tweaks to its inner nodes
      analyse: { effort: high }
flow:
  - input -> learn
  - learn.combine -> report   # `<call>.<port>` picks one of its outputs
```

At **run start** the referenced flow's nodes are spliced into the run graph as
children of the call site, with ids `<callId>__<innerId>`. One run folder, one
snapshot, one canvas — gates, resume and the run canvas need to know nothing
about sub-flows. The inner `input` node is not spliced: its consumers are
re-sourced to whatever feeds the call site, so upstream context reaches them
the ordinary way. The inner `output` node is the call site itself.

A sub-flow's **ports** are the nodes feeding its output node, addressable from
the parent as `<call>.<inner-node-id>`. The call site's primary output is the
sub-flow's result — not everything that happened inside it, though every inner
node is on the canvas and readable.

Precedence for a spliced node's fields: **run input > call-site `overrides` >
call-site `mode` > the inner node's own override > template**.

Rules: the referenced flow must exist (`unknown-flow`); a flow may not contain
itself directly or through another flow (`flow-cycle`); containment may not
nest more than 3 deep, counting orchestrators and fan-outs too (`flow-depth`).
All three are checked at lint time and again at run start — a flow edited after
linting must not be able to recurse the engine.

A reference is **by id, resolved at run start**: improve the referenced flow
and every caller improves with it. That is the intended behaviour and a real
hazard, so the run snapshot records the spliced graph verbatim — a finished run
always shows exactly what ran.

### Containment (`parent` + `box`)

Any non-structural node may live **inside** a container's box — an
orchestrator's or a fan-out's: set `parent: <container-id>` on the node (both
`use:` and `type:` shapes).
A child keeps its normal fields; its canvas position (stored in the
`*.layout.json` sidecar) is relative to the box's top-left corner.

```yaml
nodes:
  orch:
    type: orchestrator
    box: { w: 420, h: 260 }   # box size; grown/shrunk by the editor as children move
  worker:
    use: summarize
    parent: orch              # runs inside orch's box
```

Rules: the parent must exist and be a container (`orchestrator` or `fanout`);
`input`, `output` and container nodes themselves can never be contained (one
level deep). Deleting a container deletes its children. At run time authored children
**replace** autonomous planning — the orchestrator runs exactly the nodes in
its box instead of materializing a swarm. The editor manages all of this by
dragging (drop a node onto a box to attach, drag it out to detach); hand-edit
`parent` only when you want to be explicit.

### Modes (`modes`)

A **mode** is a named, saved bundle of per-node overrides applied at run start —
one graph, several configurations ("High — Fable", "High — GPT"). Picked when
you launch the flow; it is not a fork or a version. The block is optional; a
flow with no `modes` runs in its single implicit default configuration.

```yaml
modes:
  fable-high:
    name: High — Fable          # label shown in the launch picker
    description: Fable worker on every AI node.   # optional — pickers & cards
    overrides:
      refine:      { worker: { provider: anthropic, model: claude-fable-5 } }
      orchestrate: { maxNodes: 10 }
  gpt-high:
    name: High — GPT
    derivedFrom: fable-high     # optional — lineage metadata only (see below)
    overrides:
      refine:      { worker: { provider: openai, model: gpt-5 } }
```

Two optional scalar fields sit beside `name` (DECISIONS.md D27):

- `description` — one line shown in pickers and on the config's card.
- `derivedFrom: <modeId>` — **lineage metadata only**. Duplicating a config
  copies the full override map and records the parent here; there is NO merge
  or inheritance at run time (each mode's `overrides` is always the complete
  map). The linter warns when it references a mode that doesn't exist.

Each override is keyed by node id and may set only fields that node accepts —
the same whitelist the runner enforces at launch: `worker`, `effort`,
`instructions`, `system`, `requiresApproval`, `approveToolCalls` on any AI
node, plus `category` (work nodes), `evalType` (evaluation), `language`
(translate), `minNodes`/`maxNodes` (orchestrator), `lanes`/`modelSet`/`template`
(fanout), `flowMode`/`flowOverrides` (subflow), and `tools` (agentTask).
Precedence at run time is **run input > mode > node override > template**.

### Run inputs (`expose`)

A node may declare `expose: [field, ...]` — the subset of its overridable
fields the flow author wants surfaced as ad-hoc controls in the run composer.
It is a first-class node field (like `parent`), not an override value.

```yaml
nodes:
  work:
    use: work
    category: Code general
    expose: [worker, effort]   # a model dropdown + effort control in the composer
```

At run start those composer values become launch overrides layered on top of
the chosen mode (**run input > mode > node override > template**). Each exposed
field must be one the node accepts, or the linter reports it (`expose`).

### YAML subset

Files are parsed by a strict subset parser (`core/flowlang/yaml.js`): block
maps/lists (2-space indent), inline `{ }` / `[ ]`, quoted strings with JSON
escapes, literal blocks `|` and `|-`, comments. No anchors, tags, folded
scalars, or multi-document files — the linter reports these as parse errors.

## Lint rules

`npm run flow -- lint <file> [--json]` — exit code 0 only when `ok: true`.
`--json` returns `{ ok, errors: [{ rule, severity, nodeId?, edge?, message }], warnings: [...] }`.

| Rule | Severity | Meaning |
|---|---|---|
| `parse` / `schema` | error | not valid DSL (YAML subset, required fields, allowed keys) |
| `unknown-template` | error | `use:` id not in the Node Library (`nodes/*.json`) |
| `unknown-node` | error | edge references an undeclared node id |
| `unknown-port` | error | `.port` not among the source's declared outputs |
| `cycle` | error | the graph has a cycle |
| `unreachable` | error | node not reachable from an input node |
| `no-input` / `no-output` | error | missing entry/exit node |
| `invalid-override` | error | override key not valid for the template (e.g. `tools` on non-agentTask) |
| `unknown-tool` | error | tool not in the registry |
| `dead-end` | warning | node output never reaches an output node |
| `duplicate-edge` | warning | same edge stated twice |
| `orphan-approval` | warning | `requiresApproval` on an input/output node |
| `parent` | error | `parent:` missing, not a container, or a structural/container node is contained |
| `fanout-lanes` | error/warning | a fan-out with no lanes or an unknown `modelSet` (error); duplicate lane ids (warning) |
| `fanout-worker` | warning | no lane names a model (N copies, not a fan-out), or a lane names a model that is not active |
| `fanout-template` | error | a lane or node `template:` that is not in the Node Library |
| `fanout-plan` | error/warning | `minLanes > maxLanes` (error); `plan: auto` with no goal and nothing wired in, or made inert by a node-level `system:` (warning) |
| `unknown-flow` | error | `flow:` references a flow that does not exist |
| `flow-cycle` | error | a flow contains itself, directly or through another flow |
| `flow-depth` | error | containment nests deeper than 3 (sub-flows, orchestrators and fan-outs all count) |

Malformed `inputs:` (an unknown type, a `choice` with no options, a default
outside its options, a node id colliding with `inputs`) is a **parse** error —
the flow does not load at all, because a run input that silently becomes text
is worse than a file that refuses.
| `mode` | error/warning | mode override field the node can't accept (error), override of a node not in the flow (warning), or a `derivedFrom` pointing at a non-existent mode (warning) |
| `expose` | error | a node exposes a field it cannot accept as a run input |

Templates are loaded at lint time, so the rules always reflect the current
Node Library rather than a stale schema.

## Examples

### 1. The default pipeline

```yaml
version: 1
id: default-pipeline
name: Default pipeline

nodes:
  plan:
    use: plan-start
    title: Planning
  route:
    use: plan-eval
    title: Routing
    requiresApproval: true
  verify:
    use: final-eval
    title: Verification

flow:
  - input -> plan
  - plan.tasks -> route
  - route -> verify
  - verify -> output
```

### 2. Parallel work with a stitch

```yaml
version: 1
id: docs-and-tests
name: Docs and tests in parallel

nodes:
  docs:
    use: documentation-step
  tests:
    use: test-creation-step
    tools: [write_file, create_task]
  stitch:
    use: stitch

flow:
  - input -> docs -> stitch
  - input -> tests -> stitch
  - stitch -> output
```

### 3. Invalid — and what the linter says

```yaml
version: 1
id: broken
name: Broken

nodes:
  plan:
    use: plan-start
    tools: [write_file]      # plan-start is aiStep: no tools
  loner:
    use: final-eval          # declared but never wired in

flow:
  - input -> plan
  - plan.nope -> output      # plan-start has no port "nope"
```

```
$ npm run flow -- lint flows/broken.flow.yaml
ERROR    invalid-override  node "plan": "tools" is only valid on agentTask templates (template "plan-start" is aiStep)
ERROR    unknown-port      edge "plan.nope -> output": node "plan" has no output port "nope" (declared: tasks)
ERROR    unreachable       node "loner" is not reachable from any input node
warning  dead-end          output of node "loner" never reaches an output node
FAILED — 3 errors, 1 warning(s)
```

## Other commands

- `npm run flow -- templates [--json]` — the Node Library catalog: per
  template its `baseType`, `category`, output ports, `allowedOverrides`, and
  (for agentTask) `availableTools`.
- `npm run flow -- migrate [dir] [--rm]` — convert legacy `flows/*.json` to
  `.flow.yaml` + `.layout.json` (`--rm` deletes the legacy files; the store
  also retires them automatically on next save).

See also: `FLOW_NODES.md` (node contracts and the reflective planning
pattern), `GOALS.md` (product principles), `core/flowlang/` (implementation:
parse / serialize / schema / lint / cli).
