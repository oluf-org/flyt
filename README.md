# Flyt

Flyt is a desktop app for composing and running inspectable AI work. The shipping interface calls a reusable launchable stack a **Workflow** and has two permanent surfaces: **Work** for running and watching, and **Build** for visual/YAML editing and browsing contributions. **Trace** opens over either surface for the durable run record.

## What ships

- **Plugins** contribute blocks, tools, skills, and typed UI extensions.
- **Stacks** compose blocks through bounded containment in `.stack.yaml` files.
- **Runs** use an append-only session log and rebuildable artifact projection.
- **Loop** works a file-backed backlog in isolated git worktrees, runs declared gates, requests independent review, tracks spend, and canaries every merge.

The built-in `mock` provider works without credentials. Real models can be connected through provider API keys or explicitly enabled vendor CLI runtimes.

## Run locally

```sh
npm install
npm run dev
npm start
npm test
npm run stack -- lint
```

Build installers with `npm run dist`, or use `dist:win`, `dist:mac`, and `dist:linux` for one platform.

## Durable files

```text
stacks/<id>.stack.yaml          canonical stack source; layout is derived
plugins/<id>/                  bundled plugin contributions
tools/<id>.json                tool definitions
tools/sets/<id>.json           reusable ceilings
runs/<runId>/session.jsonl     canonical run record
runs/<runId>/                  rebuildable projections and artifacts
<workspace>/.flyt/             project config, skills, backlog, and optional run data
```

An older project containing a linear `flows/*.flow.yaml` is readable through the migration path. Edge order becomes sequence order, supported structural Loop handoffs map to the registered block, and every generated `use` must resolve through the installed plugin registry before the flow can open or save. Opening does not mutate the source; the first stack write creates and validates `stacks/<id>.stack.yaml`, then retires the legacy file. A branched, disconnected, unknown, or unsupported structural graph is refused with its source intact instead of being flattened into different behavior. Layout sidecars are not carried forward because stack layout is derived.

Chat lists only stacks marked `launchable: true`. Pipeline's Low, Medium, and High choices are **modes** of one canonical Workflow — the same graph with named settings over it, Medium by default — not three workflows. A mode may change the configuration of blocks that already exist and nothing else, so a launch that names no mode runs the default one, and a different shape means a new workflow. Build opens on a gallery of every workflow in the project, with New, Duplicate and Edit, and the editor for whichever one is opened. A run replaces the composer with the same deterministic block program used by Build, streams state and output in place, recovers pending approval/question prompts after a renderer reconnect, and ends with an optional no-tool supervisor summary below the stack. Follow-ups create linked immutable runs rather than mutating completed work.

## Headless and Loop use

`flyt` exposes the core command map for diagnostics, providers, tools, projects, runs, and the Loop supervisor. Machine-readable commands accept `--json`. `flyt why`, `flyt doctor`, and `flyt probe` expose run and provider evidence without requiring the desktop UI.

The compatibility execution path used by the current Loop supervisor retains its internal flow-shaped contracts while projects migrate; those names are isolated from the shipping Work/Build product model and from canonical stack files.

## Repository map

- `kernel/` — typed Cordis services, stack grammar, block registry, runner, and session log
- `core/` — stores, adapters, tools, diagnostics, and the Loop harness
- `src/v2/` — Work, Build, Trace, Library, and typed contribution renderers
- `electron/` — desktop host and IPC boundary
- `stacks/` — shipped canonical stacks
- `plugins/` — shipped block/tool/skill contributions
- `tests/` — unit, integration, harness, and compatibility coverage

Read [`GOALS.md`](./GOALS.md), [`DESIGN-SPEC.md`](./DESIGN-SPEC.md), and [`DECISIONS.md`](./DECISIONS.md) before changing architecture. Stack grammar is in [`STACK_LANG.md`](./STACK_LANG.md); block contracts are summarized in [`BLOCKS.md`](./BLOCKS.md); tools are covered by [`TOOLS.md`](./TOOLS.md).
Plugin authoring, composition, and lifecycle are covered by [`docs/plugin-system.md`](./docs/plugin-system.md).
