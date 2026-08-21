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
- clarifying-question nodes that park the run at an input gate, for as many
  rounds as the node declares — one for the refiner and the orientation, where
  a question is an exception; several for the interrogation, whose contract is
  to ask before it specifies;
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

Tools are file-backed definitions loaded by `core/toolstore.js`; built-ins bind those definitions to source modules. The current catalog covers workspace reads and edits, shell commands, run/task inspection, backlog operations, reference search, web fetch/search/scrape, gate execution, result retrieval, and asking a human. [`TOOLS.md`](./TOOLS.md) is the authoring contract.

The shipped `research` flow is what makes the web tools reachable from the app rather than only from the CLI: it appears in the lander's flow picker, takes a typed question, and holds the `web` and `read-only` sets together — it can search, fetch, scrape and extract, and read the project, and it can write nothing. Untrusted network text and a file writer do not belong on the same node. The backlog chat deliberately does NOT reach the web: its `enqueue_task` writes the task file immediately, so a reader of untrusted pages beside it would be a path from a web page to unattended work. Giving chat the web means making that enqueue a real proposal first.

A tool can be called once, outside a run, through `tool:run` (`flyt tools run`). That door deliberately narrows authority rather than widening it: a write, shell or destructive tool refuses unless the caller confirms, and with no run store the full result stays inline. `tool:problems` reports definitions the library holds but cannot bind, which is otherwise a silent failure — a listed tool that looks healthy and cannot run.

A capability that only exists outside JavaScript is reached through one bounded bridge, `core/python.js`. The tool supplies the script text (so what runs is in this repository) and a JSON payload on stdin; the bridge spawns an isolated interpreter, reads JSON off stdout, and bounds it with a timeout and an output cap. The interpreter is resolved and reportable — `FLYT_PYTHON`, the `python.bin` setting, the managed virtualenv under the app's user data directory, then PATH — never assumed, and a declared interpreter that is missing reports itself instead of falling through to a different Python. The environment lives outside every repository, so a Loop worker in a throwaway worktree uses the same one as the desktop app. A missing interpreter or package is a result with a remedy naming `flyt python setup`, not a traceback.

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

A run parked on a question is answerable from every surface that can show it —
the composer, the runs page, a comparison pane, and the CLI — because a
question you cannot answer from where you are standing is a run that reads as
stuck. Unattended, the questions are recorded as explicit assumptions instead
of parking forever.

Follow-up turns append a visible continuation to the run graph. Existing completed work remains immutable; new question, fix, or feature paths use prior artifacts through explicit edges.

## 8. Autonomous Loop

The Loop is a project-scoped supervisor over `.flyt/backlog/`. Tasks are individual Markdown files with structured frontmatter. The board and CLI derive blockers from the same `core/blockers.js` rules.

A task declares what it may touch (`blastRadius`), how it is judged (`gates`), what it was learned from (`references`) and what its worker needs to know (`skills`). A worktree is a checkout, so a skill file that is untracked is simply absent from it; the supervisor reports a declared skill the worktree lacks rather than leaving it in the run log. The last is resolved from the bound project's `.flyt/skills/` exactly as a template's list is and is merged into the run's resolved flow, so `runs/<id>/flow.json` records what was attached. A skill on a template says work of this kind is always done this way; a skill on a task says this particular job needs this knowledge. Neither can widen a tool grant.

For each claimable task the supervisor:

1. claims the task and creates a git worktree outside the repository, minting an `attemptId` that owns it;
2. starts a normal Flyt run of `flows/loop-task.flow.yaml` — one authored work node holding the Loop ceiling. The task file is already the plan, so the run does not plan it again, and the node that holds the tools exists before any model is called. Its grant names the `loop` set rather than inheriting the Work template's task-type grant, every one of which is a writer without a shell; `config.loop.flowId` points it elsewhere;
3. records heartbeats, model calls, tool feedback, and spend;
4. runs the task's declared gates itself;
5. requests an independent diff review;
6. merges with `--no-ff` and runs a post-merge canary; and
7. advances the known-good pin or reverts/parks the work.

A rejection at review or at gates is treated as a correction rather than a failure of the whole attempt. Both are judgements on work that exists, and both come with something specific to act on — a reviewer's sentence, or the assertion the suite named. The judged commit is recorded on the task as `resumeFrom`, the next attempt's worktree starts from it, and the brief says so, so a stray file or an unupdated test list is a correction rather than a rebuild on a dearer model. A `resumeFrom` that no longer resolves degrades to the base branch and is cleared. An empty diff and a stalled attempt clear it: there is nothing there worth inheriting.

Worktree ownership is attempt-scoped. Every claim mints an `attemptId`; the pool records `{ projectId, taskId, attemptId, runId, path, branch }` beside the worktrees and outside every repository; and every destructive operation is compare-and-delete — it names the attempt it believes it is cleaning up and refuses a path owned by a different one, reporting `removed`, `already-removed`, `owner-mismatch` or `live-owner`. Starting an attempt over a live one is refused with the owning run rather than resolved by deletion. Cleanup is idempotent, a released attempt keeps its tree for forensics without blocking the next attempt, and startup reconciliation reports orphaned records and trees rather than removing them.

Completion is effect-aware. Every node/task carries a deliverable contract — `artifact`, `workspace-change`, `either` or `none` — authored in the DSL or inferred conservatively from role, category and an authored tool grant. A baseline is captured read-only before the first tool call and compared before `done` is written; a required change that never happened records `effect_missing`, keeps the model's text as evidence rather than as a completion, and does not release downstream dependents. Loop's empty-diff rejection at landing remains as defense in depth.

Routing has one policy. The user's provider priority decides which connected provider is tried first; per-provider rankings decide which of that provider's models suits the task kind and effort. Renderer preview, `flyt doctor`, the node-start log and the adapter call read the same resolution, and every route record names the requested source, the effective provider/model, why that rung won, and which candidates were skipped — never a key. Adapter failures carry stable codes with remedies; an `auto` route may fall through to the next eligible provider on an infrastructure failure only, bounded and without revisiting a provider, while a pinned source always fails in place. Retries record an attempt, superseding the one they replace, so the newest non-superseded attempt is a node's visible state and earlier failures remain inspectable as history.

Planning is bounded and validated. Generated plans declare each task's effect, outputs, required and optional inputs, and dependencies; a plan is validated for size, producer existence, duplicate outputs and cycles before anything is materialized, with one corrective re-ask. A required input nothing produces fails before a model is called; an optional one degrades quietly. A planner streaming repetitive text with no tool call and no contract progress is interrupted on lack of novel work rather than on elapsed time.

Spend is read from each run's call trace — every settled model call, including
the calls of a node that failed and of a run that was stopped — and priced from
the provider's reported cost, falling back to the model catalog's per-token
prices and then to an explicit override table. A node's retrospective is a
summary of the calls that finished tidily, so it is the fallback for a node
with no trace rather than the source. The ceilings consult the same table the
ledger uses: a price table that is empty makes every ceiling inert, which is a
failure mode with no symptom until the bill arrives.

Per-task and rolling soft/hard spend ceilings bound unattended work. Stalls are based on lack of progress, not only wall time. Approval, budget, missing-model, dependency, lease, and gate problems park work with an actionable reason instead of blocking the whole queue.

The benchmark runs fixed cases against throwaway clones and keeps `landed` separate from independently `verified`. Reference repositories are read-only shallow clones outside the workspace; agents may search them but cannot write through the reference library.

## 9. Delivery and known gaps

Vite builds the renderer, electron-builder produces installers, GitHub Actions runs CI and release builds, and packaged apps check GitHub Releases for updates. Mutable stores never use the read-only application archive.

Current architectural gaps worth preserving as explicit choices:

- context can still balloon when no `contextSpec` is supplied;
- synchronous filesystem access assumes modest run and graph sizes;
- shell execution is controlled but not securely sandboxed;
- pending tool calls cannot be reconstructed after process death in the v1 runner (the v2 session log closes this, behind the flag — §10);
- MCP/HTTP-imported tools, a full Tools management page, and code mode are not implemented; the tool library is reachable from the CLI (`flyt tools`) but has no desktop surface;
- a killed call's spend is estimated from what it streamed, so it is bounded
  evidence rather than a measurement;
- model routing is configured rather than learned;
- sub-flow references follow the latest library version at the next run start; and
- large-graph layout and rendering are not a current target.

## 10. The v2 stack, behind a flag

A rebuild onto a Cordis plugin kernel is under way (D52-D63; the plan is `.flyt/backlog/v2-plugin-stack-plan.md`). It ships behind one flag, off by default, and this section describes what exists today rather than what is planned.

**Reading the flag.** `FLYT_V2` in the environment, `v2` in settings, or an explicit choice at the call site; the call wins, then the environment, then settings, then off. `flyt doctor` prints the state and which of those decided it. `core/v2.js` is the only module that reads it, and `bootKernel()` there is the only door into the v2 tree.

**What "off" means.** Not "disabled" — *unloaded*. The import in `bootKernel()` is dynamic and behind the check, nothing in `core/` imports `#kernel` statically, and a test asserts both. With the flag off, no v2 module is loaded, so v2 cannot alter a v1 run by existing.

**What the kernel is, with the flag on.** `kernel/` is TypeScript compiled to `kernel/dist` and imported as `#kernel`; the JS core and the renderer consume the generated types (D53). The boundary is the seam: anything a third-party plugin can touch is typed and lives there.

- **Eight capability seams** — `ctx.sessions`, `ctx.tools`, `ctx.llm`, `ctx.fs`, `ctx.shell`, `ctx.agents`, `ctx.commands`, `ctx.sandbox`. A seam is a service definition, a provider, and consumers that never learn which provider they got. `ctx.skills` also exists: not a capability seam, but the service definition dsh's skill packages register into.
- **The session log** — `runs/<id>/session.jsonl`, append-only, is the canonical record (D55). `deriveMessages()` reconstructs exactly what a model saw; a tool call with no result reconstructs as a synthetic never-returned result rather than disappearing. The run folder beside it (`meta.json`, `stack.json`, `blocks/*.md`, `tools/*.json`, `calls/*.jsonl`) is a projection, rebuildable from the log, and the ledger reads the log rather than the projection. Runs written before the log open through a read-only compatibility reader and are never converted.
- **The permission bridge** — every tool, ours or a plugin's, reaches execution through `tools/pre-execute`. Unclassified tools are in no toolset and no ceiling can name them; classification is not a grant; `ask` with nobody to ask is a denial (D57).
- **Composition** — bundles, then the profile patch, then the home patch, then the CLI overlay, a later layer replacing a row by id. One profile per surface (`flyt-desktop`, `flyt-cli`, `flyt-loop-worker`), and a narrower surface may never gain a row a broader one lacks.
- **dsh compatibility** — a pinned, real published dsh plugin loads, registers and executes against these services in CI (D54). Services on that contract are Cordis `Service` subclasses using ordinary private fields, because cordis derives a per-caller view with `Object.create()` and `#private` state is unreachable through it.

**The stack, as far as it is built.** Phase 1 (`t-0036`) is under way, decomposed into `t-0056`–`t-0063`; four have landed and they are the model the surfaces will draw rather than the surfaces themselves.

- **Containment is the graph** — `kernel/src/stack/parse.ts` reads a `stacks/<id>.stack.yaml` whose nested `blocks:` list *is* the composition. There is no `flow:` edge list and no `.layout.json`, because an edge list can disagree with the nodes and a layout file can disagree with both (D59). `Sequence` and `Parallel` are the only containers; `Repeat N`, `For each`, `Until` and `If` are refused by the name a person knows them by, naming Phase 3 (`t-0038`) as where they arrive. Hand-written on the loader's hand-written YAML subset, so the dependency-light rule holds (D24) and the contract is still typed (D53).
- **Layout is computed, never stored** — `stack/layout.ts` is a pure function of the tree: a sequence stacks its children, a parallel places its lanes side by side, a container's box encloses every child's, and a point resolves to the innermost node under it. Nothing in it reads a file, so the CLI, the editor and an agent all get the same geometry.
- **An edit may not produce what the parser rejects** — `stack/edit.ts` has insert, move, remove and configure, addressed by container and index rather than by coordinates. Moving a container into its own descendant is refused, and so is an edit that would empty a container. Every edit returns a new tree and a record of what changed, which is what the editor animates from.
- **One code path, two callers** — `flyt-api` provides `ctx.commands`, and the four edits are registered into it, in all three profiles. The caller (`human` or `agent`) is recorded rather than inferred, every invocation emits `commands/invoke` carrying the edit record — refusals included — and the tree an accepted edit produced becomes the tree in the same step (D63).

**What the flag does not switch.** Nothing user-visible yet. There is no v2 runner and no Work/Build/Trace surface; the v1 surfaces do all the real work until the Phase 5 cutover (D62). Flipping the flag on today gets a booted kernel with its seams resolved, a stack format that parses and edits, and nothing driving them.
