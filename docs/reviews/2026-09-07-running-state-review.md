# Goals and workflows: running-state review

Reviewed September 7, 2026, including the goal/loop control patch from the preceding task. The findings below record the pre-fix behavior. All eight findings have since been addressed in the working tree.

**Original assessment:** the existing session log and controller architecture is a useful foundation, but running state is not yet reliable across cancellation, concurrent lifecycle operations, process recovery, and cleanup. The earlier patch improves normal goal retry and controls; it does not resolve the shared workflow lifecycle defects below.

Eight actionable findings were established with ten deterministic fault probes. Five are P1 issues to address before relying on unattended execution and recovery. Three are P2 correctness/usability issues. The probes use temporary data and controlled providers/session timing; they do not exercise the user's real goals or make paid model calls.


## Resolution and verification

All eight findings are implemented:

1. External cancellation settles the adapter call independently of provider cooperation; late text callbacks are ignored. Shutdown signals owned work before bounded waits.
2. Kernel Pause, Continue, Stop and completion use an ordered transition queue. Stop interrupts immediately, and terminal states cannot be overwritten by a late control event.
3. Project opening, listing and snapshots reconcile orphaned sessions. Recovery acquires execution ownership before writing; it cannot race a new launch. Interrupted runs expose recovery controls.
4. Controller and kernel reserve run identities before asynchronous launch. Starting work is cancellable, duplicate starts are rejected, and shutdown closes admission. Shared hosts retain ownership throughout dispatch.
5. Goal child recovery uses the kernel's torn-tail-aware session reader.
6. Goals distinguish local, external and absent owners. Current controllers forward controls through a token-bound durable inbox; orphaned goals remain recoverable. An older live process without this protocol is identified explicitly and must be controlled there.
7. Goal retry accepts failed containers and falls back to the root for failures without a node. Container retries invalidate descendant replay while preserving completed predecessors and already-consumed budgets.
8. Execution settlement and resource cleanup are separate. Cleanup has bounded waits, an inspectable error and a Retry cleanup action. Ownership is retained while resources remain in use; retries reuse a pending cleanup and skip completed steps. Goals wait for child cleanup before progressing.

The original ten reproductions now assert the corrected behavior in [executionLifecycle.test.js](D:/electron/llm-flow/tests/executionLifecycle.test.js), with additional controller and goal regressions. The historical JSON records the original failures; the probe command now runs the fixed-behavior regressions.

Verification: production build passed. The full suite passed 2,543 tests with four skips and no failures, followed by 150 focused tests covering the final lifecycle, UI state, cleanup and external-controller changes. The final recovery coordination adjustment also passed its targeted regression suite. No installed application or real saved goals were modified, and no paid model calls were made.

## Findings, ordered by priority

### 1. P1 — Stop can remove the timeout and then wait indefinitely

Source: [core/adapters/index.js:165](D:/electron/llm-flow/core/adapters/index.js:165), [core/goalController.js:346](D:/electron/llm-flow/core/goalController.js:346), [core/api.js:2417](D:/electron/llm-flow/core/api.js:2417).

`startDeadline.onOuterAbort` clears both timers and aborts the downstream signal, but never rejects the `expired` promise used by `callModel`'s race. An adapter that does not settle after abort therefore keeps the call pending, with its hard deadline now disabled. This affects workflow Stop and goal Pause/Stop because they share this boundary. Goal and run shutdown both await settlement; API shutdown waits for authoring and goals before signaling remaining workflow runs, so one stuck cancellation can also delay stopping unrelated work.

**Reproduced:** a controlled provider ignored abort. With an 80 ms hard deadline, the call was still pending 150 ms after cancellation. It settled only when the probe explicitly released the provider. This establishes the missing independent cancellation settlement; it does not assume that every built-in provider ignores abort.

**Improve:** reject the caller-facing race with an abort error on external cancellation, independently of adapter cooperation. Preserve the original terminal outcome against late provider callbacks. Retain separate process/tool ownership until actual resource cleanup is confirmed. Broadcast shutdown cancellation to all owned work first, then await bounded cleanup and report any resources that remain.

### 2. P1 — Control events can overwrite the actual lifecycle state

Source: [kernel/src/plugins/stack-runner.ts:361](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:361), [src/v2/Work.jsx:97](D:/electron/llm-flow/src/v2/Work.jsx:97).

Pause changes the in-memory flag before durably appending `pausing`. Meanwhile the walker can reach its boundary and append `paused`. If the control append completes later, the final record becomes `pausing` even though execution is waiting at the pause gate. The UI disables Pause and does not offer Resume in that state.

Stop captures a live run, then awaits opening/appending the control event before signaling it. The walker can finish during that wait. The late `stopping` event then becomes the final stage even though the run has already settled and left the kernel's live map. The UI disables Stop when it sees `stopping`.

**Reproduced:** delayed session appends produced both `execution → paused → pausing` with Resume unavailable, and `execution → done → stopping` with `settled().status === 'done'` and no live kernel run.

**Improve:** serialize lifecycle transitions per run/attempt and validate them against the current execution generation. Record requested controls separately from observed execution phase. Terminal outcomes must not be superseded by a late command acknowledgement. Add equivalent ordering coverage for Continue, repeated controls, and controls arriving at the final block boundary.

### 3. P1 — Reopening an orphaned workflow still shows it running

Source: [core/runController.js:132](D:/electron/llm-flow/core/runController.js:132), [core/api.js:1124](D:/electron/llm-flow/core/api.js:1124), [core/api.js:1147](D:/electron/llm-flow/core/api.js:1147).

Canonical session repair is called by start/resume/restart operations. Project opening, run listing, and snapshot retrieval do not invoke it or reconcile execution ownership. Run lists read the materialized stage; snapshots project the last recorded events. A dead workflow can therefore stay `execution` with active blocks when the user only opens it. Stop looks in the process-local live map and returns `run_not_live`. This reproduces the reported class of “running, but nothing is actually running” for workflows after the goal-specific display fix.

The repair controller also marks a root repaired before its asynchronous repair completes, and caches that decision for the process lifetime. Concurrent callers need to await the same repair operation; a later external crash needs a fresh ownership assessment.

**Reproduced:** wrote an orphaned canonical session without a live lease, then called real `run:snapshot`, `run:list`, and `run:stop`. Both reads returned `execution`; Stop returned `run_not_live`.

**Improve:** reconcile ownership at project activation and when opening a nonterminal run. Return an effective interrupted state when no owner exists, with a resume action. Keep observed state separate from historical events if a read is not intended to append recovery records. Coalesce recovery work using an in-flight promise rather than an early boolean flag. Protect live owners during all repair writes.

### 4. P1 — Starting work is not owned until after it starts

Source: [core/runController.js:223](D:/electron/llm-flow/core/runController.js:223), [core/runController.js:380](D:/electron/llm-flow/core/runController.js:380), [kernel/src/plugins/stack-runner.ts:184](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:184).

The controller checks `isLive` before awaiting host composition and dispatch, then registers ownership afterward. Two requests for one run ID can both pass. The kernel start path also has no per-ID reservation. They can execute twice and append into the same canonical session while only one run object remains addressable in the maps.

The same unowned interval affects shutdown: it snapshots registered live runs, ignores host boots and pending launches, and has no closing flag to reject later registration. A launch already awaiting its host can start after shutdown has returned.

**Reproduced:** concurrent starts through `RunController` and the real kernel produced two distinct executions and two block invocations for one run ID. Separately, shutdown returned `stopped: 0` during host boot, then releasing the boot produced a live run after shutdown completed.

**Improve:** reserve the run ID before the first asynchronous operation, with a durable attempt/owner identity where multiple processes are supported. Represent `starting` as owned work, retain requested cancellation through boot, and reject/join duplicate launches. Shutdown must close admission, signal pending and active work, and drain both. Apply the same serialization to resume and restart.

### 5. P1 — Goal recovery fails on a torn session tail before robust recovery runs

Source: [core/goalController.js:446](D:/electron/llm-flow/core/goalController.js:446), [core/goalController.js:472](D:/electron/llm-flow/core/goalController.js:472).

The goal child path reads the entire JSONL file, splits it, and parses every nonempty line directly. It does this before calling the run controller's resume/repair path. A process interrupted during the final append can leave a partial JSON object; the goal then fails on parsing before the kernel's tolerant session reader can recover it. The normal failure-retry path retains that child, so repeated retries encounter the same tail again.

**Reproduced:** a session with two valid records and a partial third was readable through `readSessionLogFile`, but `GoalController.child` threw `Unexpected end of JSON input` with zero calls to resume.

**Improve:** use the shared canonical reader for all goal event inspection and run controlled repair before deriving recovery actions. Avoid whole-file string parsing, which also scales poorly on long tool-heavy runs. Keep corruption in the middle of a log distinct from a recoverable incomplete tail.

### 6. P2 — Goal status and ownership disagree across controllers

Source: [core/goalController.js:84](D:/electron/llm-flow/core/goalController.js:84), [core/goalController.js:253](D:/electron/llm-flow/core/goalController.js:253).

Goal reads infer interruption solely from absence in this controller's local map. Control and start instead inspect `owner.json` and reject another live process/controller. Consequently a reader can advertise `interrupted`, `recoverable: true`, and recovery controls while the ownership check correctly refuses them. Goal owners also record only PID, without the host, execution generation, or freshness information used by workflow leases.

**Reproduced:** an owner file held by a live controller was projected by a separate reader as interrupted/recoverable; Stop then failed with “Goal is owned by another active controller.”

**Improve:** use one ownership assessment for both reads and mutations. Expose local owner, external owner, absent owner, and uncertain ownership explicitly. Route controls to an external owner or accurately describe the limitation. Add a generation/nonce and heartbeat so a stale or reused PID cannot masquerade as the original execution.

### 7. P2 — Failed containers cannot use the new goal retry path

Source: [core/goalController.js:448](D:/electron/llm-flow/core/goalController.js:448), [kernel/src/plugins/stack-runner.ts:635](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:635).

The kernel legitimately reports an Until container's ID as the failed block when its condition never holds. Goal resume picks that ID automatically, but validates retries against authored leaf blocks only. It rejects the container as `Unknown retry node`. Failures without a block ID likewise need an explicit recovery policy; simply resuming a terminal failed session reads the same failure back.

**Reproduced:** a canonical Until-failure event sequence produced `Unknown retry node: repeat-until` before dispatch. The fixture matches the kernel's documented event shape; it does not involve a live provider.

**Improve:** classify recovery into retry a failed leaf, retry a container subtree, rerun the uncommitted iteration, or require a repaired definition. Define which cached descendants must be invalidated for each choice. Offer only actions the backend can execute and retain completed iteration evidence and spent budget.

### 8. P2 — Execution and cleanup share one “live” flag

Source: [core/runController.js:191](D:/electron/llm-flow/core/runController.js:191), [core/runController.js:378](D:/electron/llm-flow/core/runController.js:378), [core/goalController.js:470](D:/electron/llm-flow/core/goalController.js:470).

The controller keeps its live entry and heartbeat until subprocess cleanup, sandbox cleanup, the after-settlement hook, and projection complete. The kernel removes the run when execution settles. During this interval the controller says live while kernel controls return not-live. Goals await that entire settlement promise before consuming the child outcome, so slow cleanup also keeps the parent labelled running after its child has finished.

Keeping resource ownership during cleanup is appropriate. Using that ownership as the execution status is the problem. A hanging cleanup/summary hook makes the mismatch indefinite.

**Reproduced:** held a cleanup promise after a done outcome. `RunController.isLive` remained true, its lease remained registered, and Stop returned `run_control_failed` because there was no executing kernel run.

**Improve:** expose `executionPhase`, terminal outcome, and `cleanupPhase` separately. Display “Finishing cleanup” or a specific blocked cleanup state and retain the resource lease until quiescence. Bound hooks and make cleanup failures inspectable/retryable without pretending that successful workflow execution is still running or rerunning it.

## Improvements to the shared design

Keep GoalController responsible for goal progress and iteration decisions, and keep the kernel responsible for block execution. Share a lifecycle/ownership model across both surfaces:

| Dimension | Purpose |
|---|---|
| Execution phase | Starting, running, waiting for approval/input, pausing, paused, stopping, settled. |
| Outcome | Success, failure, stopped, interrupted; goal-specific outcomes remain on the parent. |
| Owner and attempt | Local/external/none/unknown, process identity, attempt generation, lease freshness. |
| Requested control | Pause/stop/resume request ID and timestamp, with explicit acknowledgement and completion. |
| Progress | Last meaningful progress, current nodes/child, and budget checkpoints. A heartbeat is not proof of forward progress. |
| Cleanup | Pending/running/complete/failed, independently of the execution outcome. |
| Available actions | Backend-computed `canPause`, `canStop`, `canResume`, retry targets, and reasons for unavailable actions. |

This lets the UI report “waiting for you,” “paused,” “interrupted,” or “finishing cleanup” using the same facts that the control endpoint uses. It also avoids having every view infer controls from slightly different sets of stage strings.

Pause semantics need to be explicit: goals currently abort the child and later resume durable progress; ordinary workflows pause at a block boundary; backlog automation pauses new task pickup while current tasks settle. These can remain different, but their labels and pending-control feedback should say what is happening. A pending pause should remain cancellable, and Stop should remain actionable throughout.

Goal runtime accounting should use a dedicated elapsed-time checkpoint rather than the general `updatedAt` timestamp. That timestamp also changes for edits/control writes and is not a durable heartbeat of execution time. Preserve limits across recovery while distinguishing active time, paused time, and offline time.

Control responses should return the actual acknowledged state. For example, `run:resume` currently discards the controller's negative Continue result and returns `ok: true`; goal-owned run control responses hard-code `pausing`/`stopping` even when the parent was already terminal or changed synchronously. This is a source-inspected contract inconsistency, in addition to the reproduced findings above.

## Suggested implementation order

1. Fix cancellation settlement and terminal/control event ordering; make shutdown signal all work before waiting.
2. Add launch reservations, attempt identity, and lifecycle serialization; cover shutdown during boot.
3. Reconcile orphaned state on read/open and use the shared session reader in goal recovery.
4. Unify ownership assessment and compute available controls on the backend.
5. Add container/iteration recovery policies and separate cleanup status from execution status.
6. Align progress, waiting-state presentation, and elapsed-time accounting across views.

Preserve the strengths already present: canonical append-only sessions, durable child identities, pinned recipes, completed-node replay, recorded control intent for goals, retained evidence, and shared goal call/spend limits. The normal pause/resume and failed-leaf retry tests demonstrate useful working behavior; the missing coverage is primarily concurrency, crash timing, and uncooperative dependencies.

## Validation and scope

The focused existing suite passed **75 tests** across kernel lifecycle repair, run controller, workflow projection/view, goal execution/foundation, and workflow reliability. The ten fault probes reproduced the outcomes recorded in [the results](D:/electron/llm-flow/docs/reviews/2026-09-07-running-state-probes.json). Passing the existing tests therefore does not establish correctness for these additional scenarios.

Run the [probe script](D:/electron/llm-flow/docs/reviews/2026-09-07-running-state-probes.mjs) from the repository with:

```powershell
$env:FLYT_SANDBOX_MODE = 'danger-full-access'
$env:FLYT_TEST_MOCK_PROVIDER = '1'
node docs/reviews/2026-09-07-running-state-probes.mjs
```

The probes assert the current defective outcomes so they can serve as reproducible review evidence. When implementing fixes, invert the relevant assertions into regression tests. Review covered the current source, normal regression tests, controlled asynchronous ordering, and synthetic persisted state. It did not inspect or change the user's saved runs, launch the installed desktop UI, or test every external provider.
