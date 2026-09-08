# Robust evaluation for Flyt workflows and Goals

Status: ready for implementation handoff, 2026-09-08. The scope decisions below were confirmed by the user. This document specifies proposed behavior, not functionality already delivered.

## 1. Scope decisions

Confirmed scope:

- Include deterministic evaluation, reference comparisons, and AI judging in the first complete delivery.
- Allow automatic reference promotion when fixed verification rules pass. Do not require human approval for every qualified promotion.
- Include focused Goals UI changes for evaluation configuration, experiments, and reference inspection/review.

The remaining defaults in this document are implementation recommendations. They may be adjusted where the existing architecture offers an equivalent solution; preserve the product behavior and acceptance criteria.

## 2. Objective and completion boundary

Implement a reusable, evidence-backed evaluation subsystem that can evaluate one block output, a workflow result, or repeated Goal candidates. It must distinguish contract validity, task quality, comparative quality, and execution reliability. A candidate may be better than a reference without resembling it.

The immediate proving case is evaluating Plan and Plan & dispatch under different system prompts. This task delivers the evaluator, production-equivalent block evaluation adapters, reference comparison, persistence, and selected UI. A general autonomous prompt-search algorithm, paid large-scale prompt optimization campaign, and automatic installation of winning production prompts are separate work.

Deliver an editable example Goal recipe that can propose a prompt revision using existing blocks, run a bounded evaluation, and consume development feedback. Do not build a second optimizer or scheduler. Its purpose is to prove integration, not to claim that prompts have become optimal.

## 3. Current implementation and integration points

Reinspect these files before implementation; the checkout may have advanced:

- `core/goalController.js`: durable orchestration above RunController; inline `output_contains` / `file_contains` checks, fixed-input candidate workflow tests, and best selection by fraction of checks passed.
- `core/goalAuthoring.js`, `core/goalAuthoringContext.js`, `core/goalAuthoringProtocol.js`: definition validation, editable-field grants, authoring schemas and prompts, library reuse, and fixed contracts.
- `kernel/src/plugins/blocks-judgement.ts`: existing Evaluate block with `verdict`, `success`, `score`, and `explanation` outputs.
- `kernel/src/plugins/blocks-aistep.ts` and `kernel/src/blocks/list-output.ts`: Plan list-output execution and parsing.
- `kernel/src/plugins/blocks-core.ts`: Plan block definition.
- `kernel/src/plugins/blocks-task-graph.ts`: Plan & dispatch prompt assembly, structured response, graph validation, repairs, fallback, and worker execution.
- `core/api.js`, Electron/preload command bindings: public project-scoped operations.
- `src/v2/GoalWorkspace.jsx`, `GoalCanvas.jsx`, `LoopResult.jsx`, `core/loopStatistics.js`: authoring, runtime views, evidence, and statistics.
- `tests/goalController.test.js`, `goalFoundation.test.js`, `goalAuthoring.test.js`, `goalReuse.test.js`: existing lifecycle and compatibility coverage.

Plan currently asks for a JSON array. Plan & dispatch uses a task-graph object and already requests structured output and attempts repair. Never impose an object-only rule on all blocks, copy their validators into an independent benchmark implementation, or count a recovered output as first-attempt success.

Read repository instructions, `GOALS.md`, `DESIGN-SPEC.md`, `DECISIONS.md`, and relevant block contracts. Preserve unrelated changes. Use the canonical kernel/RunController execution path, session records, configured permissions, provider adapters, and accounting. Do not revive `core/stackRunner.js` or add a second workflow engine.

## 4. Core concepts

Keep these concepts separate in persisted data and UI:

- **Requirements:** fixed statements of correctness, scope, and constraints.
- **Benchmark version:** immutable cases, splits, references, evaluator configuration, and aggregation policy.
- **Reference solution:** a validated starting answer for a case, with provenance and known limitations. It is not presumed optimal or uniquely correct. A case may have multiple acceptable references.
- **Baseline:** the recorded performance of the starting block/prompt/configuration on a benchmark version.
- **Candidate version:** the immutable artifact being evaluated, with its inputs, source/prompt digest, and execution configuration.
- **Trial:** one execution of a candidate on one case and repeat, including all recovery attempts.
- **Evaluation:** checks and measurements derived from a trial or artifact.
- **Best eligible candidate:** a candidate that passes required gates and wins under the declared ranking policy.
- **Best partial candidate:** useful progress when none is eligible. It must never appear as verified success.
- **Reference challenger:** a candidate nominated for reference improvement, pending verification and any required human decision.

References are optional for deterministic evaluations. Human review of a reference is independent of human review after every Goal iteration.

## 5. Evaluator interface and result contract

Use a registry of typed evaluators. Each has a stable ID/version, validated configuration schema, supported input/artifact types, execution requirements, and a common result contract. Follow the existing plugin/contribution architecture; the exact module layout is an implementation decision. Adding an evaluator must not require editing Goal's best-selection or lifecycle logic.

An evaluation request identifies candidate/artifact, case, trial, benchmark version, evaluator version/configuration, workspace binding, cancellation, and owner budget. Reference and expected-answer data are provided only to evaluator execution, not automatically to candidate generation.

Results must represent at least:

- Stable evaluation ID and parent Goal/run/trial identities.
- Status: `pass`, `fail`, `error`, `inconclusive`, or `skipped`.
- Named check results, including mandatory/optional role and stable diagnostic codes.
- Named metrics with numeric value or explicit unavailable state, unit, direction, sample count, and aggregation semantics.
- Reference comparison: `better`, `equivalent`, `worse`, or `inconclusive`, where applicable, with per-dimension reasons.
- Evidence references/digests and bounded diagnostic excerpts.
- Evaluator/configuration/benchmark versions and relevant candidate/model identities.
- Execution duration, model calls, known cost, and explicitly unknown usage fields.

Validate all results before committing them. Reject non-finite numbers and invalid field combinations. Model-written explanations and confidence are not authoritative measurements. Preserve raw returned content for diagnostics within existing storage bounds; do not request or persist hidden chain-of-thought.

Keep check verdicts, candidate eligibility, comparative preference, ranking, and Goal completion as separate decisions. Do not overload one numeric `score` or `success` flag with all of them.

## 6. Built-in evaluator types

### 6.1 Deterministic checks

Provide:

1. Existing text/file containment checks with explicit compatibility semantics.
2. Strict JSON parsing and JSON Schema validation, supporting objects, arrays, and scalar schemas. Do not silently repair malformed raw output for the strict JSON check.
3. Production block-contract validation, reusing the actual Plan and Plan & dispatch validators. Report transformations accepted by the production parser separately from raw-format conformance.
4. Structured field assertions: existence, typed equality, numeric comparisons/tolerance, collection membership/count, and supported schema constraints. Use a bounded declarative schema, not arbitrary embedded JavaScript expressions.
5. Command/test verification through existing approved execution facilities: configured command, workspace, timeout, exit status, output artifacts, and optionally schema-validated metric output. Test commands and parsers are authored configuration, not candidate-authored instructions.
6. Runtime metrics from canonical evidence: latency, tokens, cost, recovery counts, and unresolved failures. Missing measurements remain unknown.

Distinguish a completed test reporting failure from a test runner that could not start, timed out, or produced invalid evidence. Support explicit expected-failure cases without treating unexpected infrastructure failures as successful outcomes.

### 6.2 AI rubric evaluation

Support an explicitly selected judge model and fixed rubric. The judge receives the original request, constraints, relevant artifacts, verified evidence, and dimension definitions. It returns structured per-dimension judgments, cited artifact/evidence locations, concise rationale, and uncertainty/abstention where appropriate.

Treat candidate text and references as untrusted content. Delimit them as data. The judge is tool-free by default and cannot change evaluation rules, approve reference promotions, or execute instructions embedded in answers.

Judge model/configuration is separate from candidate and optimizer model settings, fixed for comparable trials, and included in the shared budget. Reuse canonical provider execution. Judge-output repair is bounded and recorded; malformed/refused/exhausted judgments remain error or inconclusive and never become passes.

Deterministic failures cannot be overridden by an AI judge. Optional judges may add diagnostics without blocking eligibility; mandatory judges require a conclusive passing result. Always label subjective/model-based findings accurately.

### 6.3 Reference comparison

First check mandatory requirements. Then compare candidate and reference against the same rubric, without assuming the reference is correct or rewarding textual similarity by default.

Blind source identities and remove incidental prompt/model/version labels from the judge packet. Evaluate both A/B orders for a reference-challenge decision, map results back deterministically, and preserve order and decision evidence. Meaningful disagreement yields `inconclusive`; use a configured additional independent judgment or human review rather than silently selecting the favorable answer.

Require a declared tradeoff policy. Default: no regression on mandatory dimensions and a meaningful improvement on at least one chosen dimension. Mixed gains and losses remain inconclusive unless the user has explicitly configured priorities. Do not assume pairwise preference is transitive or build a universal ranking from unsupported pairwise scores.

References may be wrong. If verification exposes a reference failing requirements, flag it as invalid evidence for preference and request reference review. The reference's defect must not make candidate correctness automatic.

## 7. Benchmark execution and block adapters

Provide project-scoped, versioned suites with case IDs, input/context fixture references, case requirements, optional references, expected assertions, tags, split, and repeat count. Validate configuration before spending. Support save/load, version creation, JSON import/export, and a simple case editor; a separate global benchmark marketplace is outside scope.

Support development and held-out splits. Development feedback may guide revisions. Held-out answers and detailed failures are not fed back to the optimizer; show them in human-facing evidence after verification. If a held-out set is inspected and then used to guide another revision, record it as exposed and require a fresh verification set for an independent claim. Repeatedly checking the same holdout until success is not independent verification.

Use small development runs and configurable repeated trials for finalists. Pin model ID, provider routing requested/observed where available, response mode, sampling/token settings, repair policy, prompt assembly, input fixtures, and contract versions. Unknown actual provider details remain unknown. Show per-model results; aggregate only under an explicit fixed policy.

Add an evaluation-only adapter for Plan & dispatch that runs its production planning/repair path and stops before spawning workers. Factor shared code if necessary. Plan evaluation must likewise use the production contract and output handling. Allow selecting a prompt override without writing installed defaults. Record whether the override supplements or replaces base guidance; never imply a workflow guidance field replaces hardcoded instructions when it does not.

Capture raw/structured first response, parser transformations, repair attempts, fallback usage, finish reason, provider failures, and final usable outcome. A native structured response or tool payload is assessed through its actual response channel, not required to appear as textual JSON as well.

Report first-attempt contract rate, recovery rate, fallback rate, final unresolved rate, and task-quality checks separately. Define denominators: scheduled trials, attempted initial calls, responses received, completed trials, errors, and cancelled trials. Do not improve an apparent success rate by dropping failed/empty responses. Cancellation and unavailable infrastructure are explicitly visible, not silently treated as semantic failures or successes.

Allow evaluation of an existing immutable artifact/run as well as a fresh candidate execution. For goals, a candidate prompt is evaluated through the block outputs it produces; evaluating the prompt text itself does not establish block reliability.

## 8. Eligibility, ranking, and stopping

Freeze mandatory gates, ranking metrics, minimum meaningful improvement/tolerance, evaluation budget, and final-verification policy at experiment start.

Default ranking is lexicographic: pass mandatory gates, improve the selected primary metric, then apply explicitly configured tie-breakers. Keep previous best on unresolved ties. Do not average unrelated units or let a weighted quality score compensate for failed correctness gates. Multi-objective/Pareto optimization is not required for the first delivery.

Candidate eligibility cannot be established if a required evaluator errors, is inconclusive, or is skipped. Retain prior best; report the incomplete evidence and allow bounded re-evaluation. Evaluator/infrastructure errors do not count as comparable non-improvements for plateau detection. Repeat commitments must not increment plateau or budget twice.

Support independent target thresholds and final verification. A candidate can be the best without meeting the target. End states retain the existing distinctions: achieved, limit reached, plateau, needs input, failed, stopped, paused, and interrupted/recoverable as applicable. Explain the reason in terms of actual evidence and policy.

Display counts and sample sizes with rates. If a user configures a statistical reliability claim, implement a documented confidence calculation and required sample policy; do not substitute a judge's self-reported confidence. A first version may limit claims to observed results and configured sample counts. Never label a finite suite as proof of "never fails" or global optimality.

## 9. Reference preparation and promotion

Allow attaching existing reference artifacts or producing a reference through existing setup workflows. Reference preparation records original request, requirements, model/run provenance, validation, and any human review. The reference becomes fixed before measured candidate trials begin. Resume must not regenerate a committed reference.

Keep development-reference preparation separate from final held-out evidence. Reference generation and judging consume the owning run/Goal budget unless they were completed as a separately recorded benchmark-preparation run.

A reference challenger must:

1. Pass mandatory checks and have complete comparable evidence.
2. Be compared against the pinned reference under the declared tradeoff policy.
3. Produce a reviewable proposal naming exact artifacts, versions, differences, dimension judgments, uncertainties, and validation evidence.
4. Follow the fixed automatic-promotion policy described below. Human review remains available for ambiguous cases or an explicitly selected manual policy.

Automatic promotion is in scope and should work end to end. Its rules are visible and fixed before the Goal starts: required checks, allowed quality regressions (none by default), minimum meaningful gain on named dimensions, comparison agreement, independent confirmation policy, and a finite promotion limit. Recommended starting limit: one automatic promotion per Goal, configurable before start.

Default qualification requires complete passing mandatory checks, a declared meaningful gain without forbidden regressions, conclusive challenger preference in both blinded presentation orders, and a fresh confirmation evaluation. Use objective execution evidence wherever the declared claim permits it. When quality is inherently subjective, require a separately invoked confirmation judge under the same fixed rubric; record that this is model-based agreement, not a proof of superiority. Where no defensible verification rule can resolve a case, return inconclusive and retain the reference. A single positive judgment or candidate self-assessment cannot trigger promotion.

Reference version changes are authorized transitions in the original contract, not permission to change its requirements, rubric, datasets, budget, or promotion rules. Promotion creates a new benchmark/reference version and comparison segment; it never rewrites historical scores. Persist the proposal and verification decision, then re-evaluate the baseline and leading candidates under that version before activating its comparison segment. Only then resume ranking candidates. The same owning Goal may continue through this bounded transition; all verification and re-evaluation spend remains within its original limits. If budget is insufficient, preserve a verified proposal with an explicit pending-activation reason rather than mixing scores or silently resetting limits.

Preserve prior records and record the automatic policy or human decision authorizing promotion. Rejection preserves the original reference and challenger evidence. A user can inspect and restore a prior version through another recorded version transition; neither manual approval nor automatic preference overrides failed mandatory checks. Promotion is not itself Goal success.

## 10. Persistence, execution boundaries, and accounting

Use immutable artifact/evaluation records and existing durable event/ownership patterns. Record dispatch intent before child execution. Resume attaches to or reuses completed trials/evaluations; uncertain interrupted effects must be reported or verified rather than claimed exactly-once.

All candidate executions, judge calls, reference creation, repairs, retries, and nested evaluation calls share the declared parent limits for calls, duration, spend, and concurrency. Cancellation and pause/stop propagate. Record retries distinctly and never double count replayed commits. Enforce limits during work using existing mechanisms and accurately describe any between-call cost enforcement limits.

Keep benchmark answers, validators, judge instructions, and reference-management operations outside candidate-editable artifacts and grants. Use clean candidate fixture folders. Apply existing path/link validation and tool policies. Do not claim that folder focus provides strict filesystem secrecy: if broad candidate tools can access evaluation material, report the limitation and refuse to label that run an independently held-out verification. The evaluation-only planner path should not need tools that expose host evidence.

Persist configuration and content digests, expected and observed execution metadata, check results, raw-output references, retry events, user review, and reference-version lineage. Store full evidence within explicit bounds and provide bounded pagination/retrieval to the UI and Goal memory. Do not append entire histories to model context.

## 11. APIs and workflow integration

Expose public, project-scoped operations for benchmark draft validation/save/versioning, case management/import/export, candidate evaluation, status/control, evidence retrieval, candidate comparison, and reference proposal/review. Exact names should follow current conventions.

Use optimistic revision checks for definition edits and promotion decisions. Validate ownership and project/workspace binding at API boundaries. UI validation must not be the only enforcement layer.

Expose the same engine through a workflow block or a compatible extension of Evaluate, with typed outputs usable by If/Until. Preserve existing Evaluate behavior for existing saved workflows; do not silently change what its `score`, `success`, and `verdict` mean. The structured new evaluation report can be an additional port or versioned block contract.

An evaluation inside a Goal is mandatory runtime-owned work configured by the fixed contract. A self-redesigned recipe cannot remove it. Workflow authors may explicitly compose the same evaluator in ordinary workflows; neither integration gets a separate implementation of scoring.

## 12. Goals UI

Deliver focused changes using current design tokens and existing editor/chat components. Do not rebuild app-wide navigation or make a second block editor.

### Design

- Objective and artifact/block being improved.
- Allowed candidate changes, fixed model/response settings, workspace, and budget.
- Evaluation as a first-class area: case suite/version, evaluator type and typed settings, mandatory gates, primary metric/tie-breakers, references, development/repeat/final-verification policies.
- "Satisfies block contract" selects the installed block's actual evaluator.
- Reference preview, provenance, preparation/verification status, and the automatic-promotion rules/limit. Offer manual policy as an optional alternative.
- Preserve Setup once / Each iteration. Show runtime-owned evaluation distinctly.
- Authoring chat can propose these configurations with the same scoped grants and reviewable diffs; it cannot weaken a started Goal's contract.

### Experiments

- Baseline and candidate attempts with change rationale, sample counts, gates, primary metric, errors, repair/fallback rates, and spend.
- Current and best are separate. Explain rejection even when a headline metric improved.
- Select an attempt/case to inspect input, output channel, diagnostics, evidence, prompt diff, and per-dimension reference comparison.
- Explicit labels for development versus final verification, subjective judgments, incomplete evidence, and exposed holdouts.
- Show reference-improvement states: proposed, verifying, automatically promoted, pending activation, or inconclusive. Provide evidence inspection and manual review when needed; a qualified automatic promotion does not stop for an approval dialog.

### Best result

- Best eligible artifact; separately labeled best partial if none is eligible.
- Comparison with baseline under the same benchmark version.
- Target and final-verification status, remaining failures, exact scope of observed reliability, and stop reason.
- Inspect/export artifact, prompt diff where applicable, evaluation report, and benchmark/configuration identities.
- Reference promotion is distinct from applying a prompt to a production block. Automatic production prompt changes are outside this task.

Keep controls, usage, recovery state, and evidence available after reload. Preserve existing goal library/reuse behavior: definitions may be reused, but runtime progress, approvals, spending, and verification status do not transfer. Reused benchmark references must resolve as copied immutable definitions or explicit versioned references; missing fixtures must be diagnosed before running.

## 13. Compatibility

- Existing saved Goals, drafts, iteration records, library entries, and workflows remain readable.
- Legacy containment checks and candidate tests map to an explicit legacy evaluation policy that preserves their current scoring and stopping behavior, including partially passing best results. Do not silently reinterpret historical fractions as quality scores.
- New Goals use the richer schema and explicit eligibility/ranking policy.
- Resuming an old run preserves its frozen evaluation semantics; it must not acquire new mandatory checks.
- Make migration versioned and tested. Preserve immutable original records; update projections/adapters as appropriate.
- Update statistics to distinguish legacy check fractions from named new metrics; do not average incompatible benchmark versions or units.

## 14. Acceptance scenarios

Automate these with deterministic provider boundaries except where an explicitly recorded live check is needed:

1. Plan arrays and Plan & dispatch graph objects pass their own contracts; wrong top-level types fail with useful diagnostics.
2. Malformed JSON fails the raw-format check even when the production parser can recover a usable artifact; recovery is separately reported.
3. A graph with duplicate IDs, unknown/cyclic dependencies, or another production contract defect receives the same verdict in evaluation and production. Planner-only tests launch no workers.
4. A candidate with higher schema-validity rate but a failed mandatory coverage check cannot displace an eligible best candidate.
5. A solution structurally different from the reference can be equivalent or better. Fewer tasks alone is not sufficient evidence.
6. An invalid reference is flagged without granting candidate success. Conflicting tradeoffs and reversed-order judge disagreement are inconclusive unless policy resolves them.
7. Invalid judge JSON, refusal, timeout, missing evidence, and evaluator failure cannot become passes. Candidate instructions embedded in artifacts cannot modify judge policy or execute tools.
8. Trial reports distinguish first attempt, repair, fallback, unresolved error, cancellation, and unavailable infrastructure; denominators and unknown measurements remain visible.
9. Completed reference preparation, trial evaluation, and iteration commitment survive restart without repeated effects or duplicate accounting.
10. Parallel/nested candidate and judge work respect shared limits; stopping cancels owned work and preserves prior best.
11. The candidate receives the production input and allowed fixtures, without optimizer memory, reference answers, or hidden expected fields. Held-out feedback is not fed into optimization. Unsupported secrecy is surfaced honestly.
12. A qualified reference challenger is automatically promoted without a human approval prompt when all fixed rules pass. Failed/disagreeing verification does not promote. Promotion creates a new version, preserves old scores, and activates comparison only after baseline/leader re-evaluation. Insufficient budget leaves explicit pending activation. Concurrent/replayed promotion cannot duplicate versions, reset limits, or exceed the promotion cap. Manual review and version restore remain inspectable alternatives.
13. Best candidate, partial result, target achieved, and final verification remain distinct at budget/plateau/failed stops.
14. Existing Evaluate workflows and legacy Goal scoring/resume/reuse still behave as before. New evaluator definitions survive authoring edits, review, save/reload, and cross-project reuse.
15. One public evaluation path produces matching reports when called directly, through a workflow, and by Goal orchestration.
16. UI demonstrates design/configuration, a regressing attempt, an evaluator error, a better-than-reference proposal, reference review, and final evidence after reload. Verify keyboard operation and narrow-layout reflow.

Provide a small deterministic end-to-end fixture with baseline, improved candidate, contract-valid-but-incomplete candidate, recovery-only success, and reference challenger. Include a documented command that reproduces the report. Synthetic fixture results must be labeled and never presented as measured live-model reliability.

## 15. Suggested delivery sequence and verification

1. Establish types, evaluator registry, durable report format, compatibility adapter, and deterministic checks.
2. Add production block adapters, benchmark cases/repeats, shared execution/accounting, and Goal/workflow integration.
3. Add AI rubric/reference comparison, reference lifecycle, and evidence-backed review.
4. Add focused authoring/runtime/result UI and update library reuse/statistics.
5. Deliver the example Goal/fixtures, migration coverage, documentation, and end-to-end verification.

Run focused meaningful tests, `npm run verify:goal`, the production build, stack lint, and relevant workflow/renderer checks. Broaden tests where shared runtime or persistence changes require it. Use deterministic model boundaries for routine tests. A paid live smoke test requires configured models and an explicitly bounded authorized budget; never claim it ran if unavailable. Record passed checks, outstanding limitations, and any unverified live behavior.

Do not declare completion with a UI-only mock, a model-generated score unvalidated by the runtime, or a new evaluator path that leaves Goals using the old inline scoring. Finish the selected scope end to end.
