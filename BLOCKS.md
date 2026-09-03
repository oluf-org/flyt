# Flyt blocks

A block is one executable step contributed by a plugin. A stack references it with `use: plugin:block`; `ctx.blocks` is the only registry that resolves that name. The same definition supplies execution, Build's configuration form, the unified Library entry, structured outputs, and the static tool ceiling. There is no parallel node-template catalog on disk.

## Built-in block plugins

| Plugin | Blocks | Purpose |
|---|---|---|
| `flyt-blocks-core` | `work`, `research`, `general-analysis`, `combine`, `split`, `plan-start`, `task-graph` | Bounded repository work, untrusted web reading, transformations, and agent-planned task dispatch |
| `flyt-blocks-judgement` | `evaluation`, `compare`, `prompt-refiner` | Review, comparison, and brief refinement |
| `flyt-blocks-inquiry` | `interrogate`, `orient` | Bounded questioning and grounded project orientation |
| `flyt-blocks-loop` | `backlog-plan`, `loop-handoff` | Produce claimable tasks and hand them to Loop |

The source of these contracts is `kernel/src/plugins/blocks-*.ts`. If this document disagrees with a registered definition, the definition is authoritative and this document must be corrected.

## Definition contract

Every block declares:

- `use`: its stable `plugin:block` identity;
- `title`, `description`, and `category`: presentation shared by Build and Library;
- `settings`: the JSON Schema for `config:` in a stack;
- `outputs`: named structured fields, including their type when another container may address them;
- `ceiling`: the maximum tool reach this block may ever receive; and
- `execute`: the host-only implementation, never sent to the renderer.

Every model-backed built-in exposes `systemPrompt` in its settings. Leaving it empty uses the block plugin's standing prompt; setting it in a stack's `config:` replaces that standing prompt for that workflow instance, while `instructions` remains an append-only specialization. `task-graph` exposes two prompt boundaries because it owns two roles: `systemPrompt` replaces the planner prompt and `workerSystemPrompt` replaces the generated workers' standing prompt. The resolved config and every `message.system` are recorded with the run, so an override is inspectable after the stack changes.

Prompt refinement has a stricter interaction contract than ordinary model output. A consequential clarification must use `ask_human`; a prose question is intercepted before downstream planning, the block gets at most one human-question call, and an exhausted or unusable Free refiner degrades visibly to the original request plus any answer instead of forwarding an unanswered question or stopping the workflow.

Classification is not a grant. A plugin tool arrives unclassified and unreachable; conservative inference proposes effects, a human may confirm or make them stricter, and a stack still has to name a ceiling that reaches it. A skill's `requiresTools` is likewise a request, never authority and never allowed above the block's static ceiling.

## Composition

Blocks live inside `sequence`, `parallel`, `repeat`, `foreach`, `until`, and `if` containers. Containment is the graph. A sequence passes its result forward; parallel lanes receive the same input and remain isolated until the container aggregates them. Repetition and predicates are statically bounded before execution. See [`STACK_LANG.md`](./STACK_LANG.md) for the exact grammar.

`flyt-blocks-core:task-graph` is a leaf in the authored language and a run-time container in Work. Its planner produces a bounded DAG; validation rejects unknown dependencies, duplicate outputs, missing required producers, and cycles before child work is announced. An explicitly read-only brief also rejects any generated non-empty `writeFiles` scope before a child exists. Data producers and same-file writers receive deterministic edges, then ready tasks run in bounded waves. A generated task with an empty `writeFiles` declaration receives a read-only ceiling, so an analysis worker cannot spend its turn requesting writers or shell. The generated child blocks are durable run events nested under the authored block, never edits silently written back to the workflow.

## Execution and evidence

The kernel runner resolves every `use` before spending, intersects the run and block ceilings, and executes tools only through `tools/pre-execute`. Each durable step appends to `session.jsonl`; Work and Trace fold the same log, and the run folder is a rebuildable projection. A block that fails, stops, or loses a tool response remains visible as that state rather than as an empty success.

Every model query also records its assembled messages, offered tools, token ceiling, route, attempts, finish reason, usage, internal reasoning, and visible response as distinct fields. A failed block can be retried in place: completed upstream blocks remain complete and only the selected block and its downstream generated work run again.

Working-agent round limits are soft for a watched block. The default warning threshold is 120 rounds; crossing it records a visible warning and the worker continues until it answers or is cancelled, with later warnings at exponential milestones. Worker queries allow 32,768 output tokens by default. A provider `length` stop records a warning and continues in a new query rather than making a partial response look finished. Small structural and clarification turns may still declare a hard bound.

A generated Plan & dispatch worker is bounded. Its profile still warns at the soft threshold, but `workerMaxSteps` (default 200) is a hard bound: at that round the harness records a `hard_step_limit` warning, withdraws every tool, and gives the worker a few answer-only turns to deliver from the evidence it already holds. A worker that still requests tools through those turns fails as incomplete instead of running until a person stops it. `hardMaxSteps` gives an authored `work` block the same bound when a stack wants it.

Every context checkpoint written during compaction names the tool calls whose results were compacted, so a worker with a bounded window can cite what it already read or read a narrower range instead of opening the same file again. A shell result that was refused or could not be confined carries an error and is never counted as durable progress, so it cannot reset loop detection or write a checkpoint. When the execution world reports that confined commands are unavailable, `work` and its generated children withhold `bash` and `run_gate` before the request is built, record a `commands_unavailable` warning, and tell the model to inspect with readers and say which verification it could not run.

## Adding a block

1. Add it to a plugin and register it through `ctx.blocks.register()`.
2. Give it a closed settings schema, explicit outputs, and the narrowest useful ceiling.
3. Test registry resolution, execution, missing-block behavior, and any structured output used by a container.
4. Add it to a shipped stack only after `npm run stack -- lint` accepts that stack.

Do not add `nodes/*.json`, a renderer-only description, or a second execution path. Those are retired v1 surfaces.
