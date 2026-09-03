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

The shipping renderer has Work, Build, Library and Models as permanent destinations, reached from a navigation rail rather than the title bar; the title bar carries the project tabs and the run chip. Trace opens over whichever destination is showing when a run is addressed. A reusable, launchable stack is called a **Workflow** in the UI; `.stack.yaml` remains the canonical internal format. Build is two views of one destination: a gallery of every workflow in the project — grouped into launchable Workflows and internal stacks, showing each one's modes, step count and last edit, and carrying New, Duplicate and Edit — and the editor for whichever workflow is addressed. Which view shows is a property of the location, not editor state: Build with a workflow addressed is the editor, with none it is the gallery, and the address is carried across navigation the way a run address is. The editor contains the deterministic containment editor, a real YAML editor with parser/schema diagnostics and static block/depth/worst-case statistics, and an insertion drawer over the same catalog the Library page shows. Library is that catalog as a destination — one search over workflows, blocks, plugins, tools, skills and models — plus the plugin manager, which is the only surface that reaches the managed host's configure/restart/uninstall verbs. There is no route to the retired canvas, node picker, or Nodes page. Electron IPC, the CLI, and the loopback HTTP server bind host command surfaces rather than implementing separate behavior.

## 3. Stacks and execution

The kernel stack runner walks the parsed containment tree and records the resolved stack before executing a block. It resolves every `use` through `ctx.blocks` before spending, then applies run and block ceilings through the tool seam. Editing a stack later cannot change the stack already recorded by a run.

Only stacks carrying `launchable: true` appear in chat. Their optional presets — **modes** in the UI — are named partial block-config overrides; the Low, Medium, and High Pipeline choices are modes of one Workflow, not separate graphs. A mode may only change the configuration of blocks that already exist: never the shape, the tools, or the outputs. A workflow that declares modes always runs in one of them — the mode marked `default: true`, or failing that the first one written — so a launch that names none is resolved to the default before the run is created and the run record names the mode that was applied. Build previews a mode over the authored settings, marking the blocks it changes; the authored configuration is the base every mode starts from and is what an edit writes. The chat message is rendered as an immutable virtual Input block but is not authored into YAML. Build and Run render the same containment recursively, including isolated Parallel lanes and both If branches, without storing coordinates.

`core/stackRunner.js` is retained only as isolated migration-era implementation history. No production entry point imports it. Historical runs without `session.jsonl` are read through `RunStore`; all new execution is kernel-owned and canonical.

The scheduler recomputes readiness after each wave and runs independent `aiStep` and `agentTask` nodes up to `maxParallel`. Nodes with approval interactions are serialized where simultaneous gates would be ambiguous. Task claims are persisted before execution so two drains cannot take the same task.

Supported composition is the closed container set `sequence`, `parallel`, `repeat`, `foreach`, `until`, and `if`. Containment is the graph, parallel lanes are isolated, every loop is statically bounded, and predicates are structured comparisons over declared outputs. The language has no arbitrary expressions. See [`STACK_LANG.md`](./STACK_LANG.md) for grammar and [`BLOCKS.md`](./BLOCKS.md) for block contracts.

## 4. Context and artifacts

A node receives its task, selected upstream outputs, template instructions, instance instructions, project skills, and any explicit `contextSpec`. When no narrow context is declared, upstream content may still be broad; automatic context-strategy selection remains an open design choice.

Built-in model-backed blocks publish their standing system prompt through their block contract and accept a per-instance `systemPrompt` replacement in stack config. Ordinary `instructions` append after it. The task-graph block exposes planner and generated-worker replacements separately. Resolution happens before execution and the exact system message is appended to `session.jsonl` before the request, so a workflow-specific prompt remains attributable and editable in Build without mutating the plugin default or another workflow.

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

Tool effects, scope, risk, source, and trust drive gating. File tools and commands resolve one immutable local execution-world descriptor and one canonical workspace. Shell screening remains readable policy; OS-backed file-effect confinement enforces `read-only` or `workspace-write`, fails closed when unavailable, and reports backend/enforcement independently of approval.

Approval modes are captured per run:

- `ask` pauses before project writes and shell commands;
- `smart` allows deterministic low-risk operations, blocks known-dangerous patterns, and uses a fail-closed model check for ambiguous calls; and
- `always` runs unattended and is explicitly presented as dangerous.

Loop work adds git-worktree isolation, declared gates, a reviewer model, a post-merge canary, and spend caps. Commands also cross the same sandboxed subprocess provider as Desktop and CLI, but networking remains ambient and Windows enforcement is explicitly partial. These controls reduce risk; see `SAFETY.md` for the boundary and limits.

## 6. Models and provider authentication

Provider adapters share `callModel()`, streaming, retry, timeout, usage, and error contracts. Supported routes include direct API providers, OpenRouter, the mock provider, and explicitly enabled vendor CLI runtimes. In an explicit fallback chain, intermediate candidates get one provider attempt and the final candidate retains ordinary retry/backoff, so capacity errors fail over promptly without giving up resilience at the end. A fallback that answers becomes the preferred route for the remaining steps of that block turn; prior rungs remain last-resort candidates, but a rate-limited primary is not retried before every tool follow-up.

Resolution uses a pinned source when one is chosen; otherwise it walks the configured provider priority and selects the first connected provider that can serve the model. Node/category configuration and Loop effort bands select models without requiring a routing model call. A learned capability matrix or LLM tiebreaker is a possible extension, not current behavior.

API keys remain in user settings and are never written into run artifacts. Subscription-backed adapters delegate sign-in, token storage, refresh, and model invocation to the vendor CLI. Flyt does not copy or implement the vendor's OAuth flow. These adapters require explicit opt-in and display a provider-usage warning.

The Models page ranks a separate “Popular on OpenRouter” creator section from OpenRouter's trailing public token-usage dataset, caches its source date, and keeps the remaining creators alphabetical. Popularity is presentation metadata only: it never changes routing or pins, and a missing or stale ranking degrades to the ordinary alphabetical catalog.

## 7. Run lifecycle and presentation

Model output streams into the session log and reaches the renderer as folded trace updates. Sending chat replaces the composer with block-run mode. Build edits the source stack through commands; Work renders the resolved stack read-only while it runs. Both use the same derived containment geometry and the statuses pending, running, waiting, approval, input, done, failed, and skipped.

Each model step appends a `step.prompt` containing the exact assembled message/tool request before `llm.request`, followed by separate reasoning and visible response fields. Work's log rows expand into that query record; Trace retains the same record as nested turns and steps. A failed run names its failed block and offers Retry, Inspect queries, Reveal raw run log, and Show app log. Retrying marks only that block pending, preserves completed upstream outputs, and resumes the same run. Plan & dispatch gives reasoning models completion headroom beyond the visible JSON budget; if the ceiling is still exhausted, the failure names the ceiling, finish reason, and reasoning-token split instead of reporting only a parser symptom.

The run-status dropdown also hides a development-only Agent debugger. It gives a no-tool investigator the durable run facts (assembled prompts, provider attempts, tool and permission failures, outputs, and terminal state) and returns a structured probable cause, confidence, evidence, suspected block, inspection areas, and proposed retry guidance. Investigation itself is read-only. A human may edit the proposed guidance and explicitly restart the chosen block through the same canonical run-control command; prior `block.output` events remain available side-by-side for attempt comparison. The report can be copied with its bounded evidence packet for use as a bug report.

Repository-working blocks warn after 120 model/tool rounds instead of failing at that point. They continue until the model answers or the run is cancelled, and repeat the warning only at exponentially larger milestones. Their default per-query output ceiling is 32,768 tokens; an answer stopped for `length` is continued as another fully logged query. These warnings are live/transient and clear when the worker settles. Explicit hard step bounds remain available for small control roles such as a one-pass planner or clarification turn. A parallel dispatcher aggregates all failed children in the wave into the run error.

Each provider/model candidate is a durable `llm.attempt` event before the network call. A failed candidate records its bounded reason before the next candidate starts; the successful candidate closes the ladder and the response records route, usage, cost, and finish reason. Work shows the current provider/model while waiting plus fallback failures and settled speed/cost; Trace preserves the full ladder, latency, output tokens per second, usage, price, and degraded route. A missing response stays unsettled rather than disappearing.

Every non-empty container deletion asks whether to delete the subtree, unwrap its children, or cancel. Keyboard moves and drag/drop invoke the same registered stack commands as agent edits. Each accepted or refused authoring command is appended outside the canonical stack to authoring provenance with before/after source hashes; prior immutable run history remains session-owned.

Attended tool approvals and a block's direct `ask_human` question are process-owned pending interactions. A renderer reconnect queries them again and sends the decision or answer directly back to the waiting call. These interactions never pay for a Conversation Supervisor turn.

Completed nodes survive a crash. On startup, interrupted work is reconciled to a non-running state and the user chooses Resume. Completed nodes are reconstructed from persisted status and are not re-executed. A tool approval whose call stack died is failed honestly rather than pretending the pending call still exists.

Desktop and renderer failures also append to `<userData>/logs/flyt.jsonl`. A React error boundary replaces a white renderer with reload and diagnostic-log actions. If the renderer process itself exits unexpectedly, Electron records the reason and reloads the view once; workflow execution remains in the main process and the reloaded renderer reconstructs it from the session log.

Failures retain the thrown error, node status, model-call record, and partial output. A failed node can be retried, optionally with another model. `flyt why`, `probe`, and `doctor` expose the same evidence without requiring the desktop UI.

A run parked on a question is answerable from every surface that can show it —
the composer, the runs page, a comparison pane, and the CLI — because a
question you cannot answer from where you are standing is a run that reads as
stuck. Unattended, the questions are recorded as explicit assumptions instead
of parking forever.

One chat chain is a linked sequence of immutable Workflow runs. A general follow-up starts a new run with `conversationId` and `parentRunId`, using a bounded status capsule from the prior run; it never reopens or mutates completed blocks. The system-owned Conversation Supervisor has no tools and no write authority. A globally configured cheap model may produce the capsule and optional terminal summary, but an unavailable or failed model falls back deterministically and emits a warning without breaking chat. Context bounds keep whole semantic outputs or omit their body; they never slice a model output mid-unit. When terminal summaries are globally enabled, `supervisor.summary` is appended to canonical `session.jsonl` and shown as the final assistant message below the stack, with the reply composer beneath it.

## 8. Autonomous Loop

The Loop is a project-scoped supervisor over `.flyt/backlog/`. Tasks are individual Markdown files with structured frontmatter. The board and CLI derive blockers from the same `core/blockers.js` rules.

A task may also declare what the **suite** should do when it lands (`suiteExpectation`: `grows` | `unchanged` | `shrinks`). The two count checks — green with fewer tests, and green with the same tests while source moved — are right about the common case and wrong about a refactor, a deletion, and a consolidation. The declaration is made by whoever wrote the task, before the attempt, so it is a prediction that can be wrong rather than an excuse invented afterwards; a worker mid-attempt cannot set it, because the backlog is outside every worktree. Declaring nothing is the strict default, a value outside the three is reported as a mistake rather than read as silence, and `shrinks` is earned by DELETING files under `tests/` — tests removed from inside a file that still exists are still refused. A prediction that turns out wrong is reported and does not block the landing.

A task declares what it may touch (`blastRadius`), how it is judged (`gates`), what it was learned from (`references`) and what its worker needs to know (`skills`). A worktree is a checkout, so a skill file that is untracked is simply absent from it; the supervisor reports a declared skill the worktree lacks rather than leaving it in the run log. The last is resolved from the bound project's `.flyt/skills/` exactly as a template's list is and is merged into the run's resolved flow, so `runs/<id>/flow.json` records what was attached. A skill on a template says work of this kind is always done this way; a skill on a task says this particular job needs this knowledge. Neither can widen a tool grant.

For each claimable task the supervisor:

1. claims the task and creates a git worktree outside the repository, minting an `attemptId` that owns it;
2. starts canonical `stacks/loop-task.stack.yaml` through the kernel runner — one authored work block holding the Loop ceiling, with no graph-runner fallback;
3. records heartbeats, model calls, tool feedback, and spend;
4. runs the task's declared gates itself;
5. requests an independent diff review;
6. merges with `--no-ff` and runs a post-merge canary; and
7. advances the known-good pin or reverts/parks the work.

A rejection at review or at gates is treated as a correction rather than a failure of the whole attempt. Both are judgements on work that exists, and both come with something specific to act on — a reviewer's sentence, or the assertion the suite named. The judged commit is recorded on the task as `resumeFrom` with the stage that produced it in `resumeStage`, the next attempt's worktree starts from it, and the brief says which of the two it is inheriting — "your gates passed and a reviewer objected" and "your gates are red" need opposite things said. A `resumeFrom` that no longer resolves degrades to the base branch and is cleared. An empty diff and a stalled attempt clear it: there is nothing there worth inheriting.

A red gate is assessed before a rung is spent (`core/repair.js`). The judgement is mechanical and costs no call: the failing tests are named in the gate's own output, and whether they sit in files the change touched is a set intersection. Work is **salvageable** — corrected in place, at the same band, with the failures handed back as feedback — unless one of the bounds says otherwise: the corrections are exhausted (two, raised to four while the failure count strictly falls), the same failures returned after a correction aimed at them (the feedback is not landing), the breakage is wider than the diff (many failures, mostly in files the change never touched), a second correction still hangs, or the attempt changed no file at all. Anything else climbs the ladder as before, with the work still attached. A correction counts as an attempt — money was spent, and the per-task ceiling has to see it — but not as a rung, and `repairs` on the task file is what bounds it. Feedback is bounded to what a person can read: the failures by name, place and assertion, never the gate's raw transcript, because the same field is the task's `blockedReason` and is rendered on the board, re-read on every `task:list`, and quoted in the archive.

Worktree ownership is attempt-scoped. Every claim mints an `attemptId`; the pool records `{ projectId, taskId, attemptId, runId, path, branch }` beside the worktrees and outside every repository; and every destructive operation is compare-and-delete — it names the attempt it believes it is cleaning up and refuses a path owned by a different one, reporting `removed`, `already-removed`, `owner-mismatch` or `live-owner`. Starting an attempt over a live one is refused with the owning run rather than resolved by deletion. Cleanup is idempotent, a released attempt keeps its tree for forensics without blocking the next attempt, and startup reconciliation reports orphaned records and trees rather than removing them. A successful review, merge and canary are recorded before cleanup and are never downgraded by it: cleanup failure is returned and logged as a separate actionable outcome, and retrying an exact discard preserves `landed`.

Completion is effect-aware. Every node/task carries a deliverable contract — `artifact`, `workspace-change`, `either` or `none` — authored in the DSL or inferred conservatively from role, category and an authored tool grant. A baseline is captured read-only before the first tool call and compared before `done` is written; a required change that never happened records `effect_missing`, keeps the model's text as evidence rather than as a completion, and does not release downstream dependents. Loop's empty-diff rejection at landing remains as defense in depth.

Routing has one policy. The user's provider priority decides which connected provider is tried first; per-provider rankings decide which of that provider's models suits the task kind and effort. Renderer preview, `flyt doctor`, the node-start log and the adapter call read the same resolution, and every route record names the requested source, the effective provider/model, why that rung won, and which candidates were skipped — never a key. Adapter failures carry stable codes with remedies; an `auto` route may fall through to the next eligible provider on an infrastructure failure only, bounded and without revisiting a provider, while a pinned source always fails in place. A failure no retry, rung or model change can resolve — `auth`, `credit`, `capability`, and the two runtime ones — is separated from the rest by `needsHuman()`, and `credit` is distinct from `quota` because waiting clears a rate limit and never clears an empty account. No adapter failure is ever charged to the work: the call did not complete, so nothing the task asked for was judged, and whether the work was any good is decided by gates, by review, and by whether the workspace changed. Retries record an attempt, superseding the one they replace, so the newest non-superseded attempt is a node's visible state and earlier failures remain inspectable as history.

Planning is bounded and validated. Generated plans declare each task's effect, outputs, required and optional inputs, and dependencies; a plan is validated for size, producer existence, duplicate outputs and cycles before anything is materialized, with one corrective re-ask. A required input nothing produces fails before a model is called; an optional one degrades quietly. A planner streaming repetitive text with no tool call and no contract progress is interrupted on lack of novel work rather than on elapsed time.

Attended workflows may author one **Plan & dispatch** block when the task shape is not known until run time. It creates a validated task DAG and records the generated work as run-only child blocks. `No`, `Low`, `Medium`, and `High` are modes over the same block: No forces a serial chain; the other modes ask the planner to move from conservative to aggressive independence, while required producer edges and declared write-file conflicts remain serial in every mode. The dispatcher drains only ready tasks, under a bounded wave size, and never rewrites the saved workflow with a run's generated plan.

Spend is read from each run's call trace — every settled model call, including
the calls of a node that failed and of a run that was stopped — and priced from
the provider's reported cost, falling back to the model catalog's per-token
prices and then to an explicit override table. A node's retrospective is a
summary of the calls that finished tidily, so it is the fallback for a node
with no trace rather than the source. The ceilings consult the same table the
ledger uses: a price table that is empty makes every ceiling inert, which is a
failure mode with no symptom until the bill arrives.

Per-task and rolling soft/hard spend ceilings bound unattended work. Stalls are based on lack of progress, not only wall time. Busy work with no durable change also has a default context guard: 120,000 tokens between workspace, completed-output, or node-status changes, even when no dollar cap was configured. Productive change resets that allowance. Every intervention publishes the detector, its structured threshold, token and repeat counts, the rung taken, and the last tool activity; the loop log carries the same evidence in a readable sentence. Approval, budget, missing-model, dependency, lease, and gate problems park work with an actionable reason instead of blocking the whole queue.

An explicit Loop Stop is cancellation. The supervisor sends `run:stop` to every active worker immediately and waits at most 15 seconds for an adapter to settle; another Stop request cannot extend that original deadline. A normal abort and an expired grace period both release the exact attempt lease, return unfinished work to the queue without spending a capability rung, and retain its worktree for recovery and forensics. Status and log records name the request and settlement times, grace, last stage/tool, token/repeat counts, whether the deadline expired, and the recovery outcome. Cleanup is not allowed to make cancellation invisible or leave a task owned by a process that has stopped.

Some problems must do the opposite. A provider that refuses in a way nothing gets past — an empty account, an expired sign-in, a reviewer that cannot be reached — stops the loop rather than being proved against every task in turn: the task is released untouched, keeping its attempts and its rung, and an INCIDENT is recorded. An incident is a file (`core/incidents.js`), so it outlives the process that met it; it carries the remedy and the tasks it damaged, it leads `flyt doctor`'s findings above everything else, and it stays open until somebody resolves it. `flyt task reset` puts back what one took — the rung a task started on comes from `baseLevel`, recorded on its first escalation, so the restoration is the level it was authored at rather than a guess.

The benchmark runs fixed cases against throwaway clones and keeps `landed` separate from independently `verified`. Reference repositories are read-only shallow clones outside the workspace; agents may search them but cannot write through the reference library.

## 9. Delivery and known gaps

Vite builds the renderer, electron-builder produces installers, GitHub Actions runs CI and release builds, and packaged apps check GitHub Releases for updates. Mutable stores never use the read-only application archive.

Current architectural gaps worth preserving as explicit choices:

- context can still balloon when no `contextSpec` is supplied;
- synchronous filesystem access assumes modest run and graph sizes;
- local shell file effects are confined only when the platform's functional probe passes; network, read secrecy, IPC, syscalls, and kernel isolation remain gaps;
- pending tool calls in older daily workflow runs cannot be reconstructed; canonical stack runs reconstruct an unreturned tool result from the session log;
- MCP/HTTP-imported tools, a full Tools management page, and code mode are not implemented; the tool library is reachable from the CLI (`flyt tools`) but has no desktop surface;
- a killed call's spend is estimated from what it streamed, so it is bounded
  evidence rather than a measurement;
- model routing is configured rather than learned;
- sub-flow references follow the latest library version at the next run start; and
- large-graph layout and rendering are not a current target.

## 10. Plugin kernel, stacks, and shipping surfaces

Phase 5 completed the cutover described by D52-D63. The Electron host explicitly boots the kernel and `Root.jsx` always mounts the daily shell around Work/Build/Models; stale pre-cutover settings cannot select a renderer that has been deleted. `core/v2.js` keeps an optional boot switch for tests and non-desktop callers, with v2 as its default.

**Daily entry point.** Work is the default, familiar front door: the persistent project tab strip, projectless first-prompt creation, recent runs, workflow/config choice, typed launch inputs, and the Enter-to-run composer. Build remains the only stack/block authoring surface. Library and Models are permanent peers: Library exposes the installed catalog and the plugin manager, and Models exposes catalog identity, routing availability, pin state, pricing, context, tool support, creator popularity, and provider counts. The old all-purpose renderer and its canvas/routes stay retired; a small host composes the surviving controls around v2 instead.

**Kernel and seams.** `kernel/` is TypeScript compiled to `kernel/dist` and imported as `#kernel`. Third-party capability boundaries are typed services: sessions, tools, models, filesystem, shell, managed subprocess, agents, commands, and sandbox. A local execution-world plugin installs filesystem, subprocess, shell, policy, and sandbox atomically and rejects mixed descriptor identities. `ctx.skills` and `ctx.blocks` are registries rather than capability seams. Cordis profile composition narrows surfaces; a Loop worker may never gain a row the desktop profile lacks.

**Canonical stack source.** `StackStore` reads `stacks/<id>.stack.yaml`. An older linear `flows/<id>.flow.yaml` is converted in memory when opened: its edges determine sequence order, supported structural Loop nodes map to the registered handoff block, and every generated use must resolve through the installed plugin registry before open or save. The source remains untouched until the first validated stack write. A branch, disconnected graph, unknown block, unsupported container, or authority grant that cannot be narrowed equivalently is refused with the legacy source intact rather than silently changing behavior. Layout sidecars are never migrated because `kernel/src/stack/layout.ts` derives geometry from containment.

**Build host boundary.** The kernel, block executors, and command handlers stay in Electron's main process. IPC returns cloneable stack and block metadata. The renderer rebuilds a read-only registry facade and invokes edits through `v2:command`; accepted commands persist the stack and push the resulting tree back with the invocation record. A human drag and an agent call therefore use the same `ctx.commands` handler and produce the same visible event (D63).

**Blocks and plugins.** `ctx.blocks` is the only resolution of a stack's `use`. Bundled core, judgement, inquiry, and Loop plugins register the canonical block set through profile-owned `flyt:*` rows; host code does not mount them ad hoc. A managed host retains each Cordis fiber by stable composition id for catalog, configure, restart, uninstall, and failed-batch rollback, and reports a failed lifecycle call as a `failed` row carrying its error rather than an `active` one that lies about having taken. The Library's plugin manager is the surface over those verbs: every change it makes is applied to the live fiber and written to `~/.flyt/cordis.patch.yml`, so it survives a restart; built-in rows and groups are refused at the IPC boundary, not only in the UI. The desktop discovers `dsh.bundle`/`dsh.profile` package declarations, applies `~/.flyt/cordis.patch.yml`, boots trusted service providers first, and defers external imports until the renderer can perform the attended tool-classification pass. The same block definition supplies execution, Library metadata, configuration schema, outputs, and ceiling, while the Library's plugin entries come from the managed tree that actually supplied them. External UI contributions cross a typed RPC registry and are rendered by Flyt components; executable values and unknown component kinds are refused before the renderer.

**Runs and Trace.** `runs/<id>/session.jsonl` is the canonical record. `deriveMessages()` reconstructs what the model saw, including a synthetic result for a tool call that never returned. Native tool arguments are appended as structured `tool.input.start`, `tool.input.delta`, and `tool.input.end` events while the model is still generating them: a crash therefore retains the exact partial input without promoting an uncommitted response into an executable call. The run folder is a projection that can be rebuilt from the log. Work and Trace fold the same event stream, so live state and forensic detail cannot disagree. During the compatibility interval, an older flow-run snapshot is projected into a read-only sequence and folded trace for these two surfaces; that projection never becomes a stack authoring source.

**Safety.** Every tool reaches `tools/pre-execute`. Conservative effect inference may only make a plugin tool more restricted; classification is not a grant; a skill request is not a grant; and no grant may exceed the block's static ceiling. Attended `ask` can reach a person, while an unattended context with nobody to ask denies rather than guessing.

**Compatibility boundary.** Legacy run folders are read-only migration data. Desktop, CLI, and Loop launches resolve their profile and enter the same `RunController`, which is the only owner of live run identity, kernel-host reuse, leases, controls, and teardown. No v1 renderer, graph runner, loose `nodes/*.json`, shipped `flows/` asset, or stored layout participates in execution.
