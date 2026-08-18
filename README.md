# Flyt

Flyt is a desktop app for building and running inspectable AI workflows. A user picks a flow, enters a request, and watches the work move through a live canvas. The same engine also powers the headless CLI and the autonomous Loop.

## What ships

- **Projects** bind a tab to a workspace folder.
- **Node templates** define reusable behavior, models, tools, and skills.
- **Flows** connect templates and structural nodes in an AI-authorable `.flow.yaml` format.
- **Runs** stream output, preserve artifacts, support approval gates, and can resume without repeating completed nodes.
- **Composition** includes typed inputs, fan-out lanes, sub-flows, and a flow-to-backlog Loop handoff.
- **Loop** works a file-backed backlog in isolated git worktrees, runs declared gates, requests review, tracks spend, and lands verified changes.

The built-in `mock` provider works without credentials. Real models can be connected in Settings with provider API keys or explicitly enabled vendor CLI runtimes.

## Run locally

```sh
npm install
npm run dev       # Vite hot reload + Electron
npm start         # production renderer build + Electron
npm test          # headless test suite
```

Build installers with `npm run dist`, or use `dist:win`, `dist:mac`, and `dist:linux` for one platform.

## Headless use

`flyt` exposes the same command surface as the desktop app. Machine-readable commands accept `--json`; structured output goes to stdout and human diagnostics go to stderr.

```sh
npx flyt flows
npx flyt run learn-from-repo --in repo=<url> --in goal="What should we adopt?"
npx flyt runs
npx flyt why
npx flyt doctor --flow <id>
npx flyt probe <model>
```

`flyt why` inspects an existing run, `probe` tests one model at a realistic budget, and `doctor` checks provider and flow configuration without starting a full run.

## Files and storage

Durable state is plain files:

```text
nodes/<id>.json                 reusable node templates
tools/<id>.json                 tool definitions
flows/<id>.flow.yaml            flow structure
flows/<id>.layout.json          app-managed canvas positions
runs/<runId>/                   run snapshot, outputs, logs, calls, and tool artifacts
<workspace>/.flyt/              project config, skills, context, and optionally run data
```

In development, global stores use the checkout. Packaged builds seed writable stores under Electron's user-data directory. Project run data follows the **Project storage** setting: inside `.flyt/` or in app data keyed by workspace path.

To promote a flow created in an installed build into the repository defaults:

```sh
npm run flow -- adopt
npm run flow -- adopt <id> --as <stable-id>
npm run flow -- lint <file>
```

## Repository map

- `core/` — orchestration, stores, adapters, tools, diagnostics, and the supervisor
- `electron/` — desktop shell and IPC binding
- `src/` — React renderer
- `flows/`, `nodes/`, `tools/` — shipped file-backed libraries
- `benchmark/` — independent Loop benchmark cases and probes
- `tests/` — headless contracts and regression tests

## Living documentation

- [`GOALS.md`](./GOALS.md) — product intent, principles, and boundaries
- [`DESIGN-SPEC.md`](./DESIGN-SPEC.md) — current architecture and safety contracts
- [`DECISIONS.md`](./DECISIONS.md) — concise durable decisions and unresolved choices
- [`FLOW_LANG.md`](./FLOW_LANG.md) — flow DSL grammar and lint rules
- [`FLOW_NODES.md`](./FLOW_NODES.md) — node roles, ports, and structured output contracts

Implementation plans are intentionally not kept as living documentation after they land. Git history preserves them; current work belongs in `.flyt/backlog/`.
