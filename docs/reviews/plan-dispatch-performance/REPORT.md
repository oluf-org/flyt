# Plan & dispatch performance review

12 September 2026. Actual model: `openrouter/z-ai/glm-5.3-flash`.

The saved Flyt loop improved planning efficiency on its four development trials. The production dispatcher now fills a free worker slot immediately, preserving dependency and concurrency limits. Live end-to-end runs did **not** become faster in this sample, and output quality still has specific shortcomings described below.

## Saved app loop

Open **Goals → Plan & dispatch — GLM 5.3 Flash performance → Results & stats**. The app was left on this result.

- Goal: `f251b00a-911d-4be2-bbcc-867ac2a80246`.
- Three improvement iterations; best eligible candidate: iteration 2.
- 46 model calls, $0.050793 known cost, 23m 27s active time.
- Status: `limit_reached`, with best artifact retained. The experimental 6,000 ms planning target was **not achieved**; automatic final verification was not established.
- Four development trials per attempt: two independent-work trials and two required-consolidation trials. Parser, graph-contract and case-specific schema gates were mandatory, alongside a GLM rubric for coverage and parallelism.
- The loop evaluates the real production planner without launching workers. Full worker runs were measured separately in the Electron app.

| Development planner measurement | Baseline | Best candidate, iteration 2 |
|---|---:|---:|
| Mean planning latency, including repairs | 40,146 ms | 15,624 ms |
| Mean planning tokens, including repairs | 4,260 | 1,703.5 |
| Valid on first attempt | 0/4 | 4/4 |
| Planner repairs | 4 | 0 |
| Final mandatory gate rate | 1.0 | 1.0 |
| Coverage rubric, mean /4 | 4.0 | 3.75 |
| Parallelism rubric, mean /4 | 4.0 | 4.0 |

Observed mean latency fell 61.1% and tokens fell 60.0%. These are finite development measurements, not statistical guarantees or end-to-end speed claims. The optimizer ranks gates first, then tokens and latency.

The baseline repeatedly put facts already supplied in the request into `requires`. The graph contract interprets that field as outputs supplied by another task, so these plans needed repair. Actual repair diagnostics were fed into recipe revision 2 without changing the benchmark or limits. Iterations 1 and 3 each had two invalid judge-citation errors and were ineligible; iteration 1 also needed three planner repairs. Their incomplete evidence was not promoted.

The best prompt still contained an overly broad instruction never to split a work package, and one judge found omitted arithmetic self-verification. The production change adopts the specific `requires` clarification and explicitly preserves requested verification in task goals. It does not install the entire learned prompt as a global policy.

## Production changes and parallelism

`kernel/src/plugins/blocks-task-graph.ts` replaces the `Promise.all` wave barrier with a bounded map of active tasks. Each settlement frees a slot; the next ready task starts without waiting for unrelated work. Retries retain their slot, prerequisite outputs reach dependants, inferred write-conflict dependencies remain enforced, and cancellation waits for started children to settle. Output aggregation retains authored plan order.

Worker guidance asks for proportional explanations, one presentation of each result and its evidence, and text artifacts when files were not requested. Build now calls its visual rows **Groups**, with “starts when ready,” because rows no longer represent execution barriers. Block and design documentation match that behavior.

The mixed live workload used two slots and four tasks: an independent audit, an independent sum, a doubling that requires the sum, and an independent range calculation. This made the old barrier directly observable:

| UTC event | Original dispatcher | Updated dispatcher |
|---|---|---|
| Sum finishes | 13:53:02.732 | 14:07:37.153 |
| Double starts | 13:53:16.904 | 14:07:37.172 |
| Unrelated audit finishes | 13:53:16.895 | 14:09:17.965 |
| Ready-to-start delay for double | **14,172 ms** | **19 ms** |
| Peak active workers | 2 | 2 |

The updated dispatcher also started the queued range task 20 ms after double finished, while the audit continued. Independent three-task runs reached three workers with no dependency edges. There were no tool executions in these supplied-facts trials.

A separate controlled benchmark alternated four measurements of each dispatcher using fixed worker delays of 500/50/180/180 ms. The mean fell from **766.1 ms to 553.7 ms (27.7%)**, with peak concurrency two throughout. This uses simulated model delays to isolate scheduling behavior; it is not a GLM performance measurement. See [scheduler.json](scheduler.json).

## Actual GLM dispatch runs

Durations run from dispatch block activation through terminal status, including planning and workers. They exclude the conversation supervisor's later summary. Each successful row below verified GLM for every planner and worker response. Baseline and production pairs use the same input, concurrency and worker limits; production rows use the updated invariant guidance with a neutral supplemental prompt.

| Run | Duration | Planner repairs | Peak workers | Worker output words | Known model cost |
|---|---:|---:|---:|---:|---:|
| Independent baseline | 50.592 s | 1 | 3 | 306 | $0.003641 |
| Independent production | 80.634 s | 0 | 3 | 302 | $0.002377 |
| Mixed baseline, adequate output budget | 89.797 s | 0 | 2 | 1,697 | $0.005524 |
| Mixed production, same budget | 139.256 s | 0 | 2 | 1,126 | $0.003500 |
| Fresh independent production case | 93.007 s | 0 | 3 | 436 | $0.002931 |

Both paired production runs were slower overall despite lower known cost and the removal of scheduling idle time. The mixed audit response took 103.9 s after the change versus 31.5 s before; the independent inventory response took 51.0 s versus 5.6 s. Model-call duration dominates these samples. This small, sequential before/after experiment cannot distinguish provider load from prompt/model behavior or establish an overall latency improvement.

## Output review

The independent case preserved total 20, pears at zero stock, the 37.5% latency calculation and statistical caveat, QA on day 4, release on day 5, and a rollback check. All three updated answers stayed under the requested 130 words. Some scope disclaimers and repeated results remain.

The mixed case preserved sum 31, a consumed-result doubling to 62, range 0–9 with zero retained, and all twelve audit concerns. Worker output fell 33.6%, mostly by reducing repeated explanations and artificial claims that an unrequested file write was “unverified.” However, the updated audit introduces a **quantity > 0** business rule that was never supplied. Zero should be handled according to the domain contract, not assumed invalid. Several table cells also exceed the requested short-phrase style. Coverage checks therefore pass while full semantic quality remains imperfect.

The fresh case was not supplied as optimizer feedback. It returned the correct 12 panels, 25% water reduction, and a five-day concurrent schedule including inspection, meeting the day-6 deadline. Manual review found important limits that simple keyword checks missed:

- Water use was supplied in **liters**, but the answer invents **liters/day**, household context and a 7–14-day sampling recommendation.
- Panel enumeration and absence of estimation uncertainty are asserted beyond the supplied counts.
- All three responses exceed the requested 130 words: 153, 139 and 144, although they remain within the block's 160-word hard ceiling.

The fresh run supports correct arithmetic and independent dispatch, but does **not** establish complete output fidelity or concision. The boolean checks in [evidence.json](evidence.json) are screening checks; this manual review is necessary. Further prompt optimization should gate unit preservation, unsupported assumptions and the requested answer length before promotion.

## Validation, exclusions and evidence

- Full suite: **2,655 passed, zero failed**. Production build passed. `git diff --check` passed.
- The new dependency/refill regression failed against the original dispatcher and passes after the fix. It uses deferred workers to prove readiness and slot limits without depending on model timing. A second test verifies cancellation drains active children and never launches queued work.
- An initial harness call used the wrong model-selection argument shape and reached the saved DeepSeek default. It is retained as `baseline` and excluded from GLM comparisons.
- An initial mixed run with a smaller output budget failed the audit output contract. It is retained as `baseline-mixed` and excluded from the successful timing pair. Both compared mixed runs then used 16,384 worker tokens and a 1,000-word ceiling.
- The saved conversation supervisor encountered a separate Nvidia-provider 502 and used its deterministic fallback. This was outside the measured GLM dispatch calls; the app's warning was preserved.
- Known cost for the loop plus all recorded planning/worker trials, including excluded failures: **$0.081009**. This excludes unrelated conversation-supervisor usage and is not an account billing total.
- Temporary trial stacks and their histories were moved into `.flyt/plan-dispatch-archived-stacks` after completion to keep the shipped workflow catalog unchanged. The saved Goal and canonical run snapshots remain available in Flyt. Trial sources and outputs are retained in this directory.

[definition.json](definition.json) contains the fixed loop policy. [goal-result.json](goal-result.json) contains the saved final state. [evidence.json](evidence.json) contains measurements, judge evidence, graph artifacts, model routes, worker intervals and outputs; it excludes hidden reasoning and credentials. The revised recipe, measured feedback, best prompt and all trial outputs are alongside this report. Canonical app records live under `.flyt/runs`, with the Goal under `.flyt/runs/goals/f251b00a-911d-4be2-bbcc-867ac2a80246`.

For reproduction, build the app, start development Electron with `--remote-debugging-port=9337`, and use `node scripts/run-plan-dispatch-loop.mjs status` or `collect`. `create` creates and starts the loop only when its experiment index does not already exist. `dispatch production-<label>` runs current production guidance; labels containing `mixed` or `heldout` select those cases. Dispatch calls use the app's existing preload API and real configured provider credentials. They incur model usage.

`node scripts/collect-plan-dispatch-evidence.mjs` refreshes the evidence without model calls. `node scripts/measure-dispatch-scheduling.mjs <baseline-ref>` reruns the controlled scheduler comparison after building. The original measured baseline is commit `a0b4b57a6705a5fa62de145483a46c0d0b8fd130`.
