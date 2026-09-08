# Robust evaluator

Implemented against `robust-evaluator-spec.md`. Evaluation is fixed runtime work owned by the existing GoalController and RunController. It is separate from the editable iteration recipe. Existing Evaluate blocks and saved Goals without `evaluation` retain their original semantics (`legacy-containment-v1`); historical fractions are not relabeled as quality. New Goals opened in the UI start with an editable versioned evaluation policy.

## Author and run

In Goals, configure **Evaluation** before starting. Select an artifact, production Plan prompt, production Plan & dispatch prompt, or candidate workflow. Configure a development suite, mandatory checks, a named ranking metric and optional target/final verification. Project benchmark versions can be saved and loaded in this area. Complete policy JSON supports import/export, per-case assertions, fixtures, tags and references. Authoring chat uses the existing field grants, reviewable diffs and definition revision checks.

`examples/robust-plan-goal.mjs` exports `makePlanGoal(worker)`, an editable real-model example using the existing general-analysis block to propose prompt revisions. Supply an enabled `{provider, model}` worker, then pass the definition to `goal:author-open` and review/publish in Goals. Its cap is three iterations, thirty shared calls, five minutes and $1 known spend. The example intentionally claims only observed contract/verification-marker checks; add task-specific assertions or a fixed rubric for stronger quality claims. Importing the module does not execute anything. Winning prompts are never installed in production automatically.

The default UI policy checks a JSON object; change it to match the actual task. **Satisfies block contract** selects the actual production parser. Plan retains its JSON-array output contract and replaces standing prompt guidance. Plan & dispatch supplements invariant guidance and runs its real structured planning, validation, repair and fallback path, stopping before worker creation. Both adapters receive only the case request with no tools or optimizer memory. Workflow candidates use clean per-case fixture folders and the normal engine.

## Evaluators and decisions

All evaluator configurations have `id`, `version: 1`, unique `name`, `mandatory`, and typed `config`. `goal:evaluators` returns their schemas and execution requirements.

| Type | Configuration / evidence |
| --- | --- |
| `contains` | Literal case-sensitive `value`; optional workspace `path`, requiring `read_file`. |
| `json-schema` | JSON Schema `schema`; `raw` defaults true. Objects, arrays, scalars and native structured channels are supported. No fence stripping or repair for the raw check. |
| `block-contract` | `block: plan` or `task-graph`; delegates to production parsing and reports accepted transformations separately. |
| `field` | JSON-pointer `path`, `op` (`exists`, `equals`, `gt/gte/lt/lte`, `near`, `includes`, `count`), expected `value`, optional numeric `tolerance`. |
| `command` | Fixed `command`, `timeoutMs`, optional `expectedExit`; optional `metricSchema`, JSON-pointer `metricField`, `unit` and `direction`. Uses approved `bash` and its canonical structured result, not the model preview. |
| `runtime` | Canonical latency, token/cost and recovery observations. Missing measurements are explicitly unknown. |
| `ai-rubric` | Fixed judge `model`, `rubric`, dimensions (`id`, description, mandatory, minimum 0–4), optional bounded JSON repair. Subjective ordinal findings require exact artifact citations. |
| `reference` | Same rubric plus named `minGain` and optional explicit dimension `priorities`. Both blinded A/B orders must agree. |

Mandatory errors, inconclusive results and skips prevent eligibility. Ranking is lexicographic within one benchmark version, with a declared primary metric, optional tie-breakers and meaningful-improvement tolerance. An unavailable ranking measurement cannot establish a best candidate. Required correctness failures cannot be compensated by another metric. Errors do not advance plateau. Best eligible, partial, target achievement and final verification remain distinct.

Results include immutable identities/digests, named checks and metrics, raw/structured initial evidence, repair/fallback diagnostics, sample denominators, bounded comparison evidence and canonical session references. Provider-attempt telemetry includes retries; an unsuccessful first provider call cannot inflate first-attempt success, and unreported retry tokens remain unknown. Artifact-only checks have no candidate execution sample; they do not claim a block reliability rate. Report summaries describe observed finite suites, never statistical confidence or universal reliability. JSON Schema format annotations are not custom format validators; use explicit patterns or authored commands for those constraints.

## Reference lifecycle and privacy

Attach reference text with provenance, limitations and optional human-reviewed status. To prepare references through a fixed Setup once workflow, set `referencePreparation: {fromSetup: true}` and return `{"references":{"case-id":"complete reference text"}}`. Each reference passes fixed non-comparison checks before the benchmark commits. Setup results and validation runs are durable and are not regenerated on reload.

Promotion policies are `off`, `automatic`, or `manual`, with a finite limit and `confirmation: fresh-evaluation`. Qualification requires passing mandatory gates, complete comparable evidence, named meaningful gains without prohibited regressions, agreement in both blinded orders, and a separate fresh confirmation. A new reference uses the actual produced case artifact, not its generating prompt. The proposal and evidence are retained before a new benchmark version is prepared. Baseline and prior leader are re-evaluated before activation; historical attempts remain on their original versions. Exhausted budgets retain a verified proposal as pending activation. Manual decisions use optimistic revisions; restore creates another recorded version transition under the same owner budget. Promotion alone is not Goal success.

Judge calls are isolated and tool-free. Candidate/reference text is untrusted data; it cannot grant tools or change the fixed rubric. Invalid references and presentation-order disagreement abstain. Text references do not encode independent filesystem snapshots: comparisons involving mandatory file or command gates explicitly remain inconclusive instead of treating the candidate workspace as evidence about the reference. Artifact-level references and requirements support automatic promotion end to end.

Only public development inputs and bounded development diagnostics reach the optimizer. Held-out details stay in human-facing evidence. Continuing optimization after a held-out check marks that set exposed; another successful check cannot establish independence. Independent final verification is refused when candidate/optimizer tool grants could read host evidence. Workspace focus is not filesystem secrecy. Setup and broad-tool runs must not claim otherwise.

## Public and workflow integration

Project-scoped `goal:*` operations are available through the normal API and Electron bridge:

| Operations | Purpose |
| --- | --- |
| `evaluators` | Typed registry metadata. |
| `benchmark-validate/list/get/save/import/export/case` | Validate, manage cases and create immutable suite versions using `baseVersion`. |
| `evaluate` | Evaluate an explicit immutable `candidate` or canonical project `runId`/optional `blockId`; returns an owning Goal. |
| `get/start/control/inspect/history` | Existing lifecycle, recovery, status and immutable evidence controls. |
| `evaluation-evidence` | Bounded report pagination with digest and next offset. |
| `evaluation-compare` | Compare two iteration records under the same version and fixed ranking policy. |
| `reference-review` | Approve verified proposals, reject, or restore a previous version with `baseRevision`. |

`flyt-blocks-judgement:robust-evaluation` exposes typed `eligible` (boolean), `status`, `report` and `comparison` outputs for If/Until. It uses the same registry as Goals. The original Evaluate block keeps `score`, `success` and `verdict` unchanged. `flyt-blocks-judgement:immutable-artifact` passes bounded authored text without a model call and supports evaluation of saved artifacts.

Dispatch intents and completed child/evaluator effects use stable session identities. Replay reuses committed work; an uncertain interrupted judge, candidate or command is reported as incomplete, not silently repeated or claimed exactly-once. Interrupted reports retain pending child ownership for normal resume/cleanup. All candidate, judge, repair, preparation and promotion calls use the parent accounting and limits. Known spend is checked between calls; a provider may report actual cost only after a call, and missing cost remains unknown. Sequential evaluation is deliberate; nested candidate workflows still use existing shared concurrency limits.

## Verification

Run `npm run verify:evaluator` for focused acceptance tests. Run `npm run verify:evaluator:fixture` to reproduce three synthetic canonical loops and write `docs/reviews/robust-evaluator/synthetic-report.json`. The fixture covers structured data, writing and production Plan prompts with an improved candidate, an incomplete regression, a judge error and a qualified reference challenger. The focused planner test separately covers recovery-only usable output with failed strict raw JSON, no dispatched workers and replay without repeated calls.

For an isolated desktop reproduction, build, run `node scripts/verify-robust-evaluator.mjs --prepare-desktop`, then `node_modules/.bin/electron scripts/robust-evaluator-desktop.mjs`. Open each prepared Goal and start it through Goals. The script injects only a deterministic provider boundary; execution, persistence, UI and accounting are the production code. See `reviews/robust-evaluator/verification.md` for observed desktop runs and screenshots. These are synthetic results, not live-model quality measurements.
