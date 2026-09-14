# Review: turning Goal loops into sustained optimization

Reviewed 12 September 2026 against the current working tree, including the preceding Plan & dispatch changes. This document records a code review and a proposed design; it does not implement the design or start a new paid run.

## Assessment

The Goal runtime has substantially stronger execution controls than search logic. It can repeat a process, account for calls, retain evidence and recover interrupted work. Its default optimization pattern is one candidate at a time, ranked against the best previous candidate. Raising the iteration limit to 200 would lengthen this pattern without ensuring useful exploration.

The preceding experiment was deliberately configured with three iterations, one prompt-writing step and no project tools. That was an execution and optimization probe, not a demonstration of autonomous block redesign. The controller permits 1,000 iterations, 10,000 model calls and 1,440 active minutes. There is also a deterministic 50-iteration memory/history test. These establish capacity and lifecycle behavior, not the quality of a long search.

## What is worth preserving

- Canonical execution through the existing workflow engine; immutable candidate/evaluation records; stable child identities and reuse of completed work.
- Call accounting before provider dispatch, including parallel descendants; known cost and unpriced calls recorded separately; pause, stop and recovery retain usage.
- Fixed contracts, benchmark versions, mandatory checks, independent test context, development/held-out separation, and independently configurable judge models.
- Multiple task cases and repetitions already exist: up to 30 cases, with up to 20 repetitions per case. Optional reference comparisons include reversed presentation order.
- Model findings are labeled hypotheses, and full history remains available beyond the bounded working memory.

These are useful foundations for sustained optimization. They should remain the execution layer rather than be replaced with an unrelated runner.

## Critical findings

### 1. The controller does not own an exploration strategy

`core/goalController.js:753` generates one candidate, evaluates it, updates current/best and repeats. A sophisticated recipe can do more internally, but the controller has no first-class population, strategy families, candidate ancestry, mutation types, novelty checks or allocation of trials among competing candidates. Recipe self-redesign exists, but it does not supply those missing search policies.

The GLM run showed the consequence: iteration 3 mostly paraphrased iteration 2. Two hundred such iterations could repeat the same idea without learning much. Exact candidate digests identify measurements, but there is no campaign-wide duplicate-candidate screening before evaluation.

### 2. Completion and improvement are different, but the default policy does not require both

`core/evaluation.js:155` treats an eligible candidate as having met the target when no explicit threshold is present. The controller can therefore finish at the first fully passing candidate. The configured iteration count is a ceiling, not a promise to search that far.

The baseline is measured separately at `core/goalController.js:749`. Ordinary winner selection at line 831 compares against `state.best`, which initially has no candidate, rather than requiring a gain against that baseline. Explicit reference evaluators can impose stronger requirements, but generic optimization does not automatically do so.

Add separate completion policies: satisfy acceptance criteria, optimize within a budget, and stop after a verified improvement. Optimization should retain the baseline as a valid incumbent and permit “no improvement found” as the correct outcome. Exploration should have a minimum allocation before a plateau can end the campaign.

### 3. The optimizer loses important evidence

`core/goalController.js:610` reduces development feedback to non-passing checks and short explanations. Successful repairs disappear from that per-case view; passing rubric deductions also lose their detailed rationale. The preceding baseline therefore appeared as pass with an empty check list despite requiring repairs on every trial. A specific diagnosis supplied by the outer agent drove the useful change.

Working memory keeps the last ten distinct model findings (`core/goalController.js:838`). Full history can be retrieved, but the default context is not an experiment notebook indexed by failure, strategy and tested claim.

Carry original diagnostics, repair differences, measured costs, per-case weaknesses and evidence-backed lessons forward even when the final gate passes. Retain unresolved questions, refuted hypotheses and coverage of the search space. Keep details retrievable rather than putting all 200 experiments into a prompt.

### 4. More repetitions currently cost more without a stronger selection rule

`core/evaluation.js:113` runs all configured case/repeat combinations sequentially. There is no staged screening, adaptive replication or randomized interleaving of baseline and candidate trials. Goal parallelism bounds authored parallel blocks; it does not turn this evaluation loop into a concurrent trial queue.

`kernel/src/evaluation/registry.ts:247` compares aggregate point values lexicographically. It does not use measurement uncertainty; the minimum-improvement tolerance applies only to the primary metric, not tie-breakers. Repeated evaluations exist, but those repetitions do not automatically make a marginal winner credible.

Use cheap gates first, a small screening suite next, and additional cases/repetitions for survivors. Compare leaders and baseline on matched, interleaved trials. Preserve raw samples and task-family results so a good mean cannot conceal a serious regression. Reserve enough budget to confirm the selected result.

### 5. Full-workflow runtime metrics are not connected to ranking

For `target: workflow`, `core/evaluation.js:125` executes the candidate and forwards its output into an artifact evaluation. It does not forward a runtime-owned observation of that candidate execution. The evaluator deliberately discards caller-supplied runtime data (`kernel/src/plugins/blocks-evaluation.ts:32`), and artifact evaluation has no internal candidate run from which to derive those metrics. Its runtime metrics consequently remain unavailable rather than measuring the workflow that produced the output.

This is a concrete gap for performance optimization. Bind canonical workflow run evidence to the evaluator through a trusted runtime path. Record planning time, ready-to-start delays, active workers, full completion latency, calls, tokens and cost independently of judging time. A 200-candidate campaign needs these measurements inside its scoring, not only in a separate analysis script.

### 6. Evaluation failures and semantic gaps become more consequential at scale

The prior run had invalid judge-citation errors in four development evaluations. The judge repair loop in `kernel/src/plugins/blocks-evaluation.ts:123` repairs JSON parsing; evidence and citation validation happens afterward in `kernel/src/evaluation/registry.ts:198`. A citation-invalid but parseable answer does not receive the same repair treatment.

The baseline also demonstrated a validation gap: a task could list supplied facts in both its own `produces` and `requires`, pass graph validation, and receive a favorable judgment. Later worker outputs passed screening checks despite invented units and business rules.

Repair evaluator errors against stored artifacts within a separate budget. Keep them distinct from candidate failures. Enforce machine-checkable semantics, units and length where possible; use independent judging for semantic questions. A model's assertion that it verified something is not verification evidence.

### 7. The final-test lifecycle fits a single attempt better than an extended search

The controller runs held-out verification when a candidate first meets the development target and marks that holdout consumed. Continuing afterward makes it exposed, so later candidates cannot establish independent final verification on the same set (`core/goalController.js:772`, `:813`). The secrecy policy is valuable, but an early final attempt is a poor fit for a long search.

Predefine development, validation and final-test roles. Use development to optimize, validation on a restricted schedule to select finalists, then freeze one candidate for the reserved final test. Validation is also subject to adaptive overfitting and needs a query budget. If the final test fails, report that result; do not silently recycle it into optimization.

### 8. Usage controls are limits, not yet a forecast

The start review (`src/v2/GoalWorkspace.jsx:51`) shows model, iterations, calls, minutes, dollars and case count. It does not explain the multiplication of candidates, cases, repetitions, worker calls, judges and repairs. There is no pilot-based forecast or budget reserved for final confirmation.

The dollar check uses settled known cost. In-flight work is not reserved against an estimated maximum, and unpriced calls do not contribute to the dollar total. The existing UI correctly calls this out, but it should not be presented as an exact upper bound on provider billing.

A long-run review should show distinct candidate and API-call counts, estimated tokens/cost/time ranges, concurrency, model roles, repair allowance, protected verification budget, and what happens on unknown pricing or forecast changes. Reserve call and cost capacity before launching work. Ask for another decision only when the agreed policy cannot cover the next action.

### 9. Persistent does not mean continuously running while the app is closed

`core/goalController.js:405` pauses goals during app shutdown. Saved work can resume, but this is not an unattended service that keeps working after the app exits. The current active-time ceiling is 24 hours, and broad tool access is incompatible with the current independent held-out verification contract (`core/goalController.js:199`).

For overnight work, communicate the execution location and app/sleep behavior. A dedicated worker process or service can reuse existing ownership and checkpoints. Tool-enabled code/workflow optimization additionally needs isolated candidate workspaces and evaluator access boundaries before independent tests can be promised.

## Proposed campaign: up to 200 distinct candidates

Candidate count and model-call count must be different concepts in the UI and runtime.

| Phase | New candidates | Purpose |
|---|---:|---|
| Explore | 60 | Search 6–10 explicitly different approaches: task granularity, dependency strategy, context handoff, verification placement and prompt structure. Screen cheaply; keep several families alive. |
| Refine | 100 | Work across surviving families. Mix small controlled edits with combinations of useful changes and occasional larger redesigns. Request a hypothesis and predicted effect for every candidate. |
| Challenge | 40 | Revisit weak task families, try fresh approaches and test whether a plateau reflects the current strategy rather than the whole search space. |
| Confirm | 0 | Freeze the shortlist, run deeper matched validation, choose one candidate and run its reserved final test. Return baseline if no improvement is established. |

A small calibration pilot and baseline measurement precede or form part of the exploration allocation. Phase allocations are upper bounds with predefined reallocation rules. Do not spend all 200 merely to reach the number; finish when the agreed evidence and stopping policy justify it.

Each candidate should have an immutable artifact/configuration, parent IDs, strategy family, edit type, hypothesis, meaningful diff, evaluation tier, per-task results and model/route identity. Retain several useful quality/cost/latency tradeoffs instead of forcing every decision through one scalar winner. An evidence-backed memory should explain which changes worked, on which tasks, and which remain uncertain.

Start with an explicit search space. Prompt changes, worker settings and workflow structure can each be allowed independently. Bigger changes must still preserve the output contract, tests, model choices, tool permissions and budget that the user fixed. Changing those fixed boundaries is a separate reviewed campaign revision.

## Persistent learning from every direction

User requirement: successful and unsuccessful directions must both contribute durable learning. Ending a branch, reaching a budget, closing the app or starting another compatible campaign must not discard what was learned. Memory is part of experiment selection, not only a history screen.

Use the existing immutable candidate and trial records as authoritative evidence, with a persistent, searchable index and versioned lesson records that refer back to that evidence. An index can be rebuilt; observations must remain intact. The optimizer receives a bounded selection of relevant records rather than an ever-growing transcript. Persist three distinct kinds of information:

| Record | Required content |
|---|---|
| Experiment | Candidate and parent IDs, direction, hypothesis, exact change, model/configuration and block version, task/benchmark versions, repetitions, raw outcomes, resource usage and evidence references. Retain unsuccessful and abandoned candidates too. |
| Lesson | A scoped claim about what helped or hurt, supporting and contradicting experiment IDs, applicability conditions, evidence strength, unresolved alternatives and revision history. Distinguish hypothesis, supported finding, mixed evidence and refuted claim. |
| Next investigation | An unanswered question, why it matters, the smallest useful distinguishing experiment and the circumstances that justify retrying a previously unsuccessful approach. |

Separate observations from interpretations. “This candidate exceeded the word limit in three of four trials” is an observation. “Removing the length instruction caused that regression” needs a controlled comparison. When several changes occur together, record uncertainty about attribution and consider follow-up trials that add or remove one change at a time.

A direction that loses overall can still contain a useful component. Record improvements and regressions per task family and metric so later candidates can combine the useful parts. Do not label an entire approach ineffective because a provider timed out, a judge returned invalid evidence, execution was cancelled, or the budget expired. Those are separate outcomes with different recovery policies.

Before proposing a candidate, retrieve relevant successes, failures and contradictory findings. Record which lessons informed the proposal and how the new experiment differs from earlier attempts. An exact rerun may be intentional replication; a previously failed idea may deserve retesting after a material model, configuration or workload change. Require a reason and allocate a bounded retest budget rather than permanently banning the idea or accidentally repeating it.

After evaluation, the runtime records measured facts and evidence links. A model may propose interpretations, but calling a lesson supported requires a defined evidence policy, not the model's confidence alone. New evidence can revise or contradict an old lesson without erasing it. Findings about one model, block version or task distribution must not silently become universal rules.

Reuse relevant learning across directions and subsequent compatible campaigns, scoped to the project/block and its versions. Treat older or mismatched results as hypotheses requiring revalidation. Keep restricted validation and final-test evidence outside optimizer retrieval, including through cross-campaign indexes; persistence must not leak protected answers into later search. A reused test that influenced optimization cannot be presented as a fresh independent test.

Acceptance checks for this capability:

- Resume after an app restart and retrieve the same successful and failed experiments with their evidence intact.
- Start a compatible campaign and show relevant prior lessons, their limits and the experiments supporting them.
- Reject an unsupported claim of learning; retain conflicting evidence and allow an explicit revision.
- Record whether a repeated candidate is a deliberate replication, a justified retest or an accidental duplicate.
- Demonstrate that a losing direction can contribute a useful component to a later candidate through a measured follow-up comparison.
- Keep final-test content inaccessible to optimizer memory and cross-campaign retrieval.

## Why staged evaluation matters to usage

A flat plan of 200 candidates × 12 tasks × 3 repetitions × (one execution call + one judge call) already needs **14,400 model calls**, plus roughly 200 candidate-generation calls, baseline work, repairs and final verification. That exceeds the current 10,000-call ceiling. Multi-worker workflows cost more calls per execution.

One illustrative staged allocation is:

- Screen all 200 on three tasks once: 600 execution trials.
- Evaluate 24 survivors on twelve tasks three times: 864 trials.
- Validate three finalists on eight tasks five times: 120 trials.
- Test one frozen winner on six final tasks five times: 30 trials.
- Measure baseline on twelve tasks three times: 36 trials.

That totals 1,650 trials. At exactly two calls per trial plus one generation call per candidate, it is **3,500 calls before repairs**, assuming no reuse between stages. This is illustrative arithmetic, not a quote or a guarantee. Real workflow topology, token budgets, judge configuration and provider behavior determine usage. A pilot should populate the estimate from actual observations and identify which task families need more repetitions.

The launch screen should explain that forecast in plain language and give the user one coherent authorization for the campaign. Progress should show diversity explored, surviving families, task coverage, confidence in improvement, spending and reserved confirmation capacity—not just “iteration 83/200.”

## Recommended implementation order

1. Correct optimization semantics and trusted workflow measurements: baseline as incumbent, explicit completion mode, stronger quality gates, richer repair/judge feedback.
2. Add durable candidate families, ancestry, duplicate screening, phase policy and persistent learning from successful and failed directions, including retrieval across compatible campaigns.
3. Add a bounded evaluation queue, staged promotion, matched repetitions and protected final verification.
4. Add pilot-based forecasts, cost reservations, long-run progress and explicit background execution behavior.
5. Validate with interruption/failure accounting probes, then a small real-provider campaign before a 200-candidate run.

The intended value is a defensible answer about which design works better across tasks and why. A high iteration count is useful only when it buys broader exploration or stronger evidence.
