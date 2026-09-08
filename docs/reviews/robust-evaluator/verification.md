# Verification — 2026-09-08

The evaluator was exercised through the actual Electron desktop app using Windows Computer Use. A dedicated temporary profile/workspace and an explicitly synthetic provider kept the runs deterministic and free of live-model spend. No production prompts or ordinary user Goals were changed by the verification.

## Three desktop loops

Each Goal was opened, reviewed and started through Goals. The same production GoalController, RunController, block adapters, sessions and accounting ran all work.

| Work | Iterations | Shared model calls | Known spend | Final result |
| --- | ---: | ---: | ---: | --- |
| Structured data normalization | 4 | 27 | $0 | Achieved; best iteration 4; benchmark v2 |
| Resident event notice writing | 4 | 27 | $0 | Achieved; best iteration 4; benchmark v2 |
| Production Plan prompt evaluation | 4 | 36 | $0 | Achieved; best iteration 4; benchmark v2 |

Each loop retained an eligible improved candidate at iteration 1, rejected a contract-valid but incomplete candidate at iteration 2, recorded a judge error as incomplete evidence at iteration 3, and independently confirmed the iteration-4 reference challenger. Automatic promotion created v2 without an approval dialog, re-evaluated baseline and leader, and retained v1 evidence. Planning's additional calls are actual production Plan adapter executions.

The app was closed and restarted against the saved profile. All three remained achieved at the same call counts, costs, best iteration and benchmark version. `desktop-results.json` records the persisted state observed after restart. The temporary test provider can produce a project warning that its mock model is not enabled in the ordinary catalog; it is deliberately injected only by the verification entry point. This is not a configured live-model test.

In Results & stats, iteration 2 remained ineligible while best iteration 4 stayed visible. Tab moved focus to iteration 3 and Enter selected it, exposing unknown quality and one evaluator error. Reference proposal and transition records remained inspectable after restart. The window was narrowed to about 683 pixels: navigation reflowed to Loop/Details, metrics wrapped and the experiments table retained readable cells in a horizontal scroll region. Evidence stayed within a bounded scrolling panel.

Screenshots: [data results](desktop-data.png), [writing results](desktop-writing.png), [planning results](desktop-planning.png), [keyboard-selected error](desktop-keyboard-error.png), [reference verification](desktop-reference.png), [narrow layout](desktop-narrow.png). The immutable proposal record says “proposed”; its separate transition records “automatically promoted.” Later state projections also label the proposal's activated state explicitly.

## Automated checks

- `npm test`: 2,594 passed, 4 skipped, no failures (2,598 total). Includes workflow, renderer, provider/accounting, lifecycle and compatibility tests.
- `npm run verify:goal`: 95 passed, no failures.
- `npm run verify:evaluator`: 24 passed, no failures.
- `npm run verify:evaluator:fixture`: three synthetic canonical loops passed; full reproducible output is `synthetic-report.json`.
- `npm run build`: TypeScript and production Vite build passed. Vite reports a non-fatal bundle-size warning for the main daily UI chunk.
- `npm run lint`: all six shipped stacks passed.
- `git diff --check`: passed.

Focused tests cover strict arrays/objects/scalars, actual graph validators, repair versus first response, planner-only execution without workers, replayed effects, finite typed measurements, mandatory regression protection, reversed-order disagreement, exact citations, invalid references/judge JSON, missing workspace reference evidence, direct/workflow/Goal parity, exact boolean ports in ordinary Until/If workflows, approved command metrics, provider retry accounting, shared limits, stop/abort/resume retaining best, prepared references across engine restart, holdout exposure, optimistic manual review/restore and insufficient promotion-activation budget.

## Limits of the evidence

These scripted judgments test control flow and evidence handling; they measure no live model's quality or reliability. No paid live smoke test ran. Claims remain limited to observed cases and sample counts. Model-based confirmation is agreement under a fixed rubric, not proof of superiority. Arbitrary filesystem references cannot be independently inferred from text, so reference comparisons involving mandatory workspace commands/files abstain. Independent held-out verification requires tool grants that cannot access host evidence. Unknown provider usage stays unknown, and actual known cost is enforced between calls.

The editable real-model example in `examples/robust-plan-goal.mjs` is provided for bounded user-configured experiments; it has not been represented as a measured live result.
