# Loop / Goal mode: review and proposed direction

Date: 2026-09-05. Status: design proposal for discussion; no feature implementation.

Reviewed the current working tree, including its existing uncommitted changes. Findings below describe that snapshot, not necessarily the last committed release. This review adds only this document and a diagnostic probe script.

## Recommendation

Build a new Goal mode on the existing workflow engine. Reuse the block editor, stack language, execution controller, session logs, context isolation, and applicable supervision components. Do not make the old backlog Supervisor the general goal runtime, and do not build another block execution engine.

The old Loop solves a different problem: continuously claim repository tasks, work in Git worktrees, verify changes, and land them. Goal mode should execute an authored, revisable process against a persistent objective, preserve learning between iterations, and return its best verified result.

Keep the old backlog capability available during migration, under an explicit name such as Backlog automation. Once usage and compatibility requirements are understood, it can become a specialized Goal template or be retired. Existing tasks, logs, and worktrees must remain inspectable.

Confirmed preferences from this discussion:

- The loop may redesign its own steps while running.
- Folder focus and strict folder isolation should both be available options.
- Loops should be designed with the same building concepts as blocks and workflows.
- Setup steps can run once, with scope inherited by the following steps.
- Remember previous work without accumulating a giant model context.

## What exists today

| Area | Observed implementation | Reuse decision |
|---|---|---|
| Old Loop supervision | `core/supervisor.js` claims backlog tasks, chooses effort/model, provisions worktrees, starts a configured stack, handles failures, budgets, verification, and landing. Default worker is one work block. | Reuse accounting/recovery ideas and repository-specific operations; keep scheduling and landing assumptions out of general Goal mode. |
| Actual production execution | Supervisor calls `stack:run`; `core/api.js`, `core/runController.js`, and `core/kernelHost.js` lead to the canonical kernel runner. | Keep this execution route for every iteration and nested candidate run. |
| Workflow control flow | `kernel/src/stack/types.ts` and `plugins/stack-runner.ts` implement Sequence, Parallel, Repeat, For each, If, and Until. Repeat carries the previous final output forward. Until tests structured outputs after each pass. | Reuse; basic repetition does not need rebuilding. Goal lifetime and evolving definitions need an additional durable orchestration layer. |
| Authoring | `src/v2/BlockEditor.jsx` supports those containers; `stack-commands.ts` provides shared edit commands. Until currently uses a JSON condition editor. | Extend the existing editor and command validation with a Goal wrapper and understandable forms. |
| Context | Each block invocation gets explicit input and its own transcript boundary, including iteration identity. A sequence passes its predecessor's output, rather than all earlier transcripts. | Strong foundation. Add bounded goal state explicitly; preserve transcript isolation. |
| Retry memory | `core/brief.js` produces deterministic evidence notes and replaces a managed section, retaining three attempts. Supervisor includes prior failure and worktree recovery notes. | Reuse the bounded, evidence-based approach. This is task-repair memory, not yet goal-wide experiment memory. |
| Recovery and history | Canonical JSONL sessions, execution IDs, completed-block replay, interrupted-tool evidence, stop/pause/resume, worktree ownership, and spend recovery. | Preserve, with revision pinning and durable iteration transitions added. |
| Filesystem/execution | Host has a fixed workspace, filesystem seam, execution-world provider, and sandbox policy. Host pooling includes workspace and authority. | Reuse for scope plumbing. Current process confinement restricts writes; it does not implement strict read secrecy. |
| Old UI | `src/loop/LoopPage.jsx` is a task board, models panel, logs, and backlog chat. No import of LoopPage was found in the current `src` tree; CLI/API/IPC Loop routes remain. | Build the Goal experience in the current shell. Reuse individual status views where appropriate, not the board as the authoring surface. UI reachability was source-inspected, not browser-tested. |

## Confirmed gaps and defects

### 1. The canonical Loop handoff does not enqueue work

`kernel/src/plugins/blocks-loop.ts:47` defines `loop-handoff` as an AI text step with an empty tool ceiling. It does not call a queue operation or supervisor. `blocks-aistep.ts` turns its text into a list of lines. It can therefore report completion while merely saying work was queued.

The old implementation in `core/nodes/loopNode.js` has actual enqueue, persisted task IDs, wait policies, and reporting, but its execution integration is in the historical `core/stackRunner.js`. `core/stackstore.js:19` maps migrated legacy Loop nodes to the canonical handoff, so this is a migration behavior gap as well as a missing building block.

Diagnostic probe confirmed: the handoff returns done with “Queued task A”, no available tools, and no queue operation. Repair it with a deterministic enqueue operation if retaining the feature; otherwise make the unsupported behavior explicit. Do not base Goal mode on it.

### 2. Evaluation is prose, while Until comparisons are exact

`blocks-judgement.ts` declares a string `verdict`; the entire answer becomes that field. `stack-runner.ts` compares `is` with strict equality. A reasonable answer such as “pass — all checks succeeded” does not equal `pass`.

Diagnostic probe confirmed: that answer exhausts an Until with two passes and returns failure. Numeric scores and typed success flags need runtime validation, rather than declarations alone. Goal decisions should consume a validated result object; the explanation must be a separate field.

### 3. Resume does not pin the saved workflow definition

`stack-runner.ts:210` records `stack.resolved`, but resume at line 285 resolves the current stack by ID. `core/kernelHost.js:311` loads the current file and applies current configuration. The recorded tree is not the source used by this resume path.

Diagnostic probe confirmed: stop after step one, replace step two in the definition, resume, and the replacement runs even though the saved snapshot names the old step. Self-redesign requires explicit immutable revisions and activation boundaries before it is safe to rely on recovery.

### 4. Transcript isolation does not ensure bounded useful memory

The next iteration gets the preceding final output. That avoids automatic transcript accumulation but can lose the original objective, forget an earlier failed approach, or grow if each output copies earlier outputs. There is no goal-owned current/best candidate record or verified learning store in this route. Merely telling a model “you are in a loop” supplies no evidence of prior work.

### 5. The existing sandbox cannot support an “only see this folder” claim

The active execution-world implementation is newer than portions of `docs/execution-world-sandbox.md`; this finding comes from code. Linux's local wrapper mounts `/` read-only, macOS denies out-of-scope writes, and Windows reports partial enforcement. Those are useful file-effect boundaries, not a restricted view of host files.

A folder working directory, a Git worktree, and a narrower tool ceiling do not stop a permitted shell from reading outside files. References, other-run readers, agent tools, and nested executions also need explicit scope checks. Strict mode requires a provider with a restricted filesystem view, or refusal when that cannot be enforced. Backend/platform selection remains an implementation decision requiring a dedicated spike.

### 6. General goal outcomes and child workflow execution are missing

The existing Until treats pass exhaustion as run failure. Optimization also needs honest outcomes such as limit reached with a useful best candidate, plateau, needs input, or stopped. Those outcomes must never imply that the goal was achieved.

There is generated-task child-session infrastructure in `blocks-task-graph.ts`, but I found no first-class block that runs an arbitrary versioned candidate workflow with a durable parent link, inherited policy, aggregated budget, and structured result. The public execution route exists; the nested operation contract is the missing part.

## Proposed product model

A Goal has four parts:

1. **Goal contract:** objective, fixed requirements, evaluation criteria, folder policy, total limits, and permissions for self-redesign.
2. **Setup:** ordinary deterministic/AI steps that execute once per goal instance, e.g. create a folder, import inputs, establish a baseline. Completed setup survives pause and resume.
3. **Iteration recipe:** an ordinary workflow made from the existing blocks and containers. The user and the loop can edit versioned copies of it.
4. **State and history:** current candidate, best verified candidate, results, learning, next action, and links to detailed artifacts and runs.

The Goal is a saved authorable definition; starting it creates a goal instance. Resuming continues that instance. Starting again creates a new one and runs its own setup. Continuing with a revised objective creates a new contract version and invalidates or explicitly rechecks incompatible evaluations.

The UI should show Setup once and Each iteration as separate areas of the same editor, with Goal settings above them. Existing Sequence/Parallel/If/Repeat remain available inside the recipe. A Workspace group can apply a selected folder to its descendants. Scope should be visible where it is inherited.

At runtime, show current iteration and recipe version, current step, best result, progress against criteria, spend/time remaining, the last learning, and why it continued or stopped. Provide Pause, Stop, Resume, Inspect memory, Compare iterations, View recipe changes, and Restore version. Human edits during a run create a pending revision, just like model edits.

## Example: improve a workflow for large tasks

```text
Goal: improve measured large-task performance within the selected limits

Setup once
  Create experiment folder
  Import starting workflow and representative tasks
  Record rubric, baseline, and evaluation configuration

Each iteration, within the experiment scope
  Build / improve candidate workflow
  Validate candidate
  Run candidate against evaluation tasks
  Evaluate evidence and compare with best
  Propose changes to the loop recipe when useful

Goal runtime, after the authored recipe
  Validate evaluation and proposed recipe revision
  Commit results, memory, and best-candidate selection
  Continue with the selected recipe revision, or stop with an explicit reason
```

“Optimal” needs an operational definition. Proposed starting point: maximize task acceptance rate while satisfying hard correctness requirements, then compare cost and duration among candidates meeting the quality target. Exact measures, weights, thresholds, and representative tasks should be chosen when creating the goal, not invented by the running optimizer.

Keep the benchmark/rubric independent of candidate edits. Record model configuration, task set version, recipe revision, candidate revision, cost, latency, and evidence with each result. Re-run promising candidates where model variability could reverse the ranking; use held-out tasks to assess generalization. A single model's positive review is insufficient evidence of optimality.

Keep **current** and **best** separate. A new attempt may regress. Return the best verified artifact when a limit is reached, with its verification status and stop reason. Publishing that artifact into the workflow library is a distinct explicit operation, not a side effect of trying it.

## Memory without a growing prompt

Use a small runtime-assembled context packet rather than a transcript summary alone:

- Goal and fixed constraints, included independently of the previous step's text.
- Iteration number, active recipe revision, effective folder scope, remaining limits.
- Current candidate and best candidate references, with recorded metrics.
- Last iteration: change attempted, observed result, failure reason if any, and recommended next action.
- A bounded set of relevant findings: what worked, what failed, and unresolved hypotheses.
- A short artifact index for retrieving details when needed.

Every AI step can know it belongs to a Goal, while receiving only the memory relevant to its role. The builder needs past attempts and improvement priorities; the runner needs candidate/input references; the evaluator needs the contract and evidence. Each also receives its own predecessor's explicit artifact input.

Keep three separate storage layers:

| Layer | Content | Model context behavior |
|---|---|---|
| Current state | Typed metrics, IDs, revisions, best candidate, counters, remaining limits | Small authoritative fields included when relevant; never inferred from a summary. |
| Working memory | Short findings with source iteration/artifact, status, and optional supersedes link | Bounded, deduplicated, selected for this step. Suggested starting budget: 2,000 tokens excluding the fixed brief and immediate artifact input. |
| Full record | Immutable iteration records, recipe/candidate versions, raw outputs, tool evidence, detailed evaluation | Retained on disk; retrieved by ID/query with result and token bounds. Not appended automatically. |

Generate factual fields deterministically from events and metrics. A model can propose lessons and a short summary; validate and merge them while retaining provenance and uncertainty. Do not repeatedly summarize a summary as the only memory source. Important constraints and best-result references are pinned outside summary eviction. If summarization fails, retain the last valid memory and a deterministic result record; do not fabricate new learning.

Use indexed projections for history retrieval so long runs do not require reparsing all logs for every step. Bound retrieved text and immediate artifact input as well as working memory: bounded summaries alone do not bound the whole request. If required input cannot fit, chunk it explicitly or stop with an actionable error.

## Self-redesign

Self-redesign should be a supported capability of the first complete version, with fixed recipes also available as an option.

- The loop may propose adding, removing, reordering, or configuring recipe steps, including introducing a critic or splitting a large build step into several stages.
- Edits target a draft recipe revision through the same command/validation system as the editor. The running iteration uses an immutable snapshot.
- Proposals name their base revision, rationale, expected benefit, and changed steps. Stale revisions cannot overwrite newer human or model edits silently.
- Validate grammar, installed block references, output bindings, allowed capabilities, recursive execution bounds, and inherited limits before activation.
- Activate at the next iteration boundary. Persist the activation decision so a crash cannot choose a different recipe on resume.
- Track artifact changes separately from recipe changes. Otherwise an improvement cannot be attributed to the workflow being tested versus the process that built it.
- Record the result of each recipe trial. Keep the previous usable revision and allow rollback. Validating a recipe proves it can run, not that it improves outcomes.

The loop cannot rewrite its own success criteria, remove mandatory evaluation/accounting, increase its total budget, widen scope, or erase evidence. Those are runtime-enforced parts of the user's contract, outside the editable recipe. Changes requested by the user can create a recorded contract revision. Automatic recipe changes within the already authorized policy do not need an approval prompt every iteration.

An authored evaluation step can provide analysis, but the runtime must still validate evidence and enforce stopping/accounting if the recipe omits or replaces that step. A self-editable recipe must not be able to remove the machinery that judges and bounds it.

## Folder options

| Option | Intended behavior | Enforcement |
|---|---|---|
| Folder focus | Start in the selected folder; show it as the working scope; prioritize its content. Broader access remains governed by the chosen tools and permissions. | UI/context/default paths; clearly described as focus. |
| Strict folder isolation | Model-visible project data and execution see only the chosen folder plus explicitly declared runtime dependencies and imported inputs. | Scoped file tools and restricted process filesystem view; descendants and nested workflows inherit the boundary. |

“Strict” means no unrelated host/project data, not literally an empty OS with no executable or library files. Provider/model transport and host bookkeeping remain outside the model's data view. Network and external connectors need separate explicit settings; strict folder isolation alone must not be presented as disabling the network.

A Create folder setup block should return a typed workspace reference, not just text that later steps reinterpret as a trusted path. Creating that folder is scoped to the chosen parent. Subsequent steps bind to that reference; narrowing is allowed, widening requires a user contract change. Resume checks that the folder identity still matches. Completed setup is not rerun; interrupted setup verifies its intended effect before retrying.

The current host binds one root at composition, so a narrower Workspace group should acquire a correctly scoped execution context/host through the existing controller. Do not change a shared host's filesystem root midway through a run. History and reference tools must apply the same scope, and internal goal metadata must be exposed only through controlled views. Candidate executions should use clean per-test working copies to prevent prior test output contaminating comparisons.

Strict isolation is a separate provider capability to implement and prove. If unavailable on a machine, offer Folder focus explicitly or refuse strict launch; never silently downgrade.

## Runtime design and recovery

Add a thin durable Goal controller above RunController. It owns the goal lifecycle and dispatches each iteration as a version-pinned ordinary workflow run. RunController and the kernel remain responsible for block scheduling, tools, context, cancellation, and run logs. This avoids modifying an in-flight Until tree to implement self-redesign.

Suggested identities: goal instance ID, iteration ID, recipe revision, candidate revision, evaluation configuration revision, child run ID, and block execution ID. A candidate workflow invocation goes through the same RunController with explicit parent ownership, input/output bindings, scope, cancellation, and accounting.

Persist transition intent before launching a child; use a stable child identity to reattach after a crash. Commit iteration results, memory changes, best selection, and next revision through a replayable transition. Never count a retried commit as a second iteration. A completed setup/result must not repeat side effects merely because its owner restarted. Interrupted effects need verification or explicit repair; do not claim general exactly-once tool execution.

Goal spend includes every iteration, evaluator, summary call, recipe redesign, retry, and nested candidate run without double counting. Reuse ledger accounting, extending attribution to the parent goal. Apply limits during active work, not only between iterations. Unknown cost remains unknown; use explicit token/time/call limits where dollar enforcement cannot be guaranteed. Nested work shares the remaining parent budget rather than receiving a fresh copy of it.

Keep outcomes distinct: achieved, limit reached, plateau, needs input, failed, and stopped. Paused is resumable and not a terminal result. Infrastructure retries stay within a separate bounded retry policy and do not count as evidence that a candidate is poor. Semantic evaluation failures do count as experiment results.

Suggested defaults for discussion: finite iteration/time/spend limits, one iteration at a time, bounded parallelism inside candidate workflows, plateau after three comparable evaluations without meaningful improvement, automatic validated recipe activation at iteration boundaries, and best-artifact export when stopping. These are proposed defaults, not decisions already made by the user.

## Implementation sequence

1. **Repair and establish the foundation.** Pin run definitions on resume; introduce validated evaluation fields; define deterministic nested workflow execution, goal/child identities, and inherited accounting. Decide whether to repair or visibly deprecate the misleading Loop handoff.
2. **Implement durable Goal execution.** Goal contract, setup once, iteration records, bounded memory, best-result tracking, explicit stop reasons, and controller dispatch through the existing execution engine. Start with a fixed recipe to validate these mechanics internally.
3. **Add self-redesign before considering the requested feature complete.** Draft revisions, validation, automatic activation at boundaries, traceable recipe changes, protected contract, and rollback.
4. **Deliver authoring and runtime UX.** Extend Build with Goal settings, Setup/Each iteration, scope groups, recipe editing, memory inspection, and progress comparison. Ship the workflow-optimization example as an editable template.
5. **Deliver and verify strict isolation.** Reuse scope contracts from the preceding phases, implement an appropriate provider, and prove file/shell/descendant/child-run boundaries on supported platforms. Folder focus can be available earlier with accurate labeling; it does not satisfy strict isolation.
6. **Migrate the old product deliberately.** Keep old records readable and backlog automation callable while migrating useful capabilities. Remove unused Loop UI and historical execution scaffolding only after reachability and compatibility checks. Do not convert old backlog tasks into optimization goals implicitly.

Strict-provider work can be investigated early because it affects platform support. Do not tie general goal execution to Git, mandatory code changes, or automatic merge/review; those belong in optional repository templates.

## Acceptance cases for the future implementation

- Setup creates one workspace; pause/resume does not create another or rerun completed setup.
- Build → Run candidate → Evaluate repeats and improves against fixed evidence, with a preserved best artifact.
- Fifty iterations retain bounded model inputs and recover a relevant earlier failure through bounded history retrieval.
- The original goal/constraints remain visible after multiple iterations even if intermediate prose omits them.
- Evaluation produces a validated verdict and metrics; malformed output cannot accidentally satisfy the goal.
- A self-proposed recipe revision becomes active exactly at its recorded boundary; restart uses the same version.
- Human and model edits from the same base revision cannot silently overwrite one another.
- A failed recipe trial can restore the prior recipe without losing its evidence or the best candidate.
- Removing an authored evaluator cannot bypass the runtime's mandatory evaluation and limits.
- Child runs inherit scope, cancellation, and shared remaining budget; resume reattaches without duplicate runs or charges.
- Strict mode denies outside reads/writes through file tools, shell, descendants, symlinks/junctions, history/reference tools, and nested runs. Unavailable enforcement refuses launch.
- Limit reached returns the best verified artifact and an honest unachieved goal status.

## Verification performed

- `npm run build:kernel` passed.
- 262 existing targeted tests passed, with zero failures/skips: Loop kernel parity, legacy Loop node behavior, Supervisor, brief memory, workflow context, stack walk/resume/stop, and Loop board/live/log/view tests.
- Test environment used mock providers and `FLYT_SANDBOX_MODE=danger-full-access`. The parity suite exercised a temporary repository through claim, kernel execution, gates, review, merge, and canary. These tests do not establish strict sandbox isolation or real-model optimization quality.
- `node docs/reviews/2026-09-05-loop-review-probes.mjs` confirmed the three handoff/evaluation/resume cases above using fake models and temporary session logs. The probe asserts current problematic behavior so the findings can be reproduced; it is not the future acceptance suite.
- No full app build, browser UI exercise, real provider calls, or platform isolation tests were performed for this design review.
