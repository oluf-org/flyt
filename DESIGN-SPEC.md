# Flyt — current design

This document describes the architecture that exists now. It is not a roadmap. Proposed features belong in the backlog; durable changes to the rules belong in [`DECISIONS.md`](./DECISIONS.md).

## 1. Durable state and storage roots

Plain files are the durable source of truth. Process-local maps are allowed for live promises, subscriptions, and locks, but the app must recover an honest state when those disappear.

- `projectRoot` contains bundled, read-only application assets.
- `dataRoot` contains writable global libraries. In development it is the checkout; in a packaged build it is Electron user data.
- A project is a workspace folder. Project configuration and shareable skills use `<workspace>/.flyt/`.
- Generated project data follows the Project storage setting: `.flyt/` in the workspace or app data keyed by the workspace path.
- The legacy `.llmflow/` name is read only for migration and is adopted as `.flyt/` on the first write.

Important file contracts:

```text
nodes/<id>.json                 node template
tools/<id>.json                 tool definition
tools/sets/<id>.json            reusable tool ceiling/grant
flows/<id>.flow.yaml            flow source
flows/<id>.layout.json          presentation-only positions
runs/<runId>/flow.json          resolved, self-contained run graph
runs/<runId>/meta.json          stage, statuses, gates, errors, workspace
runs/<runId>/nodes/*.md         node output
runs/<runId>/tasks/*.md         executor output
runs/<runId>/calls/*.jsonl      model-call records
runs/<runId>/tools/*.json       complete tool results
runs/<runId>/log.jsonl          append-only audit trail
```

## 2. Projects and application surfaces

A project tab identifies one workspace. The renderer is a single React tree; switching tabs swaps the project-scoped view state while work continues in the main process. IPC calls that act on project data carry `projectId`, and stale pushes for another project are ignored.

Flows, node templates, tool definitions, model settings, and reference repositories are global reusable libraries. Runs, backlog tasks, context, skills, chats, spend, and Loop status are project-scoped.

The main surfaces are the lander/composer, flow canvas, run feed/canvas, Nodes library, Models and Settings, Repositories, and the Loop board. There is no separate execution path behind each surface: Electron IPC, the CLI, and the loopback HTTP server bind the command map in `core/api.js`.

## 3. Flows and execution

`core/flowRunner.js` is the execution engine. At run start it resolves templates, modes, run overrides, typed inputs, model sources, tool grants, and sub-flow references into `flow.json`. Editing a library item later cannot change what an existing run records.

The scheduler recomputes readiness after each wave and runs independent `aiStep` and `agentTask` nodes up to `maxParallel`. Nodes with approval interactions are serialized where simultaneous gates would be ambiguous. Task claims are persisted before execution so two drains cannot take the same task.

Supported composition includes:

- typed run inputs represented by a visible `inputs` node;
- template instances with local overrides;
- bounded orchestrator containers;
- fan-out lanes that share a brief but not each other's output;
- sub-flows spliced into the resolved run graph with namespaced ids; and
- backlog-plan and Loop nodes that enqueue project tasks and wait on file-backed status.

Sub-flows are static composition. The DSL deliberately has no expression language or arbitrary conditional branching. See [`FLOW_LANG.md`](./FLOW_LANG.md) for grammar and lint rules and [`FLOW_NODES.md`](./FLOW_NODES.md) for roles, ports, and structured outputs.

## 4. Context and artifacts

A node receives its task, selected upstream outputs, template instructions, instance instructions, project skills, and any explicit `contextSpec`. When no narrow context is declared, upstream content may still be broad; automatic context-strategy selection remains an open design choice.

Skills are names on a template, resolved at run time from `.flyt/skills/<name>.md`. Names are validated and paths are confined. A missing skill is logged and skipped, never silently treated as present and never fatal to the run.

Every model and tool interaction leaves evidence. Tool results are stored in full while the model receives a bounded preview plus a handle. Summary nodes are run artifacts with provenance; they do not mutate the source flow. Retrospectives describe problems and tool experience but do not autonomously rewrite routing or prompts.

## 5. Tools and safety

Tools are file-backed definitions loaded by `core/toolstore.js`; built-ins bind those definitions to source modules. The current catalog covers workspace reads and edits, shell commands, run/task inspection, backlog operations, reference search, web fetch/search, gate execution, result retrieval, and asking a human.

Grants are two-tier:

- a static `toolCeiling` is the maximum a node or container may receive;
- the runtime grant must be a subset of that ceiling; and
- children inherit and may narrow a parent ceiling, never widen it.

Tool effects, scope, risk, source, and trust drive gating. File paths resolve through the bound workspace. Shell commands are not a sandbox and may escape their working directory, so approval remains the stronger boundary.

Approval modes are captured per run:

- `ask` pauses before project writes and shell commands;
- `smart` allows deterministic low-risk operations, blocks known-dangerous patterns, and uses a fail-closed model check for ambiguous calls; and
- `always` runs unattended and is explicitly presented as dangerous.

Loop work adds git-worktree isolation, declared gates, a reviewer model, a post-merge canary, and spend caps. These controls reduce risk; they do not turn arbitrary model-generated shell into a secure sandbox.

## 6. Models and provider authentication

Provider adapters share `callModel()`, streaming, retry, timeout, usage, and error contracts. Supported routes include direct API providers, OpenRouter, the mock provider, and explicitly enabled vendor CLI runtimes.

Resolution uses a pinned source when one is chosen; otherwise it walks the configured provider priority and selects the first connected provider that can serve the model. Node/category configuration and Loop effort bands select models without requiring a routing model call. A learned capability matrix or LLM tiebreaker is a possible extension, not current behavior.

API keys remain in user settings and are never written into run artifacts. Subscription-backed adapters delegate sign-in, token storage, refresh, and model invocation to the vendor CLI. Flyt does not copy or implement the vendor's OAuth flow. These adapters require explicit opt-in and display a provider-usage warning.

The Models page ranks a separate “Popular on OpenRouter” creator section from OpenRouter's trailing public token-usage dataset, caches its source date, and keeps the remaining creators alphabetical. Popularity is presentation metadata only: it never changes routing or pins, and a missing or stale ranking degrades to the ordinary alphabetical catalog.

## 7. Run lifecycle and presentation

Model output streams into run artifacts and reaches the renderer as incremental snapshot patches. Revision mismatches trigger a full resync. The canvas is editable before a run and read-only while showing the resolved run graph; node cards, the feed, and focused views share Markdown rendering.

Completed nodes survive a crash. On startup, interrupted work is reconciled to a non-running state and the user chooses Resume. Completed nodes are reconstructed from persisted status and are not re-executed. A tool approval whose call stack died is failed honestly rather than pretending the pending call still exists.

Failures retain the thrown error, node status, model-call record, and partial output. A failed node can be retried, optionally with another model. `flyt why`, `probe`, and `doctor` expose the same evidence without requiring the desktop UI.

Follow-up turns append a visible continuation to the run graph. Existing completed work remains immutable; new question, fix, or feature paths use prior artifacts through explicit edges.

## 8. Autonomous Loop

The Loop is a project-scoped supervisor over `.flyt/backlog/`. Tasks are individual Markdown files with structured frontmatter. The board and CLI derive blockers from the same `core/blockers.js` rules.

For each claimable task the supervisor:

1. claims the task and creates a git worktree outside the repository, minting an `attemptId` that owns it;
2. starts a normal Flyt run with the Loop tool ceiling;
3. records heartbeats, model calls, tool feedback, and spend;
4. runs the task's declared gates itself;
5. requests an independent diff review;
6. merges with `--no-ff` and runs a post-merge canary; and
7. advances the known-good pin or reverts/parks the work.

Worktree ownership is attempt-scoped. Every claim mints an `attemptId`; the pool records `{ projectId, taskId, attemptId, runId, path, branch }` beside the worktrees and outside every repository; and every destructive operation is compare-and-delete — it names the attempt it believes it is cleaning up and refuses a path owned by a different one, reporting `removed`, `already-removed`, `owner-mismatch` or `live-owner`. Starting an attempt over a live one is refused with the owning run rather than resolved by deletion. Cleanup is idempotent, a released attempt keeps its tree for forensics without blocking the next attempt, and startup reconciliation reports orphaned records and trees rather than removing them.

Completion is effect-aware. Every node/task carries a deliverable contract — `artifact`, `workspace-change`, `either` or `none` — authored in the DSL or inferred conservatively from role, category and an authored tool grant. A baseline is captured read-only before the first tool call and compared before `done` is written; a required change that never happened records `effect_missing`, keeps the model's text as evidence rather than as a completion, and does not release downstream dependents. Loop's empty-diff rejection at landing remains as defense in depth.

Routing has one policy. The user's provider priority decides which connected provider is tried first; per-provider rankings decide which of that provider's models suits the task kind and effort. Renderer preview, `flyt doctor`, the node-start log and the adapter call read the same resolution, and every route record names the requested source, the effective provider/model, why that rung won, and which candidates were skipped — never a key. Adapter failures carry stable codes with remedies; an `auto` route may fall through to the next eligible provider on an infrastructure failure only, bounded and without revisiting a provider, while a pinned source always fails in place. Retries record an attempt, superseding the one they replace, so the newest non-superseded attempt is a node's visible state and earlier failures remain inspectable as history.

Planning is bounded and validated. Generated plans declare each task's effect, outputs, required and optional inputs, and dependencies; a plan is validated for size, producer existence, duplicate outputs and cycles before anything is materialized, with one corrective re-ask. A required input nothing produces fails before a model is called; an optional one degrades quietly. A planner streaming repetitive text with no tool call and no contract progress is interrupted on lack of novel work rather than on elapsed time.

Per-task and rolling soft/hard spend ceilings bound unattended work. Stalls are based on lack of progress, not only wall time. Approval, budget, missing-model, dependency, lease, and gate problems park work with an actionable reason instead of blocking the whole queue.

The benchmark runs fixed cases against throwaway clones and keeps `landed` separate from independently `verified`. Reference repositories are read-only shallow clones outside the workspace; agents may search them but cannot write through the reference library.

## 9. Delivery and known gaps

Vite builds the renderer, electron-builder produces installers, GitHub Actions runs CI and release builds, and packaged apps check GitHub Releases for updates. Mutable stores never use the read-only application archive.

Current architectural gaps worth preserving as explicit choices:

- context can still balloon when no `contextSpec` is supplied;
- synchronous filesystem access assumes modest run and graph sizes;
- shell execution is controlled but not securely sandboxed;
- pending tool calls cannot be reconstructed after process death;
- MCP/HTTP-imported tools, a full Tools management page, and code mode are not implemented;
- model routing is configured rather than learned;
- sub-flow references follow the latest library version at the next run start; and
- large-graph layout and rendering are not a current target.
