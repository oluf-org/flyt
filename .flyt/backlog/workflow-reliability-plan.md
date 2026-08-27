# Flyt workflow reliability implementation plan

Status: implemented (2026-08-18)  
Created: 2026-08-18  
Scope: the remaining defects found while running a real feature from Flow through Loop  
Primary objective: make Flyt reliably turn an accepted implementation request into a verified repository change, while reporting the actual model, attempt, progress, and failure state truthfully.

> This is a planning artifact, not a live `*.task.md` backlog item. Split the workstreams below into normal Flyt tasks only when their dependencies and acceptance fixtures are ready.

## Implementation record

All seven workstreams landed. Where the code now lives:

| ID | Landed as |
|---|---|
| WR-01 | `core/effect.js`, executor effect gate, `effect`/`effectScope` in the DSL, `tests/effect.test.js`, `tests/effectExecutor.test.js` |
| WR-02 | attempt ownership in `core/worktree.js`, `work:touch`/`work:reconcile`, `tests/worktreeAttempt.test.js` |
| WR-03 | `effectiveWorkerFor` + `meta.workerOverrides`, `tests/retryOverride.test.js` |
| WR-04 | `planDefaultRoute` + `runtimeConfig.providerPriority` + `resolveWorkerRoute`, `tests/providerPriority.test.js` |
| WR-05 | `core/adapters/failures.js`, `preflightCli`, `autoFallbackTargets`, `src/attempts.js`, `tests/adapterFailures.test.js` |
| WR-06 | `core/planContract.js` (limits, validation, spin detector), `tests/planContract.test.js` |
| WR-07 | `npm run verify:workflow` → `tests/workflowReliability.test.js` |

Two defects outside the plan's scope were found and fixed while implementing it:

- `defaultWorktreeRoot` keyed on the last six bytes of the repository path rather
  than a digest of it, so every checkout whose path ended the same way shared one
  worktree root — the cross-project form of the WR-02 race. Now a real hash, with
  the legacy directory adopted when it already exists.
- `git status --porcelain`'s leading status column was being trimmed away, which
  shifted the first entry's path by one character.

Two scoping decisions differ from the plan's first reading, both to avoid
silently re-defining existing flows:

- The effect contract infers `workspace-change` from an **authored** tool grant
  only. The default (unrestricted) grant contains every tool in the library, so
  inferring from it would demand a diff from every unrestricted node ever
  authored. A `shell` grant is likewise a verification grant, not a promise of a
  diff.
- `requiredInputs` is a new, opt-in declaration. The legacy `inputs` list stays
  best-effort, because fan-out lanes and authored flows legitimately name
  upstream ids that may produce no file.

## 1. Executive summary

The end-to-end exercise proved that Flyt can route work to models, stream activity, create plans, start isolated Loop attempts, and run its verification machinery. It also exposed several gaps between activity and accomplishment:

1. A model or executor can return prose and be marked successful even when a code-changing task produced no repository change.
2. Selecting another model for an `agentTask` retry updates the run's flow node but can leave the persisted task worker unchanged, so the retry still uses the failed model.
3. The Settings provider priority is used by source resolution in some paths, while default worker selection uses a separate hard-coded cross-provider order.
4. A vendor CLI process can fail to spawn before doing model work. Auto-routed calls do not consistently fall through to a healthy provider, and the UI can continue showing the superseded failure while a retry is active.
5. Loop planning can over-decompose a focused change, refer to artifacts that were never produced, or repeat nearly identical planning text for minutes before the general heartbeat detector intervenes.
6. Worktree cleanup is keyed only by task id. Cleanup from an old attempt can therefore remove a newer attempt's worktree if the task is restarted before the old cleanup finishes.

The plan treats completion integrity and attempt ownership as P0 safety work. Routing, retry correctness, and process fallback are P1 reliability work. Planner quality and the final operational harness follow once those foundations are deterministic.

## 2. Success definition

This plan is complete when a focused implementation request can take this path without manual repository editing:

1. A user launches a Flow with an auto-routed worker.
2. The effective provider/model is recorded and matches Settings priority unless explicitly pinned.
3. If that runtime cannot start, an auto route falls through to an eligible healthy source; a pinned route fails clearly.
4. The planner produces a bounded, valid set of tasks whose required inputs have producers.
5. An executor uses tools, changes tracked source or tests when the task requires a repository effect, and cannot report success with an empty effect.
6. A retry with another model runs on that model and records both the requested and effective route.
7. Loop cancellation, restart, and delayed cleanup cannot affect another attempt's worktree.
8. Gates, review, and canary pass; the change lands or fails with one accurate, actionable state.
9. The automated operational test proves the complete sequence and the Electron UI presents the same state.

## 3. Design principles and invariants

- **Truth before optimism.** Model output is evidence, not proof that the requested effect happened.
- **Attempt-scoped mutation.** Every destructive lifecycle action must identify the attempt it owns, not only the reusable task id.
- **One routing policy.** Renderer previews, worker defaults, retries, CLI adapters, and runtime calls must share the same resolution semantics.
- **Pinned means pinned.** Automatic fallback is allowed only for an auto source. An explicit source must fail rather than silently spend elsewhere.
- **Fail before downstream work.** Missing required inputs, invalid plans, and empty required effects should stop at the first boundary that can identify them.
- **Bound autonomous repair.** Re-asks, retries, planner task counts, and intervention ladders remain capped and visible.
- **No weaker safety boundary.** The changes must preserve tool ceilings, approvals, workspace confinement, worktree isolation, gates, review, canary, and spend caps.
- **Operational evidence matters.** Each reproduced production failure gets a regression test, following D42.

## 4. Prioritized task list

| ID | Priority | Task | Depends on | Expected size |
|---|---:|---|---|---:|
| WR-01 | P0 | Enforce effect-aware completion | None | Large |
| WR-02 | P0 | Make worktree lifecycle attempt-scoped | None | Large |
| WR-03 | P1 | Make retry model overrides effective for `agentTask` | WR-01 test fixtures | Medium |
| WR-04 | P1 | Unify provider priority and effective-route reporting | None | Medium |
| WR-05 | P1 | Handle CLI spawn failures and superseded attempts honestly | WR-04 | Medium/Large |
| WR-06 | P1 | Bound and validate Loop planning | WR-01 | Large |
| WR-07 | P1 | Add the end-to-end workflow reliability harness | WR-01 through WR-06 | Large |

Recommended execution order:

1. Run WR-01 and WR-02 independently, then merge both foundations.
2. Implement WR-03 and WR-04; WR-05 follows the unified router.
3. Implement WR-06 using the effect contract introduced by WR-01.
4. Finish with WR-07 and use its failures to tighten earlier acceptance tests.

---

## WR-01 — Enforce effect-aware completion

### Issue

`runExecutorTask` currently treats a non-empty textual deliverable as sufficient to mark a task `done`. That is correct for analysis or documentation-output tasks, but incorrect for a task whose goal is to modify the bound repository. During the observed runs, several model-owned nodes produced confident prose, made no source changes, and appeared successful. Loop eventually rejects an empty diff during landing, but by then the UI has shown green nodes, downstream tasks may have run on fictional results, and time and model budget have already been spent.

The defect is not simply “require every task to change a file.” Some valid tasks intentionally produce Markdown analysis only. Flyt needs an explicit, inspectable effect contract.

### Proposed design

Add a normalized task/node deliverable contract with at least these modes:

- `artifact`: success requires a non-empty run artifact; no project change is required.
- `workspace-change`: success requires a non-empty project/worktree change matching the task's allowed scope.
- `either`: success requires a non-empty artifact or workspace change.
- `none`: reserved for structural/control nodes that do not claim a deliverable.

For backward compatibility, infer a conservative default:

- `agentTask` with project-write tools or a code category defaults to `workspace-change`.
- analysis, evaluation, summarization, and planning nodes default to `artifact`.
- authored configuration may override the inference explicitly.

Record a baseline at task start and evaluate the effect before setting `done`. In a Loop worktree, query the worktree pool. In an ordinary bound workspace, use a bounded workspace change detector that does not stage or mutate files. If a required effect is absent, emit a structured `effect_missing` event and fail or return the node to a retryable state. Do not wait for review to discover it.

### Implementation tasks

- [ ] Define the deliverable/effect contract and normalization in the node/task schema.
- [ ] Add DSL linting and renderer editing support if the contract is author-configurable.
- [ ] Add a pure `evaluateTaskEffect` result with `ok`, `required`, `observed`, and an actionable reason.
- [ ] Capture the effect baseline before executor tools run.
- [ ] Evaluate the effect before writing `status: done` in `core/nodes/executor.js`.
- [ ] Keep the textual output as partial evidence when the effect is missing, but never present it as successful completion.
- [ ] Add `effect_missing` to retrospectives, diagnostics, node feed, and persistent activity.
- [ ] Make generated planners include the effect contract for each generated task.
- [ ] Ensure downstream tasks do not start from a task that failed its required effect.
- [ ] Preserve the existing empty-diff rejection in landing as defense in depth.

### Likely code areas

`core/nodes/executor.js`, `core/stackRunner.js`, `core/worktree.js`, `core/diagnostics.js`, `src/flowTypes.js`, `src/nodeFeedData.js`, `STACK_LANG.md`, `BLOCKS.md`, executor/flow/landing tests.

### Acceptance criteria

- [ ] A code-category `agentTask` that returns polished prose, calls no write tool, and changes no file finishes as retryable failure with reason `required workspace change was not produced`.
- [ ] The same failure is visible in the run feed and retrospective; no node or task is shown as green/done.
- [ ] A code task that edits an allowed source file and returns a non-empty deliverable succeeds.
- [ ] A declared `artifact` analysis task succeeds with a non-empty artifact and no repository diff.
- [ ] A write followed by a complete revert does not count as a workspace effect.
- [ ] Untracked files count as an effect when they are within the workspace and are not ignored run artifacts.
- [ ] Missing-effect tasks do not release their downstream dependents.
- [ ] Loop landing still independently rejects an empty final diff.
- [ ] Existing flow files migrate without manual edits, and their inferred contract is visible in diagnostics.
- [ ] Unit, integration, full `npm test`, Flow lint, and production build pass.

---

## WR-02 — Make worktree lifecycle attempt-scoped

### Issue

Worktree paths and cleanup calls are currently keyed by `taskId`. `work:start` removes any existing tree for the task, and `work:discard` later removes the tree for that same id. If attempt A is cancelled, attempt B starts, and A's asynchronous cleanup finishes late, A can remove B's active worktree. This is a cross-attempt destructive race and can erase valid in-progress work.

### Proposed design

Introduce a unique `attemptId` for every Loop claim/run and make it part of the worktree ownership record. Destructive operations must use a compare-and-delete rule:

- The owner record contains `projectId`, `taskId`, `attemptId`, `runId`, path, branch, and creation time.
- `work:start` creates a new attempt only after acquiring the task lease and resolving any prior owner deliberately.
- `work:discard` and landed cleanup must provide the expected `attemptId`.
- Cleanup refuses to touch a path whose current ownership record does not match.
- Repeated cleanup of the same completed attempt is idempotent.

The worktree path may include the attempt id, or it may remain stable if ownership is still checked atomically. Including the attempt id is easier to inspect and makes accidental aliasing less likely.

### Implementation tasks

- [ ] Add monotonic or collision-resistant `attemptId` creation at claim/start.
- [ ] Persist attempt ownership outside the worktree, alongside the supervisor/backlog state.
- [ ] Return `attemptId` from `work:start` and carry it through heartbeat, run metadata, landing, discard, and UI/API calls.
- [ ] Change `WorktreePool` methods to accept an attempt identity or an exact resolved worktree handle rather than only `taskId`.
- [ ] Add ownership validation immediately before every forced remove and branch delete.
- [ ] Make `work:start` distinguish a stale abandoned attempt from a live leased attempt; never silently remove a live owner's tree.
- [ ] Make cleanup failures visible and actionable instead of swallowing all errors.
- [ ] Add startup reconciliation for orphaned owner records and orphaned git worktrees.

### Likely code areas

`core/worktree.js`, `core/api.js`, `core/supervisor.js`, `core/backlog.js`, `core/heartbeat.js`, `src/loop/*`, landing/supervisor/run-control tests.

### Acceptance criteria

- [ ] A deterministic race test starts attempt A, schedules A's cleanup, starts attempt B, then releases A's cleanup; B's directory, branch, and files remain intact.
- [ ] Cleanup with a stale or incorrect attempt id returns `owner-mismatch` and performs no filesystem or git mutation.
- [ ] Cleanup with the current attempt id removes only that attempt and its intended branch.
- [ ] Calling cleanup twice for the same completed attempt is a successful no-op.
- [ ] Starting while another attempt has a valid lease is rejected with the owning run and remedy, not handled by deletion.
- [ ] Startup reconciliation can identify and safely discard a genuinely orphaned worktree.
- [ ] Loop cancellation and restart remain usable from Electron, CLI, and HTTP API paths.
- [ ] Full `npm test` passes, including a Windows race regression test.

---

## WR-03 — Make retry model overrides effective for `agentTask`

### Issue

The retry UI correctly sends a selected worker to `restartNode`, and the runner writes that worker into the run's `flow.json`. For an `agentTask`, however, execution reads the worker from the already-materialized entry in `tasks.json`. Resetting the task status does not necessarily synchronize that persisted worker. The UI can therefore say a retry was re-pointed while the executor calls the original provider/model.

### Proposed design

Choose one authoritative retry override and apply it consistently. The preferred approach is an attempt-scoped override map in run metadata keyed by node/task id, because it preserves the originally planned task while making retry intent explicit. Effective worker precedence becomes:

1. manual retry override for this run/attempt;
2. explicit run-flow node worker;
3. persisted task worker;
4. category/level/default routing.

Alternatively, synchronizing `tasks.json` during `resetTasksForNodes` is acceptable if audit history preserves the original and requested workers. In either design, log both `requestedWorker` and `effectiveWorker` when the executor starts.

### Implementation tasks

- [ ] Add a pure worker-precedence resolver shared by `restartNode`, `resolveWorker`, and `runExecutorTask`.
- [ ] Persist the manual retry override before resetting tasks.
- [ ] Apply the override to the target generated task and define whether spawned descendants inherit it; default to target-only unless explicitly requested.
- [ ] Support clearing the override back to normal routing.
- [ ] Echo the effective worker from the backend and update the retry UI only after that confirmation.
- [ ] Show a clear error if the requested provider/model cannot be resolved before relaunch.
- [ ] Record requested, resolved, and actually called worker in run logs and retrospectives.

### Likely code areas

`core/stackRunner.js`, `core/nodes/executor.js`, `core/modelSource.js`, `core/api.js`, `electron/preload.cjs`, `src/RetryBox.jsx`, `src/App.jsx`, run-control tests.

### Acceptance criteria

- [ ] An `agentTask` that fails on worker A and is retried on worker B produces its next adapter call on B.
- [ ] `tasks.json` may retain the original planned worker, but the effective override is persisted and inspectable.
- [ ] An `aiStep`, `orchestrator`, and `fanout` retry continue to honor the same UI contract.
- [ ] A plain retry with no model change uses the original effective worker.
- [ ] Clearing a retry pin restores category/provider-priority resolution.
- [ ] The UI never claims “retried on B” unless the backend returns B as effective.
- [ ] Logs contain one unambiguous route record without API keys.
- [ ] Regression tests cover generated `agentTask` nodes, not only authored `aiStep` nodes.

---

## WR-04 — Unify provider priority and effective-route reporting

### Issue

`createResolver` walks `settings.providerPriority` when resolving an auto source for a named model. Separately, `pickDefaultWorker` chooses a model from `core/modelPriority.js` using its own `PROVIDER_ORDER` tables. The runtime config does not currently give that picker one canonical user order. Reordering providers in Settings can therefore change the renderer's route preview or some calls while leaving unpinned default workers on the hard-coded order.

### Proposed design

Keep two distinct concerns but compose them predictably:

- User provider priority answers **which connected provider should be tried first**.
- Per-provider model rankings answer **which model that provider should use for this task kind and effort**.

For an unpinned node, walk the user's normalized provider priority and select the highest-ranked eligible model for the first connected provider. A task-specific provider order should exist only as an explicit override and must be visible in the resolved run configuration. Renderer `routeFor`, backend `createResolver`, and `pickDefaultWorker` should consume the same normalized function or serialized policy.

### Implementation tasks

- [ ] Add normalized `providerPriority` to `runtimeConfig` during every settings rebuild.
- [ ] Refactor `pickDefaultWorker` to consume it instead of starting from hard-coded `PROVIDER_ORDER`.
- [ ] Decide and document how optional task-kind preferences compose with the user order; do not keep two silent winners.
- [ ] Include subscription providers in eligibility using the same connected-state rules as source resolution.
- [ ] Share route-result fields: requested model/source, effective provider/model, resolution reason, and considered candidates.
- [ ] Make Models, retry pickers, diagnostics, and runtime logs display the same effective route.
- [ ] Add a settings-change test proving a running engine rebuilds the route without restart.

### Likely code areas

`core/engine.js`, `core/modelPriority.js`, `core/modelSource.js`, `src/providerMirror.js`, `src/ModelPicker.jsx`, `src/ModelsPage.jsx`, `core/diagnostics.js`, model-source/model-priority tests.

### Acceptance criteria

- [ ] With OpenRouter first and connected, an unpinned code node resolves to OpenRouter rather than a connected provider listed later.
- [ ] Moving Kimi first changes the next unpinned node without restarting Electron.
- [ ] A pinned source remains pinned regardless of priority.
- [ ] A disconnected or incapable provider is skipped with a recorded reason.
- [ ] Renderer preview, `flyt doctor`, node-start log, and actual adapter call agree on provider and model.
- [ ] Every supported provider, including enabled subscription CLI providers, participates in one normalized order.
- [ ] No route record or diagnostic contains an API key.
- [ ] Existing explicit node/category/level worker precedence remains intact.

---

## WR-05 — Handle CLI spawn failures and superseded attempts honestly

### Issue

The default planning attempt failed with `spawn EPERM` before the Codex CLI could do useful model work. Retrying through OpenRouter succeeded, but the prior failure presentation remained visible while the new attempt was active. This combines two defects:

1. Local runtime launch failures are not classified distinctly enough for auto routing and diagnostics.
2. Run presentation does not model attempt supersession explicitly, so an old terminal error can compete with a new live attempt.

### Proposed design

Classify adapter failures into at least authentication, capability/model mismatch, quota/rate, transient network, executable missing, permission/spawn, protocol, timeout, and user cancellation. For an auto source, executable-missing or spawn-permission failure may try the next eligible provider once the failure is recorded. For an explicit pin, fail immediately with the binary/path/account remedy.

Represent every manual or automatic retry as an attempt record with status `active`, `succeeded`, `failed`, `cancelled`, or `superseded`. The node's primary visible state comes from the newest non-superseded attempt; prior failures remain available in history.

### Implementation tasks

- [ ] Normalize CLI adapter launch errors with stable codes and sanitized details.
- [ ] Add a cheap CLI preflight used by Settings/doctor and optionally before an auto route selects a CLI provider.
- [ ] Teach auto routing to fall through only for eligible infrastructure failures and only within a bounded candidate list.
- [ ] Never fallback from an explicitly pinned source without user action.
- [ ] Persist attempt history and `supersededBy` linkage.
- [ ] Derive node feed/failure UI from the current attempt while retaining an expandable attempt history.
- [ ] Show fallback activity such as `Codex could not start; trying OpenRouter` without leaving a stale fatal banner.
- [ ] Ensure spend and call traces are attributed to the correct attempt.

### Likely code areas

`core/adapters/cliDelegate.js`, Codex/Claude CLI adapters, `core/adapters/index.js`, `core/modelSource.js`, `core/stackRunner.js`, `src/nodeFeedData.js`, `src/RunFailure.jsx`, `src/activityStatus.js`, diagnostics and adapter tests.

### Acceptance criteria

- [ ] A stubbed CLI `spawn EPERM` produces a stable `runtime-permission` failure code and a remedy naming the configured executable/path setting.
- [ ] With source `auto`, a failed CLI preflight falls through to the next connected compatible provider and records both attempts.
- [ ] With source pinned to Codex, the same failure does not call OpenRouter.
- [ ] While the fallback/retry is active, the primary UI shows the active attempt; the old failure appears only in attempt history.
- [ ] If the new attempt fails too, both failures remain inspectable and the newest failure is primary.
- [ ] A cancelled attempt is never classified as provider failure or retried automatically.
- [ ] Automatic fallback is bounded, respects timeout/spend rules, and cannot cycle through the same source twice.

---

## WR-06 — Bound and validate Loop planning

### Issue

A focused UI change was expanded into seven to nine tasks, some upstream tasks claimed to produce documentation only in model prose, and downstream tasks logged `context_input_missing` but continued. In another run, the planner streamed thousands of near-identical “I’ll inspect…” sentences without calling a tool. The general heartbeat correctly detected byte-identical work, but only after roughly six minutes. This is too slow and too coarse for a planning-specific failure.

There are three related problems:

- **Liveness:** repetitive streamed planning text can be expensive activity without progress.
- **Plan size:** a precise change can be fragmented below the smallest independently verifiable unit.
- **Contract validity:** dependencies and declared required inputs are not fully validated before execution.

### Proposed design

Add a bounded planner contract and validate it before materialization:

- default `maxPlanTasks` with an explicit higher cap for broad requests;
- every task declares its effect contract, outputs, required inputs, dependencies, gates, and blast radius;
- every required input has exactly one existing source or producer;
- tasks should be independently verifiable and should not exist merely to pass prose to the next task when one executor can perform the work safely;
- invalid plans receive one structured re-ask; a second invalid result fails clearly.

Add a planning-stream detector separate from the six-minute worktree heartbeat. It should use bounded rolling evidence such as repeated normalized lines, low novelty across windows, no tool calls, and no structured-contract progress. It must avoid killing a quiet reasoning call merely because time passed. When tripped, abort the attempt, record evidence, and perform one bounded nudge/retry or move to the normal intervention ladder.

Treat missing required context as a planner/graph error before an executor starts. Optional inputs must be explicitly marked optional.

### Implementation tasks

- [ ] Define planner limits (`maxPlanTasks`, maximum depth, one re-ask, maximum contract bytes) in runtime configuration.
- [ ] Extend generated task contracts with `effect`, `outputs`, `requiredInputs`, and optional inputs.
- [ ] Add pure plan validation for producer existence, cycles, duplicate outputs, task-count cap, and empty/unverifiable tasks.
- [ ] Reject or re-ask plans that over-fragment a focused request; include validator errors in the re-ask.
- [ ] Fail required `context_input_missing` before executor model invocation; continue only for inputs declared optional.
- [ ] Add a rolling repetition/novelty detector to streamed planner output.
- [ ] Abort and classify a planner spin quickly, preserving the partial stream as evidence.
- [ ] Record planning metrics: task count, re-asks, time to first tool, tool calls, repeated-window score, and validation errors.
- [ ] Display the reason and intervention in Loop activity/worker cards.

### Likely code areas

`core/stackRunner.js` plan materialization/re-ask paths, `core/agent.js`, `core/heartbeat.js`, `core/nodes/executor.js`, `core/nodes/orchestrator.js`, `src/loop/*`, flow-contract tests, supervisor tests.

### Acceptance criteria

- [ ] A focused request equivalent to the activity feature produces no more than the configured default task cap unless the plan explains and is explicitly allowed to exceed it.
- [ ] Each generated task has a concrete effect and at least one independently checkable completion condition.
- [ ] A plan referencing a required input with no producer is rejected before any executor call.
- [ ] An optional missing input is logged and may continue without being reported as an error.
- [ ] Repeating near-identical planning sentences with no tool/contract progress is interrupted within 60–90 seconds under the test thresholds, not six minutes.
- [ ] A legitimate long reasoning stream with increasing content/novelty is not interrupted.
- [ ] Only one corrective re-ask is allowed; the second invalid plan fails with all validator errors.
- [ ] Planner metrics are visible in the run log and retrospective.
- [ ] The next executor receives all declared required context with no `context_input_missing` event.

---

## WR-07 — Add an end-to-end workflow reliability harness

### Issue

Most individual mechanisms already have strong unit tests, but the observed failures lived at their seams: UI retry to persisted task worker, Settings priority to default selection, old cleanup to new worktree, and model prose success to repository effect. A passing unit suite did not prove the real Flow-to-Loop workflow.

### Proposed design

Create a deterministic scripted-provider operational scenario that runs the actual engine and APIs against a temporary git repository. The script should deliberately exercise failure and recovery rather than only the happy path. Add a thin Electron smoke test for the user-visible route/activity/failure transitions. Keep an optional real-provider canary separate so ordinary CI remains deterministic and key-free.

### Scenario

1. Create a temporary repository with one source file and a small test gate.
2. Launch a flow whose first auto candidate simulates a CLI spawn failure.
3. Confirm automatic fallback selects the next provider according to priority.
4. Return one invalid/repetitive plan, then a bounded valid plan after the allowed correction.
5. Make executor worker A return prose with no edit; verify `effect_missing`, not success.
6. Retry that `agentTask` on worker B; B edits the source and test.
7. Simulate cancellation cleanup from attempt A after attempt B starts; verify B survives.
8. Run gates, diff review, merge, and canary.
9. Assert the final repository contains the requested change and the task/run states are truthful throughout.

### Implementation tasks

- [ ] Build reusable scripted adapters for spawn failure, no-effect success, invalid plan, valid edit, review, and canary.
- [ ] Add event/state assertions for requested route, effective route, attempt identity, effect result, and cleanup ownership.
- [ ] Add an Electron smoke fixture that navigates away during retry/fallback and checks current activity plus expandable prior failure.
- [ ] Capture a compact workflow report artifact for failed CI runs.
- [ ] Add an opt-in real-provider canary command that uses configured credentials but is not required in normal CI.
- [ ] Document the single command for deterministic acceptance.

### Likely code areas

New integration test fixture(s), `tests/engine.test.js`, `tests/runControl.test.js`, `tests/supervisor.test.js`, Electron smoke tooling, package scripts, CI configuration if runtime permits.

### Acceptance criteria

- [ ] One deterministic command exercises the complete scenario above without an API key.
- [ ] The test fails if a no-diff executor is marked done, if a retry calls worker A, if provider priority is ignored, or if stale cleanup removes attempt B.
- [ ] The test verifies gate, reviewer, merge, and canary results rather than stopping at model output.
- [ ] The Electron smoke test proves the newest attempt is primary across Home, Flows, Models, Runs, and Loop navigation.
- [ ] Failure output names the first violated invariant and links it to the relevant run/task/attempt artifacts.
- [ ] The optional real-provider canary records cost and routing but never prints or persists credentials.
- [ ] Full `npm test` and `npm run build` pass.

## 5. Cross-cutting telemetry

Add these bounded, secret-free fields to run logs and diagnostics as the workstreams land:

- `attemptId`, `supersededBy`, and worktree owner identity;
- requested source/model and effective provider/model;
- route candidates with sanitized skip reasons;
- time to first output, first tool, first write, and first verified effect;
- tool-call count before first write;
- effect contract and observed effect summary;
- planner task count, re-ask count, validation errors, and repetition score;
- cleanup outcome (`removed`, `already-removed`, `owner-mismatch`, or `live-owner`);
- terminal reason and the attempt that owns it.

Never log API keys, raw credentials, unbounded prompts, raw command output, or full tool arguments in these summaries.

## 6. Rollout and migration

1. Land attempt identity and effect evaluation behind internal compatibility defaults.
2. Migrate existing runs/tasks lazily: missing `attemptId` becomes a read-only legacy attempt; missing effect contracts use documented inference.
3. Turn on truthful failure states before automatic repair/fallback, so new automation cannot hide defects.
4. Enable provider-priority unification and verify route previews against actual calls.
5. Enable planner validation in report-only mode for a small set of test runs, then make invalid required-input plans fail closed.
6. Make the end-to-end deterministic harness a required CI check once stable.
7. Keep real-provider canaries opt-in until cost, flakiness, and credential policy are explicitly decided.

## 7. Definition of done for every workstream

A workstream is not complete merely because its local unit tests pass. It must also meet all of these:

- [ ] The original production failure has a deterministic regression test.
- [ ] The UI state matches the persisted backend state after reload.
- [ ] Diagnostics explain the failure and the next safe action.
- [ ] Existing approval, tool-ceiling, spend, worktree, review, and canary boundaries remain intact.
- [ ] New logs and UI summaries are bounded and secret-safe.
- [ ] Relevant living documentation describes current behavior rather than the implementation diary.
- [ ] `npm test` passes.
- [ ] `npm run build` passes for renderer or Electron-facing changes.
- [ ] `npm run flow -- lint` passes when flow contracts or shipped flows change.
- [ ] At least one real workflow run confirms the behavior, per D42.

## 8. Risks and decisions to settle during implementation

- Whether effect contracts belong directly in the flow DSL, only in materialized tasks, or both. Prefer one normalized internal shape even if authoring has two entry points.
- Whether auto fallback may cross billing providers. The proposed rule permits it only when source is explicitly `auto`; the UI should make that consequence clear before launch.
- Whether task-kind model preferences are a reorder of user provider priority or only a within-provider model ranking. This plan recommends the latter because Settings should remain truthful.
- How quickly planner repetition may be interrupted without punishing long reasoning. Base the detector on lack of novel visible work plus no tool/contract progress, not elapsed time alone.
- Whether legacy task-id-only worktrees can be safely adopted. Prefer reconciliation and explicit orphan handling over guessing ownership.
- Whether a repository effect may be satisfied by generated files alone. The contract should support path scopes so a task cannot satisfy “change the application” by writing an unrelated note.

## 9. Final product-level acceptance

The reliability initiative is accepted only after repeating the original user journey with Flyt doing the implementation work:

- [ ] Start from Home with a focused repository feature request.
- [ ] Use or create a Flow, run it, and transfer to Loop when appropriate.
- [ ] Observe accurate provider/model and activity throughout.
- [ ] Exercise at least one controlled failure and retry on another model.
- [ ] Finish with a non-empty, relevant source/test diff created by the Flyt-managed agent.
- [ ] Pass declared gates, independent review, merge, and post-merge canary.
- [ ] Confirm no stale failure, false-green node, missing required context, orphaned worktree, or cleanup race occurred.
- [ ] Produce a concise run report with cost, attempts, route changes, files changed, tests, and any interventions.

