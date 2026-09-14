# Sustained Goal campaigns

The Goal workspace's **Search and completion** panel now offers three policies:

- **Satisfy acceptance criteria** preserves existing saved Goal behavior.
- **Optimize within a budget** explores distinct candidates, retains the baseline as an incumbent, and confirms a shortlist when search ends.
- **Stop after verified improvement** can enter confirmation after the minimum exploration allocation and an eligible development gain.

Optimization requires a fixed baseline, a versioned evaluation, and an explicit search space. For workflow optimization, supply `evaluation.baseline.source` as canonical workflow YAML. Prompts, worker settings and structure can be authorized separately. Models, tool grants, benchmarks and acceptance checks remain fixed. These policies currently require tool-free execution; isolated, tool-enabled code mutation is not implemented.

`limits.iterations` bounds proposal attempts; `campaign.maxCandidates` bounds distinct candidates. An accidental duplicate costs generation calls but receives no evaluation. Intentional replication or retesting requires a reason and consumes the separate retest allowance. Each proposal includes `experiment.hypothesis`, plus optional known parent IDs, edit type, informed-by lesson IDs, and repetition metadata. Missing hypotheses and changes outside the search space are recorded as invalid candidates.

## Search and selection

Default phase fractions are 30% explore, 50% refine, and 20% challenge: 60/100/40 at 200 candidates. The controller assigns families by coverage, keeps parent identities and diffs, and retains up to three nondominated quality/cost/latency choices per family. Deep-evaluation capacity is released cumulatively at 30%, 80%, and 100% of its allowance, so discovery cannot spend the entire refinement allocation; unused capacity rolls forward. Plateau stopping is available in the challenge phase after minimum exploration. Hard budgets and user controls can stop earlier.

Deterministic gates precede judges. Eligible screening survivors can advance to the full development suite. Confirmation uses matched case/repetition pairs with stable randomized baseline/candidate order. A task-level mean regression beyond its configured tolerance rejects a gain. Selection uses a conservative three-standard-error dispersion heuristic and at least two matched observations per task; this is **not** a formal confidence guarantee, especially for ordinal judge scores or adaptive searches. Named metric tolerances apply to tie-breakers as well as the primary metric.

Validation cases are private to confirmation and subject to a finalist query allowance. When validation is absent, confirmation repeats development cases and is labeled by that split. The shortlist is persisted before confirmation. The selected candidate is frozen before the reserved held-out test. Configured case repetitions are never reduced during confirmation or final verification. A failed final test ends the campaign with the baseline retained. Previously used validation/final cases and development exposure are checked across project campaigns before claiming independent final verification.

## Durable learning

Immutable `experiment-*`, `iteration-*`, `report-*`, and `measurement-*` records retain candidates, ancestry, outcomes and raw evidence. `learning-experiment-*` records contain only development observations. Interrupted and abandoned experiments receive explicit outcome records; later recovery appends a revision rather than replacing them.

`learning-index.json` is a persistent searchable catalogue that can be rebuilt from immutable observations. Lessons retain supporting and contradicting evidence and explicit revision links. Runtime-generated claims describe scoped measured associations; model interpretations always remain hypotheses. A losing direction can retain useful per-metric observations for subsequent component tests. Provider failures, cancellation, unavailable evaluation and budget exhaustion are distinct from failed candidate gates.

Retrieval covers successes, failures and duplicates within the project and benchmark family. Model, configuration, workload, baseline and runtime implementation fingerprints constrain applicability; mismatched results are labeled hypotheses requiring revalidation. Optimizer packets remain bounded. `goal_history` can retrieve paginated complete candidate text/source and development report diagnostics. Validation and final-test reports have no optimizer retrieval path and never enter the learning index.

## Usage, execution and recovery

The launch review explains trial multiplication, candidate and API-call counts, model roles, concurrency, repair allowance, unknown-pricing policy and protected confirmation capacity. Calibration records an observed forecast of calls and available token/cost/time measurements. Forecasts remain estimates; the approved fixed limits govern behavior if observed work is more expensive.

Each provider attempt reserves call capacity and an estimated dollar amount before dispatch, including concurrent descendants. Settled known costs release their estimate. Unpriced attempts retain it and either pause for review or continue under the fixed reservation policy. A dollar allowance is not an exact billing guarantee: actual charges may exceed the estimate. Search reaching its allocation transitions to confirmation; global call, cost and time ceilings still apply there. A confirmation reserve cannot guarantee enough capacity for arbitrary workflow topology.

Full-workflow measurements are bound from canonical candidate sessions and descendants through a host-owned facility. They include completion latency, calls, tokens, available cost, planning duration, ready-to-start delay and peak workers where the underlying events exist. Judging calls and time are accounted separately. Caller-supplied runtime values cannot impersonate these observations. Parseable but citation-invalid judge output receives the same bounded repair treatment as malformed JSON, against the original stored artifacts and within a separate campaign repair-call allowance.

Trials share the existing RunController and durable child identities. The bounded queue owns separate active children, drains launched trials on failure/control, and reuses completed evidence after resume. Execution remains local: keep the app open and the computer awake. App shutdown pauses saved work; no service that runs after exit was added.

## Verification

`tests/goalCampaign.test.js` exercises the canonical runtime with a synthetic provider, including staged selection, baseline retention, duplicates and deliberate repeats, cross-campaign learning, citation repair, reserve exhaustion, pause/resume, unpriced usage, trusted workflow metrics, and a deterministic 200-candidate persistence/context probe. Existing Goal, evaluator, task-graph, authoring, reuse and statistics tests are retained. The launch/edit/review UI was also checked in a browser against an isolated authoring fixture.

No real-provider campaign or paid 200-candidate run is started by this implementation. A small, explicitly reviewed provider pilot remains necessary before drawing conclusions about optimization quality or real usage.
