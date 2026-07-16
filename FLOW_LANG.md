# FLOW_LANG — the Flow DSL (`*.flow.yaml`)

The AI-facing contract for authoring LLM Flow workflows as text. A flow file
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
`.llmflow/skills/<name>.md`; it is appended to that node's prompt at run time,
so the same flow adapts to whichever project it runs against. See
`DESIGN-SPEC.md` §6.2.

Raw nodes (`type:`) are the structural/legacy shape: `input`, `output`,
`aiStep`, `agentTask`, `orchestrator`, with their data fields flattened
(`role`, `system`, `text`, `goal`, `worker`, ...). Prefer templates; raw
nodes exist mainly so older flows keep loading.

`input` / `output` are implicit: referencing them in `flow` declares them.
Declare an input explicitly only to attach default `text:` to it.

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
