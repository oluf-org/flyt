# Contributor guidance

## Read first

1. `GOALS.md` for intent and boundaries.
2. `DESIGN-SPEC.md` for current architecture and safety contracts.
3. `DECISIONS.md` for durable choices and unresolved decisions.
4. `FLOW_LANG.md` and `FLOW_NODES.md` when changing flow syntax, linting, node roles, ports, or structured outputs.
5. `TOOLS.md` when adding or changing a tool, a toolset, or a Python sidecar.
6. `.flyt/backlog/v2-plugin-stack-plan.md` before any work on the plugin kernel, the block editor, the session log, or the Work/Build/Trace surfaces.

Current work is tracked in `.flyt/backlog/`. Completed implementation plans are git history, not living documentation. Do not create a new root-level plan for ordinary feature work; use the backlog and promote only durable decisions into `DECISIONS.md`.

## The v2 rebuild

A rebuild onto a Cordis plugin kernel is approved and under way (D52-D63, plan in `.flyt/backlog/v2-plugin-stack-plan.md`, phases `t-0035`-`t-0040`). It ships behind a flag; the v1 surfaces keep doing real work until the Phase 5 cutover. Two rules govern the overlap:

- **v1 code keeps v1 names.** The rename map (flow to stack, node to block, `FlowRunner` to `StackRunner`, `flowlang` to `stacklang`) is executed once, in `t-0040`, in a single commit. Do not rename opportunistically while working on something else.
- **v2 code uses the v2 vocabulary from the start.** A new plugin, block, stack or seam is named for what it is, not for what it replaces.

Phase 0 landed on 2026-08-21 (`t-0035`, built as `t-0041`-`t-0048`). What exists is described in `DESIGN-SPEC.md` §10; the short version for anyone touching it:

- `kernel/` is TypeScript, compiled to `kernel/dist` by `npm run build:kernel`, and imported as `#kernel`. `npm test` and `npm run build` compile it first, so a change to `kernel/src` is not live until something builds it.
- `core/v2.js` is the only module that reads the flag, and `bootKernel()` there is the only import of the v2 tree. Keep it that way: a static `#kernel` import anywhere in `core/` would load v2 on startup whatever the flag says, and a test asserts there is none.
- A service on the dsh contract is a Cordis `Service` subclass with ordinary private fields. Cordis derives a per-caller view with `Object.create()`, so `#private` state is unreachable through it and a registration made without `this.ctx.effect()` outlives the plugin that made it.
- Phase 1 landed on 2026-08-22 and the handoff test passes: `loop-task` runs end to end on the
  v2 kernel, watched in Trace. `ctx.blocks`, `ctx.agents` and `ctx.llm` have providers now;
  `ctx.fs`, `ctx.shell` and `ctx.sandbox` are still declared and waiting.
- Phase 2 (`t-0037`) landed on 2026-08-22: the canonical set is ported, five stacks and the
  block and tool plugins exist, and v1 still resolves everything it did before.
- Phase 3 (`t-0038`) landed on 2026-08-24, built as `t-0093`-`t-0098`. All six containers
  parse, lint, run and draw; the grammar and every bound it enforces are in `STACK_LANG.md`.
  Blocks declare their structured outputs with a type, which is what a predicate source and a
  `For each` roster are checked against. `PLANNED_KINDS` is empty and kept for the next
  container planned before it is written. Phase 4 (`t-0039`) is open.

## Standing rules

- Flyt is the product. `flow` is the v1 domain object and `stack` is its v2 successor (D52). Within v1 code, do not rename `.flow.yaml`, `flowlang`, `FlowRunner`, `flow.nodes`, `FLOW_LANG.md`, or `FLOW_NODES.md` — those renames belong to the cutover task. `core/brand.js` owns brand literals and legacy migration names.
- Durable coordination is file-backed. Preserve the storage-root split and project scoping described in `DESIGN-SPEC.md`. In v2 the canonical record is the append-only session event log and the run folder is a projection written beside it (D55); either way, correctness may not depend on memory surviving.
- Projects use `.flyt/`; `.llmflow/` exists only as a migration input.
- Preserve approval, confinement, tool-ceiling, worktree, gate, review, and spend boundaries. A convenience feature may narrow authority but must not silently widen it. This applies unchanged to tools contributed by third-party plugins: they arrive unclassified and ungranted, inference may only err toward restriction, and classification is not a grant (D57).
- Keep the flow DSL's hand-written strict YAML subset dependency-free. Run its linter after DSL or node-contract changes. D24 is scoped to the parser and the core command surface; the plugin kernel is allowed a real dependency (D53).
- Templates define how; tasks define what. Skills add instructions and may *request* tools (D58) — only a human grants the request, never above the block's static ceiling, and never unattended. A skill still cannot widen a grant on its own.
- Missing tools, skills, models, providers, and degraded fallbacks must be explicit in artifacts or diagnostics.
- Do not turn the DSL into a general expression language. Bounded iteration and structured `source / operator / literal` predicates over declared outputs are in scope (D56); arbitrary expressions, arithmetic, and free boolean algebra are not, and a request for them is a decision for a human rather than a widening to slip in.
- Update living docs to describe current behavior. Historical acceptance transcripts and implementation diaries belong in git history.

## Verification

Run the smallest relevant tests while iterating, then `npm test` for cross-cutting changes. Run `npm run flow -- lint` after changing shipped flows, the DSL, template resolution, or tool-grant linting.
