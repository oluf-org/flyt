**Flyt harness review — September 5, 2026**

The highest-yield work is to make the existing execution and evidence contracts reliable. Flyt already has the major building blocks: a canonical kernel runner, append-only sessions, explicit tool ceilings, provider fallback evidence, isolated Loop worktrees, external gates, review, and canary checks. These are valuable foundations. The most consequential gaps I found concern work being reported complete without executing, context crossing supposedly isolated boundaries, and the difference between the request actually sent and the request the trace can reconstruct.

This is a review of the working tree, including the existing uncommitted changes, based on commit `52fc030980208ef8f925ecc658bba8cb039eb9f0`. No production code was changed. The accompanying reproduction script uses local scripted model responses and temporary session directories.

**Validation performed**

- `npm test`: 2,422 tests; 2,418 passed, 4 skipped, 0 failed; approximately 73 seconds.
- `npm run build`: passed, including kernel TypeScript compilation and the renderer production build.
- `npm run lint`: passed for all six shipped stacks. This command validates stacks; it is not a general JavaScript/React lint pass.
- Five additional probes confirmed defects described below, despite the passing suite.
- The four skipped tests exercise the real Windows sandbox. The local Windows sign-in could not run that backend. Its enforcement was therefore not verified here. Release CI does contain additional platform sandbox checks.
- No paid model benchmark, live provider call, or interactive Electron acceptance run was performed. Estimates of quality, spending, and latency improvements are engineering judgments, not measured percentage gains.

**Priority and effort**

Effort means focused engineering days for one developer familiar with this codebase, including regression coverage and review. Medium is roughly 2–5 days; high is roughly 1–2 weeks. The ranges below overlap at their boundaries, and shared test infrastructure makes them non-additive.

| Rank | Improvement | Expected payoff | Effort | Evidence |
|---|---|---|---|---|
| 1 | Give every loop iteration and retry a durable execution identity | Prevent silently skipped work and incorrect successful resumes | High: 4–7 days | Two reproduced defects |
| 2 | Enforce context isolation at the model request boundary | Preserve independent work and reduce unrelated prompt history | Medium: 3–5 days | Reproduced cross-lane history |
| 3 | Compact complete tool exchanges and preserve explicit task state | Avoid malformed requests and loss of long-task context | Medium: 3–5 days | Reproduced orphan tool results |
| 4 | Persist and display the effective model request | Make Trace, debugging, and replay accurately explain execution | Medium: 2–4 days | Reproduced missing hook content; UI inspection |
| 5 | Add shared request-level spending and resource admission | Bound concurrent work across desktop, CLI, and Loop | High: 4–7 days | Architectural gap; overspend not measured |
| 6 | Expand tests around real execution paths and task outcomes | Catch behavioral regressions that the current green suite misses | High: 5–8 days initially | Passing suite plus failing independent probes |
| 7 | Make long-run projections incremental and apply stream backpressure | Keep inspection responsive as sessions and concurrency grow | High: 4–7 days | Code-path evidence; load impact not benchmarked |

**1. Give every iteration and retry a durable execution identity**

**What exists and what is wrong.** The stack runner identifies completed work by the authored block ID. That is adequate for a block executed once, but the same authored block can run repeatedly inside Repeat, For each, and Until. The completion map cannot distinguish those occurrences. `runRepeat` reuses the same map on every pass, while `runBlock` returns a cached outcome when that block ID is already present. A later iteration is consequently treated as work already completed. Resume reconstructs the same block-ID map from the log, introducing the same ambiguity across interruptions.

**Confirmed behavior.** A canonical stack containing `Repeat 3` executed its body once and returned `done`. A three-item For each ran `alpha`, was stopped at the next boundary, then resumed to `done` without executing `beta` or `gamma`. These are silent correctness failures: the user receives a successful result for a program that did not run as authored.

**Recommended change.** Separate the stable authoring ID from an execution-instance ID. Derive an instance from the run, container path, iteration/item ordinal, and attempt. Persist iteration entry and settlement, with the frozen roster for For each, so recovery resumes the exact program instance. Keep authored IDs for editing and display; key execution completion and outputs by instance. Resolve predicates within the correct instance scope. Include this identity in model call IDs too: the current `${blockId}-${step}` construction repeats when a block starts another turn or attempt.

Simply clearing the completion map would fix the fresh Repeat symptom while risking duplicated work after restart. Recovery must distinguish an already executed occurrence from a future occurrence. For a tool whose external effect completed before its result was recorded, retain an explicit uncertain state and reconcile or require a decision; an execution ID alone does not guarantee exactly-once external effects.

**Effort: high, 4–7 days.** The change spans scheduler, events, recovery, and projections. Acceptance should cover nested containers, stop/resume after every item, retries, repeated predicates, and unique call attribution. `Repeat 3` must execute three times, and resuming the example must execute only `beta` and `gamma`.

Evidence: [iteration traversal](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:486), [For each traversal](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:581), [completion reuse](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:660), [model call IDs](D:/electron/llm-flow/kernel/src/blocks/run.ts:371).

**2. Enforce context isolation where model requests are assembled**

**What exists and what is wrong.** Parallel lanes receive separate input values and copies of the completion map. That isolates explicit data flow and predicates. However, their model-backed blocks open the same run session. The shared agent loop derives messages from the whole session unless `isolated` is explicitly true. Ordinary AI steps do not set that option, and ordinary work blocks enable it only through configuration. Thus input isolation does not imply transcript isolation.

**Confirmed behavior.** I ran two lanes with `maxParallel: 1`, which removes timing uncertainty while retaining parallel-lane semantics. The second lane's model request included the first lane's output and both lanes' system prompts. With overlapping execution, the exact history available can depend on timing. A supposedly independent reviewer or second analysis can therefore be influenced by its sibling's conclusions. A downstream block can also inherit unrelated system instructions and tool history, increasing prompt size and making behavior harder to explain.

**Recommended change.** Make context scope an explicit execution contract. Build each request from the current block or lane's own transcript plus the upstream artifacts it is allowed to consume. Freeze the upstream boundary when a parallel container starts. Share sibling outputs only at an explicit join. Use the existing generated-worker child-session machinery as a starting point, while keeping the parent session authoritative for ordering and links. Decide explicitly whether a sequence passes only its predecessor's output or a broader selected history; encode that choice rather than deriving it accidentally from one shared log.

**Effort: medium, 3–5 days.** This is primarily request assembly and execution-scope plumbing, with some compatibility decisions for workflows relying on broad history. Acceptance must inspect the actual messages delivered to the model for both serially scheduled and concurrent lanes. A sentinel from one lane must never appear in another lane, while the join must receive the declared outputs. Measure input-token changes afterward; reduced context cost is likely, but the correctness benefit is the primary reason to do it.

Evidence: [parallel lane execution](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:458), [whole-session message derivation](D:/electron/llm-flow/kernel/src/blocks/run.ts:370), [AI step invocation](D:/electron/llm-flow/kernel/src/plugins/blocks-aistep.ts:101), [optional work isolation](D:/electron/llm-flow/kernel/src/plugins/blocks-core.ts:231).

**3. Compact complete tool exchanges and preserve explicit task state**

**What exists and what is wrong.** Context budgeting already prunes superseded tool previews, retains artifact handles, reserves output space, and records a checkpoint. The risky part is the fallback to the last two non-system messages when no recent user boundary exists. Agent work commonly consists of one user assignment followed by many assistant/tool exchanges. Two messages are not necessarily one complete exchange, especially when an assistant requests multiple tools.

**Confirmed behavior.** Given six assistant turns that each called two tools, compaction returned `system, user, system, tool, tool`. Both retained tool results had lost the assistant message that requested them. This violates the tool exchange structure at the provider-neutral request boundary. I did not send the malformed request to a paid provider; rejection or degraded handling depends on the provider.

There is also a quality limitation: the checkpoint uses short excerpts from up to three prior assistant messages as completed findings, and truncates the original assignment. Those excerpts may contain a plan rather than a finding. Constraints late in a long assignment can disappear even though the new checkpoint labels the retained assignment authoritative.

**Recommended change.** Treat an assistant tool request and all its matching results as one indivisible group. Prune or retain the whole group and validate the final message structure before dispatch. Maintain a compact task-state record containing the current objective, constraints, established findings, artifacts, unresolved questions, completed actions, and next action. Preserve required constraints independently of a simple first-N-characters slice. Keep compaction deterministic where possible; if an optional model summary is introduced, log its inputs, output, and cost, and retain a deterministic fallback. Calibrate the current character-based token estimate against provider usage and allow a safety margin.

**Effort: medium, 3–5 days.** Fix exchange integrity first, then improve checkpoint content. Acceptance should cover multiple tool calls, error results, tool-only responses, long instructions, nested scopes, repeated compactions, and recovery. Add a long-task case whose decisive constraint occurs late in the original assignment. Anthropic's discussion of [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) provides useful support for structured notes and preserving task state; the specific defect above is established by the local probe.

Evidence: [compaction boundary selection](D:/electron/llm-flow/kernel/src/models/capabilities.ts:385), [assignment retention](D:/electron/llm-flow/kernel/src/models/capabilities.ts:377), [checkpoint findings](D:/electron/llm-flow/kernel/src/models/capabilities.ts:400), [token estimate](D:/electron/llm-flow/kernel/src/models/capabilities.ts:231).

**4. Persist and display the effective model request**

**What exists and what is wrong.** Replacing repeated full-history prompt snapshots with a sequence locator was a sensible response to quadratic log growth. However, the locator points to canonical message events, whereas hooks can change the request after those messages were logged. Provider adaptation and context compaction can change it further. Hook records preserve hashes, but hashes cannot reconstruct the altered content. The budget record preserves counts, actions, and sometimes a checkpoint, rather than the complete effective request specification. Trace currently renders the prompt field directly, so a locator can be displayed where the user expects the assembled query.

**Confirmed behavior.** A trusted request hook added `HOOK_ONLY_INSTRUCTION`. The scripted model received it, but replaying the prompt locator did not recover it. The instruction was absent from all session events. This breaks the stated model-visible-means-logged contract precisely when plugin customization is active.

**Recommended change.** Record the effective request at the final adapter boundary, after hooks, candidate selection, compaction, and capability adaptation, but before dispatch. Use content-addressed message and schema artifacts, plus a small ordered manifest, so repeated history is deduplicated. Record effective model/provider, output allowance, reasoning settings, tool choice, structured-output schema, and transformation version for each candidate. Exclude credentials and authentication headers. Trace and the debugger should resolve the same manifest on demand and distinguish the authored request from the dispatched request. This preserves the storage improvement while restoring auditability.

**Effort: medium, 2–4 days.** Most work is one persistence contract, an adapter callback, and a shared reader/UI path. Acceptance should compare captured outgoing request content with reconstructed content for an ordinary call, a mutating hook, compaction, structured-output fallback, and a provider fallback. Reopening after a workflow or plugin edit must show what that run actually used.

Evidence: [hook application and prompt locator](D:/electron/llm-flow/kernel/src/blocks/run.ts:392), [budget records](D:/electron/llm-flow/kernel/src/blocks/run.ts:457), [final adapter request](D:/electron/llm-flow/kernel/src/plugins/llm-adapters.ts:317), [Trace rendering](D:/electron/llm-flow/src/v2/Trace.jsx:167).

**5. Add shared request-level spending and resource admission**

**What exists and what is missing.** Loop has meaningful ledger-based caps, live-spend accounting, burn detection, and bounded generated-worker attempts. Ordinary work blocks intentionally use soft step warnings unless a hard bound is supplied. The shared model path has context budgeting, but I found no shared monetary reservation/admission mechanism before provider calls. The `agent/pre-step` veto hook exists, but the production paths examined do not install a shared spending policy there.

This means Loop supervision and model-request admission solve different problems. Several concurrent children can start costly requests while all appear affordable against the same settled spend. Desktop and CLI workflows also need a consistent resource policy if a user expects one launch to have a meaningful ceiling. This is an architectural exposure; I did not run an overspend experiment or establish a measured amount of overshoot.

**Recommended change.** Give each run a persisted resource policy: token allowance, optional dollar allowance, active-time allowance, concurrency, and output reserve. Before every provider attempt, atomically reserve an estimate for its input and maximum output against the shared parent budget; settle it against actual usage and release the remainder. Include fallback attempts, retries, planning, repair, and summaries. For routes with unknown monetary pricing, use explicit token/request limits and display cost as unknown. On exhaustion, stop admitting tool work and use a reserved answer-only allowance to return a useful partial result. Pauses awaiting human input should have an explicit time-accounting rule.

**Effort: high, 4–7 days.** Budget ownership must span child sessions and host reuse, with sensible recovery of uncertain in-flight charges. Start with request admission and parent/child aggregation; extend provider-specific estimates afterward. Acceptance should launch simultaneous expensive requests against one small budget and show that reservations prevent all of them being admitted. Reopening must preserve spent and reserved amounts. The UI should explain the limiting resource and offer an explicit increase rather than a generic failure.

Evidence: [Loop budget checks](D:/electron/llm-flow/core/supervisor.js:581), [live and rolling budget accounting](D:/electron/llm-flow/core/supervisor.js:815), [shared pre-step boundary](D:/electron/llm-flow/kernel/src/blocks/run.ts:356), [work-block bounds](D:/electron/llm-flow/kernel/src/plugins/blocks-core.ts:203).

**6. Expand verification around real execution paths and task outcomes**

**What exists and what is missing.** The suite is extensive, and CI already covers three operating systems, builds, stack validation, package contents, dependency auditing, and real published plugin compatibility. That is worth preserving. However, the lane-isolation tests exercise a demonstration block that records its input rather than the built-in block's actual model request. They establish one layer's behavior while missing the shared-transcript leak. The current benchmark has three useful coding cases, which is too narrow to evaluate long-running context, recovery, independent review, or provider degradation reliably.

**Recommended change.** Add a compact deterministic contract suite around the canonical runner and the real built-in blocks, with scripted model/provider boundaries. Turn all five review probes into assertions. Then cover nested iteration with interruption, multi-tool compaction, simultaneous approvals, restart after an uncertain tool result, provider fallback after partial output, and parent/child budget exhaustion. Keep assertions focused on observable work, requests, artifacts, and durable state.

Add a small Electron acceptance suite for launch, streaming, project switching during work, answering a recovered approval, stopping, retrying one block, and inspecting the effective prompt. Module integration and server rendering are useful, but do not fully exercise preload, navigation, focus, and reconnect behavior together. Run a fast subset on pull requests and reserve broader platform coverage for release checks.

Expand the task benchmark to roughly 12–20 representative cases. Separate an isolated per-case quality track from the existing shared-repository overnight Loop track, since the latter intentionally measures cumulative effects. Compare changes at the same repository revision, model route, and resource budget, with repeated runs. Report independently verified success, dollars per verified success, latency, intervention rate, and recovery success. A cheaper run that produces an unverified result should not win. Paid evaluations should be an explicitly configured job, not an incidental part of ordinary tests.

**Effort: high, 5–8 days for the first useful slice.** Regression tests for findings 1–4 belong in those fixes and should not wait for this larger investment. Start the broader effort with a handful of real user journeys and representative cases; extend it as incidents reveal new failure classes.

Evidence: [lane test harness](D:/electron/llm-flow/tests/stackWalk.test.js:26), [current CI](D:/electron/llm-flow/.github/workflows/ci.yml:31), [benchmark cases](D:/electron/llm-flow/benchmark/README.md:52), [current theme integration approach](D:/electron/llm-flow/e2e/project-theme.spec.ts:1).

**7. Make projections incremental and apply stream backpressure**

**What exists and what remains costly.** Session handles cache parsed events, live projection code filters irrelevant events, and changed-file materialization avoids rewriting every artifact. Those are real improvements. Remaining paths still scale with the accumulated history: cursor reads filter the whole cached event array; live projection repeatedly folds all retained relevant events; the stored snapshot reader reparses a whole log when its size changes. Projection errors are swallowed, allowing the authoritative run to continue but potentially leaving its visible files stale without an explanation.

There is an existing rebuildable SQLite projection class, but repository searches found its instantiation in tests rather than production composition. Adding another index implementation would not help until the product paths use one. Separately, the HTTP event broadcaster ignores the boolean return from `res.write`. A slow connected client can therefore accumulate buffered frames. Node's [stream documentation](https://nodejs.org/api/stream.html) explicitly describes honoring `false` and waiting for `drain` to manage backpressure.

**Recommended change.** Update live projection state from new events rather than refolding the entire history. Tail stored logs from a verified byte offset and sequence, with full replay retained for repair. Bound cache memory by approximate bytes as well as run count. Connect the existing optional index to history/search queries where it produces a measured benefit; JSONL remains authoritative and hosts without SQLite retain a fallback. Surface projection lag or failure as diagnostic state without converting it into an execution failure.

For SSE, bound each client's queue. Coalesce replaceable progress updates and disconnect a client that falls too far behind, allowing it to resynchronize from the durable snapshot. Preserve canonical events on disk regardless of delivery. This is chiefly a scaling improvement: code inspection identifies the unbounded/repeated work, but I have not measured a desktop latency regression in this review.

**Effort: high, 4–7 days.** The SSE fix alone is small; projection/state consistency accounts for most of the estimate. Acceptance should compare incremental and full replay results, inject projection-write failures, and load-test multiple long sessions alongside a stalled event client. A useful target is bounded client-buffer memory and stable update latency as the log grows from 1,000 to 100,000 events.

Evidence: [cursor reads](D:/electron/llm-flow/kernel/src/session/jsonl.ts:351), [live full fold](D:/electron/llm-flow/kernel/src/plugins/run-projection.ts:110), [stored snapshot reread](D:/electron/llm-flow/core/runProjection.js:126), [existing optional index](D:/electron/llm-flow/kernel/src/session/index.ts:18), [SSE writes](D:/electron/llm-flow/core/server.js:127).

**Suggested delivery order**

Start with execution identities, context isolation, and tool-exchange-safe compaction. These have direct, demonstrated effects on whether the requested work runs correctly. Restore effective-request evidence next so subsequent tuning is diagnosable. Then introduce common request budgets and expand outcome evaluation. Use long-session measurements to determine how much projection work is justified.

I would preserve the single-kernel architecture and file-backed authority. The current evidence supports focused repairs and integration of the existing mechanisms before a framework migration, more routing intelligence, or a broader plugin surface.

**Reproducing the confirmed findings**

The [review probe script](D:/electron/llm-flow/docs/reviews/2026-09-05-review-probes.mjs) prints observations rather than asserting corrected behavior. Run it from the repository after building the kernel:

```powershell
npm run build:kernel
node docs/reviews/2026-09-05-review-probes.mjs
```

It uses no credentials and makes no model network calls. It leaves small evidence directories under the operating system's temporary directory. Expected observations for the reviewed working tree are:

| Probe | Observed result |
|---|---|
| Repeat three times | `actualExecutions: 1`, `status: done` |
| Parallel model history | `rightSawLeftResult: true`; both lane system prompts present |
| Compaction | Two orphan tool results; no retained assistant tool request |
| For each stop/resume | Only `alpha` executed; resumed run reports `done` |
| Effective request replay | Hook instruction dispatched, absent from replay and all session events |

