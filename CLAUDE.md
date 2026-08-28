# Contributor guidance

## Read first

1. `GOALS.md` for intent and boundaries.
2. `DESIGN-SPEC.md` for the architecture and safety contracts that exist now.
3. `DECISIONS.md` for durable choices and unresolved decisions.
4. `STACK_LANG.md` and `BLOCKS.md` for stack grammar, containers, block definitions, outputs, and ceilings.
5. `TOOLS.md` for tool definitions, effects, toolsets, and the Python sidecar.

Current work belongs in `.flyt/backlog/`. Completed plans belong in git history; do not keep an implementation diary as living architecture.

## Current architecture

- `kernel/` is TypeScript, compiled by `npm run build:kernel` and imported as `#kernel`. `npm test` and `npm run build` compile it first.
- The shipping renderer is `src/v2/`: Work and Build are permanent; Trace opens over either. There is no v1 route.
- `stacks/*.stack.yaml` is canonical composition. Containment is the graph and layout is derived; never add a layout sidecar.
- `ctx.blocks` is the single block registry. A block definition owns execution, Library metadata, settings, outputs, and its static ceiling.
- `ctx.commands` is the single edit path. Human and agent callers differ only in recorded provenance.
- `runs/<id>/session.jsonl` is the canonical run record; the run folder is a rebuildable projection.
- `core/stackRunner.js` and `core/stacklang/` are compatibility internals for the current Loop supervisor and migration. Do not expose their graph model as a product surface.
- `core/brand.js` owns old product and flow names used as migration inputs.

## Standing rules

- Preserve user changes and unrelated dirty-worktree state.
- Durable coordination is file-backed. Correctness may not depend on a process-local map surviving.
- Projects use `.flyt/`; `.llmflow/` is read only for migration.
- Preserve approval, confinement, tool-ceiling, worktree, gate, independent-review, canary, and spend boundaries. Convenience may narrow authority but never silently widen it.
- Plugin tools arrive unclassified and ungranted. Inference may only err toward restriction; classification is not a grant.
- Skills may request tools. Only a human grants the request, never above the block's ceiling and never unattended.
- Missing tools, skills, models, providers, unreturned calls, and degraded routes must be explicit in artifacts or diagnostics.
- Keep the stack parser and command surface small and inspectable. Do not turn the language into arbitrary expressions, arithmetic, or unbounded control flow.
- Update living docs to describe current behavior. Historical acceptance transcripts remain in git history.

## Verification

Run the smallest relevant tests while iterating, then `npm test` for cross-cutting changes. Run `npm run stack -- lint` after changing shipped stacks, the grammar, block output contracts, or containment bounds.
