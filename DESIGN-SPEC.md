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
stacks/<id>.stack.yaml          canonical stack source; no layout sidecar
plugins/<id>/                   block, tool, skill, and UI contributions
tools/<id>.json                 tool definition
tools/sets/<id>.json            reusable tool ceiling/grant
runs/<runId>/session.jsonl      canonical append-only run record
runs/<runId>/meta.json          stage, statuses, gates, errors, workspace
runs/<runId>/stack.json         projected resolved stack
runs/<runId>/blocks/*.md        block output
runs/<runId>/tasks/*.md         executor output
runs/<runId>/calls/*.jsonl      model-call records
runs/<runId>/tools/*.json       complete tool results
.flyt/incidents/<id>.json       a refusal nothing gets past, open until resolved
```

## 2. Projects and application surfaces

A project tab identifies one workspace. The renderer is a single React tree; switching tabs swaps the project-scoped view state while work continues in the main process. IPC calls that act on project data carry `projectId`, and stale pushes for another project are ignored.

Stacks, plugins, tool definitions, model settings, and reference repositories are global reusable libraries. Runs, backlog tasks, context, skills, chats, spend, and Loop status are project-scoped.

The shipping renderer has Work and Build as permanent surfaces. Trace opens over either when a run is addressed. Build contains the unified contribution library and containment editor. There is no route to the retired canvas, node picker, or Nodes page. Electron IPC, the CLI, and the loopback HTTP server bind host command surfaces rather than implementing separate behavior.

## 3. Stacks and execution

The kernel stack runner walks the parsed containment tree and records the resolved stack before executing a block. It resolves every `use` through `ctx.blocks` before spending, then applies run and block ceilings through the tool seam. Editing a stack later cannot change the stack already recorded by a run.

`core/stackRunner.js` remains the compatibility engine used by the current Loop supervisor and old run readers. Its old nouns are migration inputs owned by `core/brand.js`; it is not a desktop surface or the canonical stack grammar.

The scheduler recomputes readiness after each wave and runs independent `aiStep` and `agentTask` nodes up to `maxParallel`. Nodes with approval interactions are serialized where simultaneous gates would be ambiguous. Task claims are persisted before execution so two drains cannot take the same task.

Supported composition is the closed container set `sequence`, `parallel`, `repeat`, `foreach`, `until`, and `if`. Containment is the graph, parallel lanes are isolated, every loop is statically bounded, and predicates are structured comparisons over declared outputs. The language has no arbitrary expressions. See [`STACK_LANG.md`](./STACK_LANG.md) for grammar and [`BLOCKS.md`](./BLOCKS.md) for block contracts.

## 4. Context and artifacts

A node receives its task, selected upstream outputs, template instructions, instance instructions, project skills, and any explicit `contextSpec`. When no narrow context is declared, upstream content may still be broad; automatic context-strategy selection remains an open design choice.

Skills are names on a template, resolved at run time from `.flyt/skills/<name>.md`. Names are validated and paths are confined. A missing skill is logged and skipped, never silently treated as present and never fatal to the run.

Every model and tool interaction leaves evidence. Tool results are stored in full while the model receives a bounded preview plus a handle. Summary nodes are run artifacts with provenance; they do not mutate the source flow. Retrospectives describe problems and tool experience but do not autonomously rewrite routing or prompts.

## 5. Tools and safety

Tools are file-backed definitions loaded by `core/toolstore.js`; built-ins bind those definitions to source modules. The current catalog covers workspace reads and edits, shell commands, run/task inspection, backlog operations, reference search, web fetch/search/scrape, gate execution, result retrieval, and asking a human. [`TOOLS.md`](./TOOLS.md) is the authoring contract.

The shipped `research` stack holds the `web` and `read-only` ceilings together: it can search, fetch, scrape, extract, and read the project while writing nothing. Untrusted network text and a file writer do not belong on the same block. Backlog chat does not receive web reach merely because that stack has it.

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

Model output streams into the session log and reaches the renderer as folded trace updates. Build edits the source stack through commands; Work renders the resolved stack read-only while it runs. Both use the same derived containment geometry.

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
2. starts the Loop compatibility projection of canonical `stacks/loop-task.stack.yaml` — one authored work block holding the Loop ceiling. The projection is seeded by code rather than shipped as a v1 asset, so a fresh cutover install can still work its backlog while the supervisor migrates to the kernel runner;
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
- pending tool calls in runs written by the compatibility runner cannot be reconstructed; canonical stack runs reconstruct an unreturned tool result from the session log;
- MCP/HTTP-imported tools, a full Tools management page, and code mode are not implemented; the tool library is reachable from the CLI (`flyt tools`) but has no desktop surface;
- a killed call's spend is estimated from what it streamed, so it is bounded
  evidence rather than a measurement;
- model routing is configured rather than learned;
- sub-flow references follow the latest library version at the next run start; and
- large-graph layout and rendering are not a current target.

## 10. Plugin kernel, stacks, and shipping surfaces

Phase 5 completed the cutover described by D52-D63. The Electron host explicitly boots the kernel and `Root.jsx` always mounts Work/Build; stale pre-cutover settings cannot select a renderer that has been deleted. `core/v2.js` keeps an optional boot switch for tests and non-desktop callers, with v2 as its default.

**Kernel and seams.** `kernel/` is TypeScript compiled to `kernel/dist` and imported as `#kernel`. Third-party capability boundaries are typed services: sessions, tools, models, filesystem, shell, agents, commands, and sandbox. `ctx.skills` and `ctx.blocks` are registries rather than capability seams. Cordis profile composition narrows surfaces; a Loop worker may never gain a row the desktop profile lacks.

**Canonical stack source.** `StackStore` reads `stacks/<id>.stack.yaml`. An older linear `flows/<id>.flow.yaml` is converted in memory when opened: its edges determine sequence order, supported structural Loop nodes map to the registered handoff block, and generated uses must resolve in the plugin set. The source remains untouched until the first validated stack write. A branch, disconnected graph, unsupported container, or authority grant that cannot be narrowed equivalently is refused with the legacy source intact rather than silently changing behavior. Layout sidecars are never migrated because `kernel/src/stack/layout.ts` derives geometry from containment.

**Build host boundary.** The kernel, block executors, and command handlers stay in Electron's main process. IPC returns cloneable stack and block metadata. The renderer rebuilds a read-only registry facade and invokes edits through `v2:command`; accepted commands persist the stack and push the resulting tree back with the invocation record. A human drag and an agent call therefore use the same `ctx.commands` handler and produce the same visible event (D63).

**Blocks and plugins.** `ctx.blocks` is the only resolution of a stack's `use`. Bundled core, judgement, inquiry, and Loop plugins register the canonical block set. The same definition supplies execution, Library metadata, configuration schema, outputs, and ceiling. External UI contributions cross a typed RPC registry and are rendered by Flyt components; executable values and unknown component kinds are refused before the renderer.

**Runs and Trace.** `runs/<id>/session.jsonl` is the canonical record. `deriveMessages()` reconstructs what the model saw, including a synthetic result for a tool call that never returned. The run folder is a projection that can be rebuilt from the log. Work and Trace fold the same event stream, so live state and forensic detail cannot disagree.

**Safety.** Every tool reaches `tools/pre-execute`. Conservative effect inference may only make a plugin tool more restricted; classification is not a grant; a skill request is not a grant; and no grant may exceed the block's static ceiling. Attended `ask` can reach a person, while an unattended context with nobody to ask denies rather than guessing.

**Compatibility boundary.** The file-backed Loop harness still executes through the renamed JS `StackRunner` while it is migrated to the kernel runner. Its legacy graph/parser contracts are kept for that internal path and tested, but no v1 renderer, loose `nodes/*.json`, shipped `flows/` asset, or stored layout is part of the product surface.
