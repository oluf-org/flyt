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
.flyt/incidents/<id>.json       a refusal nothing gets past, open until resolved
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

A task may also declare what the **suite** should do when it lands (`suiteExpectation`: `grows` | `unchanged` | `shrinks`). The two count checks — green with fewer tests, and green with the same tests while source moved — are right about the common case and wrong about a refactor, a deletion, and a consolidation. The declaration is made by whoever wrote the task, before the attempt, so it is a prediction that can be wrong rather than an excuse invented afterwards; a worker mid-attempt cannot set it, because the backlog is outside every worktree. Declaring nothing is the strict default, a value outside the three is reported as a mistake rather than read as silence, and `shrinks` is earned by DELETING files under `tests/` — tests removed from inside a file that still exists are still refused. A prediction that turns out wrong is reported and does not block the landing.

A task declares what it may touch (`blastRadius`), how it is judged (`gates`), what it was learned from (`references`) and what its worker needs to know (`skills`). A worktree is a checkout, so a skill file that is untracked is simply absent from it; the supervisor reports a declared skill the worktree lacks rather than leaving it in the run log. The last is resolved from the bound project's `.flyt/skills/` exactly as a template's list is and is merged into the run's resolved flow, so `runs/<id>/flow.json` records what was attached. A skill on a template says work of this kind is always done this way; a skill on a task says this particular job needs this knowledge. Neither can widen a tool grant.

For each claimable task the supervisor:

1. claims the task and creates a git worktree outside the repository, minting an `attemptId` that owns it;
2. starts a normal Flyt run of `flows/loop-task.flow.yaml` — one authored work node holding the Loop ceiling. The task file is already the plan, so the run does not plan it again, and the node that holds the tools exists before any model is called. Its grant names the `loop` set rather than inheriting the Work template's task-type grant, every one of which is a writer without a shell; `config.loop.flowId` points it elsewhere;
3. records heartbeats, model calls, tool feedback, and spend;
4. runs the task's declared gates itself;
5. requests an independent diff review;
6. merges with `--no-ff` and runs a post-merge canary; and
7. advances the known-good pin or reverts/parks the work.

A rejection at review or at gates is treated as a correction rather than a failure of the whole attempt. Both are judgements on work that exists, and both come with something specific to act on — a reviewer's sentence, or the assertion the suite named. The judged commit is recorded on the task as `resumeFrom` with the stage that produced it in `resumeStage`, the next attempt's worktree starts from it, and the brief says which of the two it is inheriting — "your gates passed and a reviewer objected" and "your gates are red" need opposite things said. A `resumeFrom` that no longer resolves degrades to the base branch and is cleared. An empty diff and a stalled attempt clear it: there is nothing there worth inheriting.

A red gate is assessed before a rung is spent (`core/repair.js`). The judgement is mechanical and costs no call: the failing tests are named in the gate's own output, and whether they sit in files the change touched is a set intersection. Work is **salvageable** — corrected in place, at the same band, with the failures handed back as feedback — unless one of the bounds says otherwise: the corrections are exhausted (two, raised to four while the failure count strictly falls), the same failures returned after a correction aimed at them (the feedback is not landing), the breakage is wider than the diff (many failures, mostly in files the change never touched), a second correction still hangs, or the attempt changed no file at all. Anything else climbs the ladder as before, with the work still attached. A correction counts as an attempt — money was spent, and the per-task ceiling has to see it — but not as a rung, and `repairs` on the task file is what bounds it. Feedback is bounded to what a person can read: the failures by name, place and assertion, never the gate's raw transcript, because the same field is the task's `blockedReason` and is rendered on the board, re-read on every `task:list`, and quoted in the archive.

Worktree ownership is attempt-scoped. Every claim mints an `attemptId`; the pool records `{ projectId, taskId, attemptId, runId, path, branch }` beside the worktrees and outside every repository; and every destructive operation is compare-and-delete — it names the attempt it believes it is cleaning up and refuses a path owned by a different one, reporting `removed`, `already-removed`, `owner-mismatch` or `live-owner`. Starting an attempt over a live one is refused with the owning run rather than resolved by deletion. Cleanup is idempotent, a released attempt keeps its tree for forensics without blocking the next attempt, and startup reconciliation reports orphaned records and trees rather than removing them.

Completion is effect-aware. Every node/task carries a deliverable contract — `artifact`, `workspace-change`, `either` or `none` — authored in the DSL or inferred conservatively from role, category and an authored tool grant. A baseline is captured read-only before the first tool call and compared before `done` is written; a required change that never happened records `effect_missing`, keeps the model's text as evidence rather than as a completion, and does not release downstream dependents. Loop's empty-diff rejection at landing remains as defense in depth.

Routing has one policy. The user's provider priority decides which connected provider is tried first; per-provider rankings decide which of that provider's models suits the task kind and effort. Renderer preview, `flyt doctor`, the node-start log and the adapter call read the same resolution, and every route record names the requested source, the effective provider/model, why that rung won, and which candidates were skipped — never a key. Adapter failures carry stable codes with remedies; an `auto` route may fall through to the next eligible provider on an infrastructure failure only, bounded and without revisiting a provider, while a pinned source always fails in place. A failure no retry, rung or model change can resolve — `auth`, `credit`, `capability`, and the two runtime ones — is separated from the rest by `needsHuman()`, and `credit` is distinct from `quota` because waiting clears a rate limit and never clears an empty account. No adapter failure is ever charged to the work: the call did not complete, so nothing the task asked for was judged, and whether the work was any good is decided by gates, by review, and by whether the workspace changed. Retries record an attempt, superseding the one they replace, so the newest non-superseded attempt is a node's visible state and earlier failures remain inspectable as history.

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

Some problems must do the opposite. A provider that refuses in a way nothing gets past — an empty account, an expired sign-in, a reviewer that cannot be reached — stops the loop rather than being proved against every task in turn: the task is released untouched, keeping its attempts and its rung, and an INCIDENT is recorded. An incident is a file (`core/incidents.js`), so it outlives the process that met it; it carries the remedy and the tasks it damaged, it leads `flyt doctor`'s findings above everything else, and it stays open until somebody resolves it. `flyt task reset` puts back what one took — the rung a task started on comes from `baseLevel`, recorded on its first escalation, so the restoration is the level it was authored at rather than a guess.

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

- **Eight capability seams** — `ctx.sessions`, `ctx.tools`, `ctx.llm`, `ctx.fs`, `ctx.shell`, `ctx.agents`, `ctx.commands`, `ctx.sandbox`. Provided so far: `sessions`, `tools`, `commands`, `agents` and `llm`; `fs`, `shell` and `sandbox` are declared and waiting. A seam is a service definition, a provider, and consumers that never learn which provider they got. `ctx.skills` also exists: not a capability seam, but the service definition dsh's skill packages register into. `ctx.blocks` is ours in the same sense: a block is Flyt's noun, dsh has no equivalent, and the eight-name list is the contract a dsh plugin is entitled to find.
- **The session log** — `runs/<id>/session.jsonl`, append-only, is the canonical record (D55). `deriveMessages()` reconstructs exactly what a model saw; a tool call with no result reconstructs as a synthetic never-returned result rather than disappearing. The run folder beside it (`meta.json`, `stack.json`, `blocks/*.md`, `tools/*.json`, `calls/*.jsonl`) is a projection, rebuildable from the log, and the ledger reads the log rather than the projection. Runs written before the log open through a read-only compatibility reader and are never converted.
- **The permission bridge** — every tool, ours or a plugin's, reaches execution through `tools/pre-execute`. Unclassified tools are in no toolset and no ceiling can name them; classification is not a grant; `ask` with nobody to ask is a denial (D57).
- **Composition** — bundles, then the profile patch, then the home patch, then the CLI overlay, a later layer replacing a row by id. One profile per surface (`flyt-desktop`, `flyt-cli`, `flyt-loop-worker`), and a narrower surface may never gain a row a broader one lacks.
- **dsh compatibility** — a pinned, real published dsh plugin loads, registers and executes against these services in CI (D54). Services on that contract are Cordis `Service` subclasses using ordinary private fields, because cordis derives a per-caller view with `Object.create()` and `#private` state is unreachable through it.

**The stack, as far as it is built.** Phase 1 is under way. Its first four slices landed as `t-0056`–`t-0059`; what remained (`t-0060`–`t-0062`) was decomposed again into `t-0064`–`t-0077`, one commit each, because a slice whose done-when spans four files is a slice that arrives with a helper written and nothing wired to it. What follows is the model the surfaces will draw, rather than the surfaces.

- **Containment is the graph** — `kernel/src/stack/parse.ts` reads a `stacks/<id>.stack.yaml` whose nested `blocks:` list *is* the composition. There is no `flow:` edge list and no `.layout.json`, because an edge list can disagree with the nodes and a layout file can disagree with both (D59). Six containers: `Sequence`, `Parallel`, `Repeat N`, `For each`, `Until` and `If` (D56, Phase 3). Every one of them declares its bound statically, and worst-case expansion is folded over the whole tree and reported before a run starts. An `If` predicate and a `For each` roster are *source / operator / literal* over a field an upstream block declared, never an expression and never prose — the grammar and its refusals are [`STACK_LANG.md`](./STACK_LANG.md). A container named but not built is still refused by the name a person knows it by, with the phase that brings it. Hand-written on the loader's hand-written YAML subset, so the dependency-light rule holds (D24) and the contract is still typed (D53).
- **Layout is computed, never stored** — `stack/layout.ts` is a pure function of the tree: a sequence stacks its children, a parallel places its lanes side by side, a container's box encloses every child's, and a point resolves to the innermost node under it. Nothing in it reads a file, so the CLI, the editor and an agent all get the same geometry.
- **An edit may not produce what the parser rejects** — `stack/edit.ts` has insert, move, remove and configure, addressed by container and index rather than by coordinates. Moving a container into its own descendant is refused, and so is an edit that would empty a container. Every edit returns a new tree and a record of what changed, which is what the editor animates from.
- **A `use` resolves to something** — `ctx.blocks` is the registry a plugin contributes a block to, and the other side of the string `parse.ts` stops at. One definition serves three readers: the scheduler needs its `execute`, the editor needs its settings schema to render a form, and the library needs its title, description and category — a second description of a block is a description that goes stale. A ceiling named on a block is a limit and never a grant (D57), and `missingBlocks()` answers the question a stack asks of the registry, so a run fails at the first block rather than at the ninth.
- **One code path, two callers** — `flyt-api` provides `ctx.commands`, and the four edits are registered into it, in all three profiles. The caller (`human` or `agent`) is recorded rather than inferred, every invocation emits `commands/invoke` carrying the edit record — refusals included — and the tree an accepted edit produced becomes the tree in the same step (D63).

- **A block runs, and the request is built from the log** — `blocks/run.ts` is the agent loop every block shares. It builds each request with `deriveMessages()`, so the list sent to the model IS the list the log holds and "model-visible means logged" is a property of the code rather than a rule to follow. `ctx.tools.execute` is the only path to a tool, so the ceiling and the approval gate bind exactly once; a refusal comes back as a result the model reads and answers.
- **The walk** — `flyt-stack-runner` provides `ctx.agents`. A sequence runs its children in order; a parallel runs its lanes under `maxParallel`, each handed what entered the PARALLEL, which is lane isolation (D37) as a consequence of containment rather than a rule anything enforces. A block narrows the run's ceiling and never widens it. Stop lands between children and the log says where; resume reads the log, replays what settled, re-runs what did not, and reconstructs a tool call that never returned (D17).
- **The run folder is written as the run goes** — `flyt-run-projection` listens to `session/append` and re-materialises at durable boundaries. Recomputed from the whole log each time rather than updated, so deleting the folder and rebuilding it from `session.jsonl` reproduces it byte for byte, which an incremental writer could not promise.
- **Models** — `flyt-adapters` provides `ctx.llm` over the JS core's existing adapters, injected rather than imported so the dependency does not point backwards across the language boundary. It adds the route record (requested, effective, why, degraded) and turns the adapters' whole-turn emissions into deltas.

**The surfaces, behind the flag.** `Root.jsx` is the only reader of the flag in the renderer, and the v2 tree is reached through a lazy import, so with the flag off the built chunk is never fetched and `App.jsx` mounts exactly what it always did — a test walks `src/` and fails on any static import of `./v2/`.

- **Build** is the block editor. Geometry comes from the derived layout, containment renders as containment and there are no edges. A drag picks a SLOT — a container and an index — and invokes `stack:move-block`; a model invokes the same command, and the editor animates from `commands/invoke` either way, so an agent's edit animates like a dragged one because it is the same record (D63). Undo is the inverse command, never a saved tree.
- **Work** is the running stack, drawn through the same editor rather than a second rendering of it. The active block is lit and its output streams inline; parallel lanes light together.
- **Trace** opens over whichever surface you are on when a run is addressed, rather than being a third destination. Turns hold steps, collapsed until asked; every request shows finish reason, usage, timing and reasoning apart from content; every tool call shows its arguments and its complete result; a degraded route reads as degraded and a call that never returned reads as unfinished rather than as empty. It reopens from a finished run's log with no live process, and it shares one folded trace with Work so the two cannot disagree.

**What the flag still does not switch.** The v1 surfaces do all the real work until the Phase 5 cutover (D62). With the flag on there are no stacks on disk to open (`stacks/` arrives in Phase 2), so Build renders an empty editor and Work renders the composer — the pieces are built and tested, and the handoff test (`t-0063`) is what will run one end to end.
