# Flyt blocks

A block is one executable step contributed by a plugin. A stack references it with `use: plugin:block`; `ctx.blocks` is the only registry that resolves that name. The same definition supplies execution, Build's configuration form, the unified Library entry, structured outputs, and the static tool ceiling. There is no parallel node-template catalog on disk.

## Built-in block plugins

| Plugin | Blocks | Purpose |
|---|---|---|
| `flyt-blocks-core` | `work`, `research`, `general-analysis`, `combine`, `split`, `plan-start` | Bounded repository work, untrusted web reading, and general transformations |
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

Classification is not a grant. A plugin tool arrives unclassified and unreachable; conservative inference proposes effects, a human may confirm or make them stricter, and a stack still has to name a ceiling that reaches it. A skill's `requiresTools` is likewise a request, never authority and never allowed above the block's static ceiling.

## Composition

Blocks live inside `sequence`, `parallel`, `repeat`, `foreach`, `until`, and `if` containers. Containment is the graph. A sequence passes its result forward; parallel lanes receive the same input and remain isolated until the container aggregates them. Repetition and predicates are statically bounded before execution. See [`STACK_LANG.md`](./STACK_LANG.md) for the exact grammar.

## Execution and evidence

The kernel runner resolves every `use` before spending, intersects the run and block ceilings, and executes tools only through `tools/pre-execute`. Each durable step appends to `session.jsonl`; Work and Trace fold the same log, and the run folder is a rebuildable projection. A block that fails, stops, or loses a tool response remains visible as that state rather than as an empty success.

## Adding a block

1. Add it to a plugin and register it through `ctx.blocks.register()`.
2. Give it a closed settings schema, explicit outputs, and the narrowest useful ceiling.
3. Test registry resolution, execution, missing-block behavior, and any structured output used by a container.
4. Add it to a shipped stack only after `npm run stack -- lint` accepts that stack.

Do not add `nodes/*.json`, a renderer-only description, or a second execution path. Those are retired v1 surfaces.
