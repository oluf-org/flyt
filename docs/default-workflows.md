# Shipping workflows

Flyt recommends six workflows. **Make a change** is selected when there is no valid saved choice. Earlier workflows remain available under **Earlier workflows** in Build; upgrades seed missing new files without overwriting existing workflow files or saved selections.

| Workflow | Behavior | Default resource bounds |
| --- | --- | --- |
| Make a change | One worker implements; the runtime checks the actual result and runs an independent source review. | 120 provider attempts, 30 elapsed minutes, up to 2 repairs |
| Fix a bug | Requires a recorded failing command before the repair, then reruns the observed reproducer and required checks and independently reviews the result. | 120 attempts, 30 minutes, up to 2 repairs |
| Review a change | Pins a local Git base (HEAD by default), captures the comparison, and reviews with readers only. Findings are a valid completed review. | 40 attempts, 15 minutes |
| Research a question | One investigator answers from project files, opened web sources, or supplied material. Project evidence is the default mode. | 40 attempts, 15 minutes |
| Plan an idea | Inspects context and asks consequential questions, then independently reviews the specification's interfaces, examples and failure ordering. Open blocking decisions produce a draft. No queue writes. | 40 attempts, 20 minutes, up to 2 consistency repairs |
| Deliver a complex task | Grounds an ordered milestone plan, implements and accepts each milestone serially, and checks the integrated result. One structural replan may replace unfinished work. | 400 attempts, 120 minutes, up to 2 repairs per milestone |

These bounds are configurable. Elapsed time includes time paused or waiting for a response and survives resume. A configured dollar limit stops new calls at settled cost; one in-flight call can exceed it. Unknown call pricing stops further calls when a dollar limit is configured. Without a dollar limit, unknown costs remain recorded as unknown and the call/time limits still apply.

Limits are fixed when execution begins. Retry preserves the original allowance; it does not replenish spent calls or extend the deadline. Exhaustion returns an incomplete result with saved progress. Extending an existing run's resource allowance requires a future explicit budget-update operation; a new execution can use different limits.

## Execution and evidence

The bundled `flyt-blocks-delivery` plugin uses the canonical worker and session log. It emits durable stages below its authored block. It does not start a second execution engine, create backlog tasks, merge changes, or publish results. Ordinary run permission and execution-world settings remain authoritative.

Make a change, Fix a bug and each delivery milestone use the same cycle:

1. Capture the initial workspace and freeze declared project gates plus configured additional gates.
2. Run one worker with the original request and current milestone acceptance. The worker may investigate and plan in its own context; focused work does not pay for a separate refiner or task-graph planner.
3. Check the reported effect against the actual workspace comparison. A reported implementation without a change fails. An already-satisfied result is allowed only without changes and still needs independent acceptance evidence.
4. Execute frozen gates and any worker-proposed additional checks through the normal tool boundary. Inspect actual exit status; a successful tool transport is not a successful command. Missing or uncertain results do not pass.
5. Independently review the original request, actual before/after content, current source and recorded checks. Passed criteria require exact source references; the runtime checks file, line and quotation. All changed files need review coverage. A citation/coverage error gets one reader-only correction, without repeating implementation. Invalid evidence cannot pass.
6. Repair specific unresolved findings, up to the configured bound. Every repaired version is checked again. Failed commands cannot be overridden by a favorable model review.

Workspace changes during verification or review invalidate that evidence. A completed milestone records its accepted content digest, report and checks. Resume retains the workflow's own invocation cursor, completed stages, accepted milestones and resource accounting. Interrupted workers use the last durable tool-effect digest, so their own recorded edits can resume without accepting unrelated edits made after interruption. Unexpected drift fails before another worker call. An interrupted verification command without a durable result requires inspection before another execution. Older interrupted sessions without an observed digest may require a fresh execution after inspecting their retained edits.

Generated workflow stages honor Pause at stage and verification-command boundaries. The current stage may contain several model/tool rounds and finishes before the pause takes effect; a standalone verification command also finishes before its next boundary. Continuing checks that project content still matches the saved checkpoint. Pause and Retry do not reset the original elapsed-time or provider-call budgets; an exhausted run requires a fresh execution after inspecting its retained work.

Complex delivery inspects before planning. One coherent task becomes one milestone executed against the full original request. Its unchanged accepted result needs no duplicate integration review. Multiple milestones serialize writing and require a separate final check of the combined result against the original request. Final checks rerun the union of frozen gates and commands accepted by earlier milestones. A successful collection of local reviews cannot override failed integration acceptance. If delivery stops, its output retains completed milestones and identifies why the remainder is incomplete.

The integration reviewer receives both final command receipts and the recorded checks for accepted milestone versions. Historical receipts remain attached to their original source digest; they cannot replace a required check of the current integrated version.

## Read-only workflows

Review a change uses a host-produced local Git comparison with a pinned commit, disabled external diff/textconv, and bounded output. It checks that the workspace did not change during capture or review. Empty comparisons, unavailable bases, invalid citations and missing coverage are explicit failures. Existing modified and untracked files are included in the requested comparison; no fixes are applied.

Research mode narrows the existing research ceiling: project readers, supplied-input-only, or readers plus web tools. Modes cannot grant tools beyond the block and run ceilings. Each cited excerpt must occur in the original input or an observed opened source. One focused evidence correction may replace invalid source indexes using the already opened excerpts; valid sources are retained, and an unchanged answer need not be reconstructed. The result retains validated sources and distinguishes source findings, inference and unavailable evidence. It does not automatically plan or queue implementation.

Plan an idea has readers and `ask_human`, without writers, shell or backlog tools. Its output identifies goal, non-goals, behavior, constraints, acceptance, milestones, assumptions and open decisions. A separate reader checks examples against interfaces and traces failure/recovery ordering, using the original request and actual stakeholder answers. Concrete inconsistencies receive bounded repairs and a new review. Unresolved blocking decisions retain draft status; exhausted consistency repairs fail with the draft and remaining issues visible. A consistency-reviewed specification is still unimplemented and untested.

Small-feature specifications aim for concise contracts and examples, avoiding duplicate definitions and unnecessary implementation algorithms. Review criteria use stable short IDs which the runtime resolves to the frozen requirement text. Malformed review bookkeeping can be retried independently without redoing accepted implementation. Research corrections use an explicit answer-replacement flag, so an omitted or placeholder replacement cannot erase a useful answer.

Format-only correction defaults to an 8,192-token output allowance (unless explicitly configured otherwise) and a two-minute call window within the original workflow budget. It requires structured submission and preserves failure if the provider does not comply. OpenRouter requests that force a submission tool or require native JSON Schema also require endpoint parameter support; the runtime still validates the actual returned object.

## Platform compatibility

Windows, Linux and macOS are intended targets. Shell guidance uses the host platform, and the headed GUI harness resolves Electron and application settings through platform paths (with an explicit `--settings` override). Linux verification uses `python3` where Windows uses `python`; each scenario's exact command is frozen before launch.

Filesystem confinement availability and Node piped-child support are probed separately. On the tested Windows restricted-token backend, ordinary confined commands can run, but Node/npm commands requiring piped children fail with `spawn EPERM`. A filesystem probe success does not certify those test runners. Workers receive the observed limitation; an actual failed command matching the failed probe ends verification instead of spending implementation repairs on the same infrastructure failure. No alternate command is credited as the requested command, and no sandbox permission is expanded automatically.

Windows executable discovery accepts App Execution Aliases and quoted executable paths, leaving the actual confined command receipt authoritative. Unix discovery requires an executable regular file.

The Windows Node subprocess limitation remains a release blocker. With `FLYT_RELEASE_SANDBOX_E2E=1`, platform tests require the unchanged npm/Node runner to pass; merely detecting its failure cannot produce a green release prerequisite. The Electron probe test uses the installed platform executable on all three operating systems. Native Linux and macOS validation is also required: the current Windows machine's WSL1 distributions do not establish Bubblewrap support, and no macOS host was available. Passing Python fixtures on Windows does not establish Node compatibility or native support on another OS.

Optional model recaps cannot override the authoritative workflow outcome. Their failure appears as a compact expandable notice; validated structured completions and corrections remain available in the stage output.

A passing review with any false criterion is contradictory, even if its summary describes success. It receives one reader-only correction, which can either establish acceptance from evidence or retain a repair/blocked verdict. Repeated contradictions fail; the runtime never flips the booleans or repeats implementation to satisfy inconsistent review bookkeeping. Retry can discard older cached contradictory reviews while retaining worker output and the original budget.

Task baselines include pre-existing user files and Git changes. A worker must distinguish them from effects of this execution. If its completion status or file list conflicts with the host snapshot, one visible reader-only stage can correct that report; independent command checks and review are still required. No cosmetic write is necessary to verify already-satisfied work. Source drift during correction invalidates the result and remains rejected on Retry.

If only formatting fails, Retry reuses the unvalidated completed stage result instead of repeating work or inspection. Older runs can recover that candidate from the canonical log only when the worker answered and entered format correction. It remains unaccepted until schema and workflow evidence checks pass; retries preserve the original deadline and call ledger.

Milestone review schemas constrain criterion labels to the supplied short IDs, exact legacy labels, or explicitly marked additional requirements. Label errors can therefore be corrected in the no-tools format step. An exact source quotation at the wrong line can be relocated only when it matches exactly one line location in the named current file; the original and verified line numbers are recorded in `workflow.citation-correction`. Missing or ambiguous quotations still require correction and cannot pass unchanged.

Specification consistency reviews default to an 8,192-token response ceiling and low effort, while preserving explicit user configuration. They check required interfaces, examples and failure ordering in one focused pass. The overall planning deadline and repair allowance remain unchanged.

Resume and Retry refresh the terminal recap. Previous recaps remain in conversation history and are marked superseded after execution resumes; Work never presents an earlier failed attempt's recap as the current result.

## Current limits

- Semantic completeness is independently reviewed by a model; source validation and command execution do not prove every possible behavior. A passing workflow is scoped to its evidence and acceptance criteria.
- Bug verification currently requires native command-based failure evidence followed by a workspace change. Browser/manual-only reproduction needs a typed evidence integration; an unsupported reproduction is incomplete, not a verified fix.
- Versioned workspace evidence uses bounded file inventory and text capture. Partial snapshots fail verified workspace workflows. Binary/artifact-specific semantic verification and file-mode-only changes need dedicated evidence adapters.
- No automatic parallel writing workers are created. Specialist readers or isolated writing domains can be added through explicit custom compositions when justified.
- The workflow reports missing verification capabilities rather than silently skipping checks. Source-only changes with no declared/proposed executable checks can be accepted through independent content review; the result states that no executable check ran.
- Third-party tools are not automatically injected into default ceilings. Plugin integration points and proposed evidence adapters are tracked in [`workflow-plugin-opportunities.md`](./workflow-plugin-opportunities.md).

## Validation

`npm run verify:defaults` runs deterministic production-host fixtures covering effects, review, checks, reproduction, milestone integration, recovery, budgets, and gallery defaults. Evidence records are shared by content version across stages to avoid storing duplicate workspace copies. `npm run stack -- lint` checks every bundled stack. Windows platform tests also exercise the actual confined shell, including nested quotes and command exit codes.

`npm test` limits test-file concurrency to four to avoid oversubscribing machines with many reported CPUs, especially while Electron is running. The assertions and test inventory are unchanged. The campaign fixture waits for its declared three-minute campaign allowance plus cleanup rather than timing out after one minute.

`npm run evaluate:defaults` lists 30 fixed smoke cases without calling a model. Explicit `--live` runs can compare the defaults with direct workers and earlier workflows on the same model route. See [the evaluation guide](../benchmark/default-workflows/README.md). Scripted providers establish lifecycle guarantees; small live fixtures do not establish production success rates or prove performance on substantial tasks.

The [supervised desktop acceptance report](./reviews/2026-09-13-default-workflows-gui.md)
tracks three realistic GUI scenarios per default, including independent output
checks and preserved failures. It records a Windows confined subprocess limitation
and distinguishes supervisor-stopped approval requests from natural failures.
This evidence must be reviewed before treating the defaults as release-ready.
The [portability and recovery follow-up](./reviews/2026-09-13-default-workflows-portability.md)
records later fixes, accepted reruns, preserved false successes, and the remaining
Windows Node runner and native Linux/macOS validation limits.
