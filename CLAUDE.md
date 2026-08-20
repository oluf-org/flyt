# Contributor guidance

## Read first

1. `GOALS.md` for intent and boundaries.
2. `DESIGN-SPEC.md` for current architecture and safety contracts.
3. `DECISIONS.md` for durable choices and unresolved decisions.
4. `FLOW_LANG.md` and `FLOW_NODES.md` when changing flow syntax, linting, node roles, ports, or structured outputs.
5. `TOOLS.md` when adding or changing a tool, a toolset, or a Python sidecar.

Current work is tracked in `.flyt/backlog/`. Completed implementation plans are git history, not living documentation. Do not create a new root-level plan for ordinary feature work; use the backlog and promote only durable decisions into `DECISIONS.md`.

## Standing rules

- Flyt is the product; a flow is the domain object. Do not rename `.flow.yaml`, `flowlang`, `FlowRunner`, `flow.nodes`, `FLOW_LANG.md`, or `FLOW_NODES.md`. `core/brand.js` owns brand literals and legacy migration names.
- Durable coordination is file-backed. Preserve the storage-root split and project scoping described in `DESIGN-SPEC.md`.
- Projects use `.flyt/`; `.llmflow/` exists only as a migration input.
- Preserve approval, confinement, tool-ceiling, worktree, gate, review, and spend boundaries. A convenience feature may narrow authority but must not silently widen it.
- Keep the flow DSL's hand-written strict YAML subset dependency-free. Run its linter after DSL or node-contract changes.
- Templates define how; tasks define what. Skills add instructions and never grant tools.
- Missing tools, skills, models, providers, and degraded fallbacks must be explicit in artifacts or diagnostics.
- Do not turn the DSL into a general expression language. Composition nodes are bounded and visible; arbitrary conditionals remain outside scope.
- Update living docs to describe current behavior. Historical acceptance transcripts and implementation diaries belong in git history.

## Verification

Run the smallest relevant tests while iterating, then `npm test` for cross-cutting changes. Run `npm run flow -- lint` after changing shipped flows, the DSL, template resolution, or tool-grant linting.
