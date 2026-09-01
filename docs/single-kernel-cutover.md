# Complete single-kernel cutover

Status: implementation specification
Audience: the agent implementing the cutover, reviewers, and maintainers
Scope: production run execution, live-run ownership, run control, persistence projections, CLI/Electron entry points, and the legacy execution boundary

## Outcome

After this work, every newly started Flyt workflow—desktop, CLI, or unattended Loop—runs through the TypeScript Cordis kernel and `kernel/src/plugins/stack-runner.ts`. `runs/<runId>/session.jsonl` is the canonical record for every new run. The JavaScript runner in `core/stackRunner.js` is not imported, constructed, or called by production code.

Old run folders that predate `session.jsonl` remain openable through the existing read-only legacy projection. Old `flows/*.flow.yaml` files remain eligible for the existing conservative `StackStore` conversion, but no legacy flow is executable. A conversion that cannot preserve behavior is refused; it never falls back to the old runner.

This is a removal of a parallel runtime, not a redesign of the stack language and not a request to rewrite the kernel runner.

## Read this first

The repository is already partway through the cutover. Do not start from the assumption that the Loop is still on the old runner.

The current kernel routes are:

```text
Desktop DailyRoot
  -> window.flyt.runWorkflow
  -> IPC workflow:run
  -> core/api.js startWorkflow
  -> loopKernelHost(profile = flyt-desktop)
  -> core/kernelRunner.js startStackRun
  -> ctx.agents.start
  -> kernel/src/plugins/stack-runner.ts
  -> runs/<runId>/session.jsonl

Loop Supervisor
  -> API stack:run
  -> loopKernelHost(profile = flyt-loop-worker)
  -> the same startStackRun / ctx.agents / kernel runner path
```

Those paths are foundations to retain. The remaining second runtime is reachable through all of the following:

- `core/engine.js` imports `core/stackRunner.js` and constructs one legacy `StackRunner` for every `ProjectRegistry` entry.
- `core/projects.js` makes `runner` part of every project record and uses it for liveness.
- `core/api.js` still exposes `flow:run` and calls `entry.runner.start(...)`.
- the CLI command `flyt run` still invokes `flow:run`.
- several `run:*` commands branch on `isKernelRun(...)` and delegate non-kernel runs to `runnerFor(projectId)`.
- `electron/main.js` has direct handlers for branch, investigate, summaries, comparison judging, deletion liveness, and other operations on `entry.runner`.
- preload and old renderer modules still advertise legacy-only controls.
- shutdown and `run:live` merge `entry.runner.live` with `entry.kernelRuns`.
- many tests instantiate `core/stackRunner.js` directly and therefore keep behavior that the shipping product no longer reaches looking current.

The existing `docs/loop-kernel-migration.md` describes the completed Loop migration. This specification begins where that document ends and supersedes its statement that daily Work intentionally remains on the legacy runner: the current `DailyRoot` already starts canonical workflows with `workflow:run`.

## Why this design

The applicable lessons from DeepSeek Harness are architectural, not package-copying instructions:

1. **One supported application path.** A supported run must not bypass the configured plugin tree. Flyt must have one production start path and fail loudly when its kernel composition cannot start.
2. **Program against an Agent handle, not a concrete loop.** UI, CLI, supervision, and controls address a live run through a small interface. They do not import the stack runner implementation.
3. **Separate durable facts from live process events.** The session log owns facts that must survive a process. A process-local registry owns promises, abort controllers, host references, leases, and pending interactions.
4. **Model-visible means logged.** Resume, Trace, Work, diagnostics, and projections must derive from the same event stream.
5. **Profiles own authority.** Desktop, CLI, and Loop select different Cordis compositions; downstream code does not recreate authority with flags or fallback runners.
6. **Test the real entry path.** A hand-built runner unit test cannot prove that Electron, CLI, or the Supervisor boots the shipped profile and writes the canonical record.

Flyt should not copy DeepSeek Harness's dynamic workflow language or runtime self-modification as part of this work. Flyt's bounded stack language, block ceilings, deterministic containment, Work/Build UI, and autonomous landing pipeline remain product differentiators.

## Definitions

- **Kernel runner**: `kernel/src/plugins/stack-runner.ts`, provided as `ctx.agents` by the `flyt:stack-runner` plugin.
- **Kernel host**: one composed Cordis context bound to a profile, workspace, model routing configuration, approval policy, tool context, and runs root. `core/kernelRunner.js::bootLoopKernel` currently constructs it despite its Loop-specific name.
- **Live run**: an `AgentRun` whose `settled()` promise has not completed in this process.
- **Canonical run**: a run folder containing `session.jsonl` with a valid `run.created` event.
- **Legacy run**: a pre-kernel run folder without `session.jsonl`. It is readable but never resumable or executable after this cutover.
- **Projection**: rebuildable files and values derived from the canonical session, including `meta.json`, `stack.json`, block outputs, tool records, model call records, Work snapshots, and Trace state.
- **Compatibility read**: reading historical data that cannot be reconstructed as a canonical session. Compatibility reads may not create new historical facts.
- **Fallback runner**: any path that catches or detects a kernel problem and executes work with `core/stackRunner.js`. No such path is permitted.

## Non-negotiable invariants

The implementation is incomplete unless all of these hold.

### Execution

1. There is exactly one production method that starts a run after launch settings have been resolved. In this specification it is `RunController.start(...)`.
2. Desktop `workflow:run`, CLI `flyt run`, and Supervisor `stack:run` delegate to that method.
3. The first successful return from `start(...)` means `run.created`, `stack.resolved`, and the initial `run.stage` are durably present in `session.jsonl`.
4. A missing profile, service, stack, block, provider, or workspace fails before a second execution mechanism is considered.
5. `core/stackRunner.js` is absent from the production import graph.

### Live ownership

6. Exactly one process-local registry maps a live `(projectId, runId)` key to its host, `AgentRun`, watch identity, lease timer, and settlement cleanup. Do not assume caller-supplied run ids are globally unique across projects.
7. Stop, pause, continue, restart, shutdown, deletion checks, project adoption checks, and `run:live` consult that registry. No caller scans both legacy and kernel collections.
8. Registry ownership is by `AgentRun` identity, not merely by `runId`; an old settlement callback must not unregister a restarted run with the same id.
9. A host is disposed after its final registered live run settles and after final projection/summary work completes. A host in use by another run is not disposed.

### Durability and projection

10. New run state is changed by session events, not by editing `meta.json` or another projection in place.
11. `meta.json`, `stack.json`, `blocks/`, `calls/`, and `tools/` can be deleted and rebuilt from `session.jsonl` without changing the resulting Work snapshot.
12. All session appends, including cold crash reconciliation, use the JSONL session provider's validation and sequencing code. Production code must not construct session rows and append them with raw `fs.appendFileSync`.
13. A provider/model replacement for restart is recorded with `run.reconfigured` before execution resumes.
14. An interrupted tool call derives the existing `NEVER_RETURNED` model-visible result; it is never silently omitted.
15. Live events may accelerate the UI, but a renderer reconnect reconstructs the same state from the session alone.

### Compatibility

16. A legacy run without `session.jsonl` can be listed, opened, inspected, renamed if the existing legacy contract requires it, and deleted. It cannot be resumed, restarted, paused, continued, branched, followed up, or otherwise execute model/tool work.
17. A legacy `flows/*.flow.yaml` source is read through `StackStore`. Safe linear conversion remains non-mutating until the first validated stack write. Unsupported graphs are refused with their original file intact.
18. There is no implicit conversion of an old run folder into a canonical session: that would invent events that were never recorded.

### Authority

19. The profile is part of durable launch metadata. Resume recreates the recorded profile and routing unless a supported `run.reconfigured` event explicitly changes them.
20. `flyt-loop-worker` remains no broader than `flyt-desktop`; the existing `assertNarrower` test remains a gate.
21. Tool classification, block ceiling, runtime grant, permission policy, and approval all remain necessary. The cutover must not turn successful composition into additional authority.

## Target architecture

```text
                       +-------------------+
Desktop / CLI / Loop ->| core/api commands |
                       +---------+---------+
                                 |
                        resolved RunLaunch
                                 |
                       +---------v---------+
                       |   RunController   |
                       | live registry     |
                       | host pool         |
                       | leases/cleanup    |
                       +---------+---------+
                                 |
                 profile + workspace + routing key
                                 |
                       +---------v---------+
                       |  Cordis host      |
                       | ctx.sessions      |
                       | ctx.tools         |
                       | ctx.blocks        |
                       | ctx.agents        |
                       +---------+---------+
                                 |
                       +---------v---------+
                       | kernel StackRunner|
                       +---------+---------+
                                 |
                    append-only session events
                                 |
                  +--------------v---------------+
                  | runs/<runId>/session.jsonl   |
                  +--------------+---------------+
                                 |
                      canonical projections
                                 |
                Work / Trace / CLI / diagnostics
```

The API layer remains responsible for product choices such as resolving a workflow mode, selecting models from settings, deciding whether a person is present, and constructing conversation metadata. The controller receives those choices already resolved. The kernel remains responsible for stack resolution, scheduling, block execution, tool gates, session events, and resume behavior.

## New process-local component: `RunController`

Create `core/runController.js`. Move the host-pool and live-run lifecycle currently spread across `core/api.js` into this component. Do not move product command parsing or model-selection UI policy into it.

### Constructor dependencies

The controller should receive explicit dependencies rather than importing `core/api.js` or `electron/main.js`:

```js
new RunController({
  bootHost,              // normally bootLoopKernel; rename is optional in this change
  startRun,              // startStackRun
  resumeRun,             // resumeStackRun
  restartBlock,          // restartStackBlock
  snapshotLive,          // snapshotStackRun
  snapshotStored,        // snapshotStoredStackRun
  metadataStored,        // storedStackRunMetadata
  runsRootForProject,
  storeForProject,       // lease/catalog access only
  onSessionEvent,
  onSettled,
  now,
  hostname,
})
```

It is acceptable to use fewer injected functions if the controller imports `core/kernelRunner.js`, but it must not import the concrete kernel runner class or any Electron module.

### Resolved launch request

Define and document one JSDoc data contract. The exact property layout may follow current `bootLoopKernel` arguments, but it must distinguish host composition from per-run metadata:

```js
{
  projectId,
  runId?,
  stackId,
  input,
  host: {
    profile,             // flyt-desktop | flyt-cli | flyt-loop-worker
    workspace,
    runsRoot,
    approvalMode,
    worker,
    blockWorkers,
    defaultFallbacks,
    blockFallbacks,
    tierWorkers,
    level,
    toolsContext,        // backlog, pool, references, settings
    skills,
    presetId,
    requireLaunchable,
    askHuman?,
    askBlock?,
  },
  metadata: {
    conversationId?,
    parentRunId?,
    userMessage?,
    supervisorSummary?,
    loopTaskId?,
  },
  afterSettled?,
}
```

Do not put functions in durable metadata. `run.created` receives only the serializable, reconstruction-critical subset produced by `bootLoopKernel().metadata` plus the per-run metadata.

### Registry shape

The controller owns these maps; project entries do not:

```js
#live = new Map();       // runKey(projectId, runId) -> LiveRunRecord
#hosts = new Map();      // hostKey -> { host, runIds: Set<string> }
```

Use an unambiguous `runKey(projectId, runId)` helper (for example a nested map or a delimiter that project ids cannot ambiguously reproduce). `LiveRunRecord` contains at least:

```js
{
  runId,
  projectId,
  hostKey,
  host,
  run,                   // AgentRun
  watchToken,            // the AgentRun identity or an opaque token
  leaseTimer,
}
```

Required public methods:

```js
start(launch): Promise<{ runId, run }>
resume({ projectId, runId, workerOverride?, blockId? }): Promise<{ runId, run }>
restartBlock({ projectId, runId, blockId, guidance?, worker? }): Promise<{ runId, run }>
stop(projectId, runId, reason): Promise<ControlResult>
pause(projectId, runId, reason?): Promise<ControlResult>
continue(projectId, runId): Promise<ControlResult>
get(projectId, runId): LiveRunRecord | undefined
list(projectId?): string[]
isLive(projectId, runId): boolean
shutdown(reason): Promise<{ stopped: number }>
```

`resume` reconstructs a host from `storedStackRunMetadata`. It must enforce the current safe behavior:

- refuse when workspace metadata is missing;
- reuse a genuinely live host only for an ordinary continue;
- refuse a worker change while the run is live;
- preserve recorded profile, approval mode, preset, skills, routing, fallbacks, and block routes;
- apply a desktop block override only to the addressed block;
- record replacement routing through `run.reconfigured` before restarting;
- register and watch the new `AgentRun` before returning.

### Settlement ordering

The current watcher has subtle ordering that must be preserved:

1. `AgentRun.settled()` resolves.
2. Product-owned `afterSettled` work runs while the host is still usable. For an attended workflow this may append `supervisor.summary`.
3. The session is projected one final time.
4. The lease is cleared if this watcher still owns the run.
5. The live record is removed if its `watchToken` is still current.
6. The host's run reference is released.
7. The host is disposed only when its run set is empty.

Failures in summary or projection do not erase the settled run or prevent registry cleanup. They are reported/logged separately. A late callback from a replaced `AgentRun` may clear its own timer but may not clear the replacement's lease, registry entry, or host reference.

### Host key

Preserve the current host isolation dimensions. The key must include all values that can change service behavior or authority:

- project/runs root;
- workspace;
- profile;
- approval mode;
- provider/model and routing constraints;
- per-block workers;
- default and per-block fallbacks;
- authored tier workers;
- effort level;
- Loop task id where it changes tool context;
- preset where composition or scoped behavior depends on it;
- any runtime ceiling or tool-context identity that differs between hosts.

Use a stable serializer rather than ad hoc `JSON.stringify` of unordered objects. Two semantically identical launches should share a host; two launches with different authority or routing must not.

## Kernel and session changes

### Final file responsibilities

The current `core/kernelRunner.js` is not a second runner, but its name and mixed responsibilities make that difficult to see. During the extraction, prefer this final ownership:

| File | Responsibility |
|---|---|
| `core/runController.js` | process-local live-run registry, host reference counts, leases, controls, settlement cleanup |
| `core/kernelHost.js` | compose one Flyt Cordis host from an already-resolved host request and bridge existing JS adapters/tools into kernel seams |
| `core/runProjection.js` | application-facing snapshots, stored-session reader/cache, launch-metadata fold, canonical-versus-legacy read dispatch |
| `kernel/src/plugins/stack-runner.ts` | scheduling and execution provider behind `ctx.agents` |
| `kernel/src/session/*` | durable session format, append/read/repair, model-message derivation |
| `kernel/src/session/projection.ts` | pure canonical event fold and materialization |

Rename `bootLoopKernel` to `bootRunKernel`; both desktop and Loop already use it. A temporary re-export is acceptable while imports move, but remove the old name before completion. Remove `core/kernelRunner.js` after its contents have moved; leaving a host bridge named “runner” would make the finished architecture continue to look dual.

Do not move scheduling into `RunController` or `core/kernelHost.js`. They own process resources and composition only.

### Keep the `AgentsSeam`, strengthen the boundary

`kernel/src/seams/agents.ts` is the correct public interface. UI, CLI, API, and controller code must use `AgentRun`/`AgentsSeam`, never import `kernel/src/plugins/stack-runner.ts` directly.

Add an architecture test that permits the concrete runner import only from:

- `kernel/src/index.ts` exports;
- `kernel/src/profiles.ts` built-in importer;
- kernel runner tests.

Production `core/`, `electron/`, `bin/`, and `src/` must not import it.

### Type the durable event vocabulary

The current `SESSION_EVENTS` string list prevents spelling drift but does not type payloads. Add `kernel/src/session/events.ts` with a `SessionEventMap` and derive the input/event union from it. At minimum type every event the stack runner, block loop, tool pipeline, and run controller append.

Add these lifecycle events if they do not already exist:

- `run.named` — `{ name: string | null }`; canonical name change for kernel runs.
- retain `run.reconfigured` — currently written by restart but missing from `SESSION_EVENTS`; add it to the vocabulary and projection.

Do not add a session event merely to mirror external project state. Comparison records are their own canonical project-level files. Remove code that stamps comparison data into a kernel run's projected `meta.json`; join comparison information when listing/reading, or deliberately add a session event only if the session is intended to own that relationship. There must not be two writable sources of truth.

Unknown durable event handling must be explicit. This repository controls the format and may fail on an unknown required event, but an extension event intended to be ignorable must say so in its envelope. Do not silently drop an unknown model-visible event.

### One append implementation

Move cold repair into the session package. Replace `core/kernelRunner.js::reconcileStoredStackRuns` raw row construction with an exported kernel operation such as:

```ts
repairInterruptedSessions(root, { reason, isLeaseLive }): Promise<string[]>
```

It must reuse `JsonlSessionStore`/`JsonlSession.append` for:

- run-id confinement;
- parsing and torn-tail detection;
- dense sequence assignment;
- event validation;
- the same durability guarantee as an ordinary append.

Cold repair may scan files directly to decide which sessions need repair, but once it writes, it writes through the session abstraction. Repair remains idempotent. A live lease owned by another process is not repaired.

### Canonical projection, not compatibility projection

In `core/kernelRunner.js` rename `compatibilitySnapshot` to a neutral name such as `projectRunSnapshot` and update comments and tests. It is now the normal Work snapshot for all new runs, not a temporary Loop adapter.

The projection must fold all canonical metadata used by current surfaces, including:

- stack id/name and resolved stack;
- stage and current block;
- block statuses and outputs;
- exact run input/user message;
- workspace and approval mode;
- profile, preset, routing and reconfiguration;
- conversation/parent linkage;
- provider attempts and settled calls;
- tool results;
- supervisor summary;
- run name.

`SNAPSHOT_UPDATE_EVENTS` and the session projection cases must be updated together. Add a test that iterates the durable event vocabulary and records whether each event affects messages, Work projection, Trace only, or external state. An event may be Trace-only, but that status must be deliberate.

Projection materialization remains a cache. No production method may call `RunStore.writeMeta`, `setStage`, `writeNodeOutput`, or similar legacy mutators for a canonical run.

## API and surface cutover

### Supported start commands

Keep these product-level commands:

- `workflow:run`: attended/project workflow start. Resolve presets and model selection, then call `RunController.start` with profile `flyt-desktop`.
- `stack:run`: internal Supervisor start. Call the same controller with profile `flyt-loop-worker`. It may remain named `stack:run` because the Supervisor already uses it, but it is not a second execution implementation.
- CLI `flyt run`: keep the user-facing CLI syntax, but resolve the canonical workflow and invoke the same controller with profile `flyt-cli`.

The profile is selected by the trusted command binding, not by an arbitrary workflow payload. Add a CLI-specific internal command or a trusted caller/surface field rather than allowing a remote caller to name any profile in `workflow:run` arguments.

Remove `flow:run` from the command map after the CLI and all tests have moved. If an external compatibility window is required, retain only a rejecting alias:

```text
code: legacy_flow_execution_removed
message: This flow cannot be executed by the retired runner. Open or save it as a canonical workflow first.
```

The alias must never call `entry.runner`, load `FlowStore` for execution, or catch a stack conversion error and fall back.

### Canonical controls

All executable run controls address `RunController`:

- `run:stop`
- `run:pause`
- `run:resume` (continue if live-and-paused; cold resume if interrupted)
- `run:restartNode` may remain as a temporary wire name because the current renderer calls it, but its implementation and messages use `blockId` and `RunController.restartBlock`. Add `run:restartBlock` and make the preload use it; remove the alias once callers are migrated.
- `workflow:decide` for a process-owned tool approval.
- `workflow:answer` for a process-owned block question.
- `workflow:reply` for an immutable follow-up run.

Remove `dailyRunControl` and every `isKernelRun ? kernel : legacy` execution branch. For a legacy run, executable controls return:

```text
code: legacy_run_read_only
message: This historical run has no canonical session and can only be inspected or deleted.
```

Do not route a legacy id to a project-wide runner. Run identity, not project membership, decides ownership.

### Retire legacy-only controls

The shipping `DailyRoot` does not use the old canvas controls below. Remove their preload methods, Electron handlers, and dead renderer components if no current route imports them:

- `run:approve` / `run:reject` legacy plan gate;
- `run:followUp` continuation-subgraph mutation;
- `run:answerInput` legacy refiner gate;
- `run:branch` legacy copy-and-rewind behavior;
- `run:investigateNode` model-written legacy node explanation;
- `run:summarize`, `run:deleteSummary`, `run:moveSummary` legacy summary cards.

`core/supervisor.js` still contains a `run:approve` invocation inherited from the old parked-run protocol. Remove that unreachable branch or replace it with the canonical interaction it actually observes; do not leave `run:approve` alive solely for the Supervisor. Likewise, update CLI waits that currently answer through `run:answerInput` to use the canonical workflow question channel.

Before deletion, prove reachability with `rg` and renderer route tests. If a current surface is discovered, choose one of these dispositions rather than preserving the old runner:

| Legacy behavior | Canonical disposition |
|---|---|
| Plan approval/rejection | authored human-checkpoint block or tool approval interaction |
| Input question | `workflow:answer` to the current process-owned question |
| Follow-up | `workflow:reply`, creating a linked immutable run |
| Restart downstream | kernel block restart/resume using durable block statuses |
| Branch at a block | defer; a future session-fork design must use a stable event prefix |
| Investigate | Work/Trace plus `run:explain`; no hidden legacy execution |
| Post-run summaries | authored summary block or `supervisor.summary` event |

`run:judge` is not intrinsically a runner operation. If the current comparison surface still calls it, extract it into a standalone comparison service that reads canonical snapshots and calls the configured judge adapter. Otherwise remove the dead handler. It must not keep `StackRunner.judgeComparison` alive.

### Read-only run operations

These remain valid for canonical and legacy runs:

- list;
- snapshot/open;
- raw-log reveal where a log exists;
- open artifact/folder;
- rename;
- delete when not live;
- comparison record read/write;
- diagnostics that can work from recorded evidence.

For canonical rename, append `run.named` and rebuild the projection. For a legacy run, `RunStore.setRunName` may continue to update its historical `meta.json` because that file is the only record the run ever had.

Deleting a run checks `RunController.isLive(projectId, runId)`, removes the run folder and comparison references, and drops push/snapshot reader caches. It does not reference `entry.runner.live`.

### Diagnostics

`core/diagnostics.js::explainRun` currently expects legacy `RunStore` log vocabulary (`node_start`, `node_error`, legacy gate metadata, and per-node call files). It is not a valid canonical diagnostic merely because kernel projections happen to expose `nodeStatus` aliases.

Split diagnostics into a storage-neutral input and two readers:

```js
explainEvidence({ meta, events, calls, tools, stack, blocks })
readCanonicalEvidence(runsRoot, runId)  // session + canonical projection
readLegacyEvidence(store, runId)        // existing historical reader
```

For canonical sessions derive at least:

- active/failed block from `block.status`, `run.error`, and terminal `run.stage`;
- unsettled model requests from unmatched `llm.request`/`llm.response`;
- provider fallback evidence from `llm.attempt`;
- finish reason, usage, route, and reasoning/content evidence from canonical model events;
- tool names and failures from `tool.call`, `tool.state`, and `tool.result`;
- pending attended interactions from the process-local workflow interaction registry when available, clearly marked non-durable;
- interruption and `NEVER_RETURNED` evidence from the session fold.

`run:explain`, `flyt why`, and any doctor link from a failed Work run dispatch to the canonical reader when `session.jsonl` exists and the legacy reader otherwise. Add a test for a failed canonical block, an unsettled call, a failed tool, and a live run. The cutover is not complete if new runs execute on the kernel but the primary failure diagnostic still reads only legacy evidence.

### Electron and preload

`electron/main.js` should bind execution and control through `createApi().invoke`, as existing `workflow:*` and `run:*` handlers do. There must be no direct `proj(projectId).runner.*` call after the cutover.

Remove unused methods from `electron/preload.cjs`, `src/devMock.js`, and old components in the same change that removes their handlers. The production preload and browser mock parity test must continue to prove that every advertised method exists on both sides.

The current `src/v2/DailyRoot.jsx` path already uses `runWorkflow`; preserve it. Remove `launchDailyPrompt` or update its tests if it is only a legacy test helper. Do not reintroduce `runFlow` to simplify a test.

### CLI

Update `bin/flyt.js` so `flyt run <workflow>` invokes canonical workflow execution. Preserve useful CLI behavior:

- workflow/mode selection;
- typed run inputs;
- workspace selection;
- approval mode and attended questions;
- streaming or polling until settlement;
- stop handling;
- final status and exit code.

Adapt to `workflow:run` returning `{ runId, conversationId }` rather than the legacy bare id. CLI approvals/questions use canonical interaction commands. Do not make the CLI depend on Electron-only pending interaction state; compose `flyt-cli` with terminal callbacks passed to the host.

## Project registry and engine cutover

### Remove runner ownership from projects

Change `ProjectRegistry` entries from:

```js
{ ..., store, runner }
```

to:

```js
{ ..., store }
```

Remove the `createRunner` constructor dependency. `RunStore` remains temporarily because it owns the run directory, legacy reads, comparison files, leases, retirement records, and some catalog operations. It no longer implies an execution engine.

Update these registry behaviors:

- `listOpen().live` comes from an injected liveness provider or is joined by the API/engine after reading `RunController.list(projectId)`.
- `adoptAppdata` refuses while `RunController.list(projectId)` is non-empty.
- closing a tab does not stop runs; the controller is process-scoped and independent of tab visibility.
- reopening a project does not create an executor.

Do not put kernel hosts back onto project entries merely to replace `runner`. Host pooling and live ownership belong to `RunController`.

### Remove legacy wiring from `core/engine.js`

Delete:

- the `StackRunner` import;
- `createRunner` construction and injected backlog/ledger/pool/loopHost/feedback properties;
- legacy `reconcileInterrupted()` calls;
- comments describing the project-owned runner;
- liveness unions involving `runner.live`.

Retain dependencies because they are used by blocks or tools only where that is true. For example, backlog, pool, ledger, feedback, references, and model adapters remain engine services injected into the kernel host; they must not remain solely because the old runner used them.

Run cold canonical reconciliation once per project runs root when the project is opened or first addressed. Use the session repair operation described above. Legacy run folders are not reconciled; they are already historical.

## Legacy code disposition

### Delete after production reachability reaches zero

Delete `core/stackRunner.js` only after the architecture gate proves no production caller remains and relevant behavior tests have been ported. Then use `rg` to find modules imported only by it. Delete a module when all of these are true:

1. no production import remains;
2. its behavior is either implemented by canonical blocks/containers or explicitly retired in this specification;
3. no historical read path requires it;
4. its tests are ported or deliberately removed with the retired behavior.

Likely candidates include parts of `core/nodes/`, old flow scheduling, legacy gates, write-ledger scheduling helpers, follow-up graph mutation, summary-card mutation, and runner-only prompt assembly. Verify each; do not delete by directory name.

`core/stackRunner.js` also exports pure helpers that made unrelated callers import the whole legacy execution module. Move or replace those before deleting it:

- `APPROVAL_MODES` and `normalizeApprovalMode` already belong to `core/approval.js`; change `core/api.js`, `core/engine.js`, and `electron/main.js` to import them there.
- `bin/flyt.js` imports `renderQuestions`; either render the canonical `workflow:pending` question directly in a small CLI presentation module or move the pure formatter to `core/questions.js`.
- worker routing helpers are superseded by `core/modelPriority.js` plus the kernel LLM seam; port any still-promised pure route tests there.
- graph helpers such as `topoSort`, `upstreamSet`, and `downstreamSet` describe the retired edge graph. Do not move them merely to keep legacy execution tests compiling.
- context/orientation/interrogation helpers move only if a canonical block imports equivalent behavior. Otherwise their tests retire with the old node type.

A “utility” import is still a production dependency on the legacy module: the architecture gate must reach zero, not exempt imports that happen not to instantiate the class.

### Keep as compatibility readers/migrators

Retain and clearly label:

- `kernel/src/session/projection.ts::readLegacyRun`;
- the `RunStore` methods still required to list/read/delete old folders and manage project-level comparison/retirement data;
- `core/stackstore.js` legacy source conversion;
- the old flow parser only to the extent `StackStore` conversion needs it;
- branding/path constants needed to locate legacy sources.

Compatibility modules must not import model adapters, tools, `AgentsSeam`, or any execution loop.

### Flow authoring APIs

The shipping Build surface uses canonical stack commands and `StackStore`. Remove `flow:list/load/save/new/delete/lint` IPC/preload APIs if no supported surface or CLI command still uses them. If a source-inspection command is retained for migration, name it as legacy and make it read-only.

The first write of a safely converted flow continues to create and validate `stacks/<id>.stack.yaml` before removing the legacy file. Branched, disconnected, cyclic, contained, or authority-incompatible flows continue to be refused.

## Implementation phases

Each phase should land with focused tests. Never add a temporary fallback to keep a phase green.

### Phase 0 — Characterize and gate the boundary

1. Add `tests/singleKernelArchitecture.test.js`.
2. Assert the three supported start surfaces and their expected profiles.
3. Assert `DailyRoot` calls `runWorkflow`, not `runFlow`.
4. Assert production files do not import the concrete kernel runner.
5. Add a temporary expected-failure inventory for production references to `core/stackRunner.js`; shrink it in every phase and delete the allowlist in Phase 4.
6. Add/extend real-path tests proving desktop workflow and Loop runs create `session.jsonl` and no legacy `flow.json` source-of-truth record.

Exit: the current dual-runtime surface is mechanically enumerated.

### Phase 1 — Introduce `RunController`

1. Extract `loopKernelHost`, live maps, watcher, lease heartbeat, host disposal, resume-host reconstruction, and control helpers from `core/api.js`.
2. Put desktop and Loop kernel starts through the controller without changing public commands.
3. Replace `entry.kernelHosts`, `entry.kernelRuns`, and `entry.kernelWatches` with controller-owned maps.
4. Update shutdown and `run:live` to use the controller.
5. Add concurrency tests for shared hosts, final-host disposal, restart identity, and late-settlement races.

Exit: all current kernel runs have one process-local owner.

### Phase 2 — Move every supported start/control surface

1. Port CLI `flyt run` from `flow:run` to the canonical controller/profile.
2. Remove or reject `flow:run`.
3. Remove `dailyRunControl`, `runnerFor` execution fallback, and `isKernelRun` execution branches.
4. Route stop/pause/continue/resume/restart exclusively through `RunController`.
5. Remove or extract the direct Electron runner handlers listed above.
6. Update preload, dev mock, renderer tests, and CLI tests.

Exit: no user or Supervisor command can start or control the JavaScript runner.

### Phase 3 — Make session mutation and projection singular

1. Add the typed durable event map and `run.named`/`run.reconfigured` projection support.
2. Move cold reconciliation into the session provider and remove raw JSONL writes from `core/kernelRunner.js`.
3. Rename compatibility snapshot terminology.
4. Prevent `RunStore` mutators from accepting canonical runs, except lease/catalog operations explicitly documented as external state.
5. Make canonical rename event-backed and comparison metadata single-owned.
6. Add delete-and-rebuild projection tests.

Exit: every new run can be reconstructed solely from its session.

### Phase 4 — Remove project-owned runner and production legacy execution

1. Remove `createRunner` and `runner` from `ProjectRegistry`.
2. Remove `StackRunner` construction from `core/engine.js`.
3. Replace adoption, deletion, project live count, and shutdown checks with controller liveness.
4. Remove `core/stackRunner.js` from the production graph.
5. Delete dead direct handlers and flow authoring APIs.
6. Turn the architecture inventory into a zero-reference assertion.

Exit: `rg` finds no production reference to `core/stackRunner.js`, `entry.runner`, or `runnerFor`.

### Phase 5 — Port or retire tests and delete dead modules

Group legacy tests by behavior rather than mechanically rewriting every constructor:

| Test family | Action |
|---|---|
| stack containment, bounds, modes, parallel isolation | port assertions to `kernel` stack parser/runner tests |
| tool gating, ceilings, approvals, safety | port to `ctx.tools` plus kernel runner real composition |
| stop, pause, resume, restart, crash recovery | port to `RunController` and canonical session tests |
| provider fallback, retries, usage, reasoning | keep/port to adapter and kernel block-loop tests |
| fanout/orchestrator planning | map to `blocks-task-graph` tests; retain only behavior still shipped |
| legacy subflow/graph execution | retire; canonical containment and safe `StackStore` conversion own the supported behavior |
| legacy follow-up graph mutation | retire; immutable `workflow:reply` owns follow-up behavior |
| branch/investigate/summary cards | retire unless a current route was proven, then extract a runner-independent service |
| old run reading | retain focused read-only legacy projection tests |
| comparison records | retain as project-state tests; judge logic becomes runner-independent if still shipped |

Deleting tests is correct when the tested product behavior is explicitly retired. Do not preserve unreachable behavior by keeping its private runner alive. Conversely, a still-promised behavior must be ported before its old test is removed.

Exit: the suite describes the shipping kernel product and the narrow historical read boundary.

### Phase 6 — Documentation and final gates

Update at least:

- `README.md` repository map and headless use;
- `DESIGN-SPEC.md` sections 3, 7, 9, and 10;
- `DECISIONS.md` current decision rows that mention the compatibility engine;
- `docs/loop-kernel-migration.md` to mark it as historical/completed and point here;
- CLI help and examples;
- comments in `core/projects.js`, `core/api.js`, `core/engine.js`, and Electron preload.

Remove stale phrases such as “daily workflow runner,” “compatibility snapshot,” “kernel run versus daily run,” and “one RunStore + StackRunner per project.”

Exit: docs describe one execution architecture and distinguish only canonical versus historical storage.

## Test requirements

### Focused unit/integration tests

Add or update tests for:

1. Desktop, CLI, and Loop launches all call the same controller with different profiles.
2. Stack resolution failure creates no legacy run and invokes no fallback.
3. Every new run has `session.jsonl`; `run.created` records reconstruction metadata.
4. A live run appears once in `run:live` and blocks deletion/project adoption.
5. Two same-key runs share a host; the first settlement does not dispose it; the second does.
6. Two different authority/routing keys never share a host.
7. A restarted run cannot be unregistered by the original run's late `finally`.
8. Shutdown stops all controller-owned runs and waits for settlement.
9. Stop/pause/continue return explicit `not-live`/`not-paused` results.
10. Cold resume preserves completed blocks and replays an interrupted tool as `NEVER_RETURNED`.
11. Restart records `run.reconfigured`, block pending state, and guidance before execution.
12. Renderer reconnect recovers pending workflow interactions while the process lives.
13. Cold repair is idempotent and skips a genuinely live lease.
14. Deleting projections and rebuilding yields the same snapshot.
15. Canonical rename survives projection rebuild.
16. A legacy run is readable and deletable but every executable control returns `legacy_run_read_only`.
17. A safe legacy flow converts through `StackStore`; an unsafe graph refuses without invoking a runner or mutating the source.

### Real entry-path tests

At least one test per surface must use the actual command boundary and composed profile:

- desktop/API `workflow:run` with a scripted model and a real registered block/tool pipeline;
- CLI `flyt run` in a subprocess against a fixture workspace;
- Supervisor `stack:run` or the existing end-to-end Loop parity test.

The model adapter may be scripted, but sessions, tools, blocks, runner, projection, and command plumbing must be real. Assertions inspect the external world and session file, not merely the model's answer.

### Architecture gates

The final architecture test should enforce all of these:

```text
production imports of core/stackRunner.js        = 0
production references to entry.runner            = 0
production references to runnerFor(               = 0
command-map implementation of flow:run            = absent or rejecting only
new-run creation outside RunController             = 0
raw append writes to */session.jsonl outside the session provider = 0
```

Use path-aware checks, not a repository-wide word ban: historical docs, legacy fixture strings, and migration tests may legitimately contain old names.

### Commands

Run focused tests during each phase, then before completion run:

```text
npm run build:kernel
npm test
npm run build
npm run stack -- lint
```

Also run the CLI subprocess test and the existing Loop/workflow reliability tests explicitly so a broad suite invocation cannot hide a skip.

## Failure semantics

Use stable codes at API boundaries. At minimum:

| Code | Meaning |
|---|---|
| `kernel_unavailable` | required profile/service failed to compose |
| `stack_not_found` | no canonical or safely convertible stack exists |
| `legacy_flow_execution_removed` | caller used the retired execution command |
| `legacy_run_read_only` | caller attempted executable control on a historical run |
| `run_not_live` | control addressed no live run in this process |
| `run_already_live` | resume/reconfigure raced a live owner |
| `run_resume_metadata_missing` | reconstruction-critical metadata is absent |
| `run_control_failed` | a live handle rejected a control for a reported reason |

Do not collapse these into “run failed.” The caller must know whether to fix a workflow, reconnect to the owning process, resume, or only inspect history.

## Risks and required mitigations

### Host lifetime races

Risk: one run settles and disposes a host another run or restart still uses.
Mitigation: host records own a `Set<runId>` and run cleanup is identity-checked.

### Duplicate writers

Risk: resume starts while another process still owns the session.
Mitigation: check the live lease and local registry before resume; the JSONL session continues to detect external changes. Do not weaken its single-writer checks.

### Lost final summary or projection

Risk: watcher unregisters/disposes before `supervisor.summary` or final materialization.
Mitigation: enforce the settlement ordering specified above and test it.

### Projection mutation survives until rebuild

Risk: a feature edits `meta.json`, appears correct, then disappears on the next projection.
Mitigation: forbid canonical `RunStore` mutators and add delete-and-rebuild tests.

### Legacy feature preservation expands scope indefinitely

Risk: unreachable canvas behavior is treated as a migration requirement.
Mitigation: use the disposition table and current route reachability. Historical data access is required; historical execution behavior is not.

### CLI silently loses attended behavior

Risk: switching from the legacy runner removes terminal approvals/questions.
Mitigation: pass terminal callbacks into the `flyt-cli` host and cover them in a subprocess test.

### Authority widens during host reuse

Risk: a host composed for one ceiling/profile is reused for another.
Mitigation: include authority-changing inputs in the stable host key and retain profile narrowing tests.

## Explicit non-goals

Do not include any of the following in this cutover:

- OS-level sandbox implementation;
- Code Mode/PTC;
- SQLite session storage;
- remote or third-party subagent providers;
- a new workflow grammar or arbitrary expressions;
- automatic learned model routing;
- conversion of historical run folders into invented session logs;
- deletion of user legacy flow/run files;
- a DeepSeek Harness package-version upgrade unless a required existing compatibility test cannot run otherwise;
- session branching/fork UI.

These may build on the single-kernel result later. Combining them here would make failures impossible to attribute and would keep the old runner alive longer.

## Completion checklist

- [ ] Desktop, CLI, and Loop start through `RunController` and `ctx.agents`.
- [ ] `ProjectRegistry` no longer constructs or owns a runner.
- [ ] `core/engine.js` no longer imports `core/stackRunner.js`.
- [ ] `flow:run` cannot execute work.
- [ ] All executable `run:*` controls are kernel-only.
- [ ] No Electron handler calls `proj(...).runner`.
- [ ] Liveness, deletion, adoption, and shutdown use the controller registry.
- [ ] Cold reconciliation writes through the session package.
- [ ] `run.reconfigured` is in the durable vocabulary and projection.
- [ ] Canonical rename is event-backed.
- [ ] Canonical projection terminology replaces compatibility terminology.
- [ ] Projection rebuild from `session.jsonl` is tested.
- [ ] Legacy runs are read-only and return stable control errors.
- [ ] Safe legacy source conversion remains non-mutating on read and fail-closed.
- [ ] Legacy-only preload/IPC/renderer controls are removed or extracted from the runner.
- [ ] Relevant old tests are ported or retired with an explicit disposition.
- [ ] Architecture gates report zero production legacy-runner references.
- [ ] Focused real-path tests pass for desktop/API, CLI, and Loop.
- [ ] `npm run build:kernel`, `npm test`, `npm run build`, and `npm run stack -- lint` pass.

## Final architectural statement

When this work is complete, Flyt has one execution system and two storage generations:

```text
Execution:       canonical Cordis kernel only
New run storage: append-only session + rebuildable projections
Old run storage: read-only historical folders
Workflow source: canonical stacks, with conservative one-time legacy source conversion
```

The distinction “kernel run versus daily run” disappears. The only remaining distinction is “canonical session-backed run versus historical read-only run.”

## Background references

This specification was informed by DeepSeek Harness commit `4e84901e6471b79ec0338099867ebb4606d12bb5` (`0.1.2-alpha.4` release line), especially:

- `docs/architecture.md`: one plugin tree, Agent handle versus concrete loop, durable session events versus live capability events, profiles, and capability seams;
- `packages/core/agent/README.md`: callers program against an Agent interface with no loop dependency;
- `packages/core/session/README.md`: event-sourced history, stable-prefix resume/fork concepts, and model-visible-means-logged;
- `packages/core/tools/README.md`: one guarded tool pipeline and explicit cancellation;
- `docs/testing.md`: real entry-path and recorded-session testing.

Repository: <https://github.com/deepseek-ai/deepseek-harness/tree/4e84901e6471b79ec0338099867ebb4606d12bb5>

These are background, not runtime dependencies. This document is the normative design for Flyt; where DeepSeek's product choices differ, Flyt's bounded stacks, profiles, authority ceilings, file-backed runs, and existing product contracts win.
