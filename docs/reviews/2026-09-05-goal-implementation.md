# Goal mode implementation and verification

Implemented on 2026-09-05 against the existing working tree. Pre-existing edits were retained.

## Delivered

- A durable `GoalController` above the existing `RunController`. Setup, recipe iterations and candidate workflow tests all execute through the canonical kernel host and session log.
- Saved Goal instances, setup once, a typed folder identity, pause/stop/resume, finite iteration/call/time limits, dollar supervision, and separate current/best artifacts.
- Immutable recipe and iteration records, stable child identities written before dispatch, atomic state projections, explicit iteration boundaries and recovery from completed records.
- Validated model proposals through the same stack edit commands used by the block editor. Human/model edits use revision comparison, recipe activation occurs between iterations, and a failed trial can resume after a human revision or restore while retaining prior evidence and budget consumption.
- Runtime-owned acceptance checks outside the recipe. Outcomes distinguish achieved, limit reached, plateau, needs input, failed, stopped and paused. A partial best result never becomes an achieved Goal.
- Bounded Goal context and findings, with provenance and an explicit hypothesis status for model-written learning. The `goal_history` tool retrieves bounded evidence from the current Goal only; candidate tests do not receive optimizer memory or expected answers in their context.
- Shared model-call accounting across children, including parallel calls. Unknown prices remain unknown. Hidden adapter retries are disabled for Goal calls; every new invocation reserves budget. Dollar supervision is checked between calls, so an active call can cross the threshold.
- A Goals surface in the current shell: contract settings, separate Setup once / Each iteration editors using `BlockEditor`, tool selection, file/output checks, model choice, runtime progress, memory/evidence inspection, iteration comparison, revision inspection and restore. Includes an editable workflow-optimization template with fixed candidate tests.
- Resume now uses the recorded resolved workflow tree. Explicit worker reconfiguration remains supported. Also fixed the missing `meta` binding in `RunController.resume`.
- Evaluation now validates an exact verdict, consistent success boolean, numeric score and separate explanation. Legacy canonical backlog handoff now explicitly fails without making a model call or claiming anything was queued. Existing backlog APIs and records remain available.

## End-to-end app verification

The final successful test used the actual Electron renderer, preload IPC, application API, GoalController, RunController, kernel and live OpenRouter provider. Mock mode was disabled.

- Goal instance: `043b9677-f382-4dd9-b362-4c17d85bd04e`
- Model: `openai/gpt-3.5-turbo`, routed through OpenRouter
- Setup completed once.
- Iteration 1 returned `ALPHA`: 1 of 2 checks passed.
- Iteration 2 returned `ALPHA BETA`: 2 of 2 checks passed.
- Final status: **achieved**; the renderer also displayed the achieved state.
- Five charged model calls, including history-tool rounds; reported cost **$0.0027755**, zero unpriced calls.
- Best artifact: `ALPHA BETA`.

The test filled the Goal form, saved it, clicked Start goal, waited for completion, inspected memory and captured the UI. Native desktop automation could not activate the window, so verification used Electron's renderer test harness instead.

Evidence:

- [Result and checks](goal-e2e/result.json)
- [Achieved state screenshot](goal-e2e/goal-result.png)
- [Memory inspection screenshot](goal-e2e/goal-memory.png)
- [Full targeted test output](goal-e2e/tests.txt)
- [Live app harness](../../scripts/verify-goal-app.mjs)

The live checks also exposed older-model output variation. Multiple JSON objects are rejected. One unambiguous fenced JSON artifact with surrounding explanatory prose is accepted and still undergoes candidate and deterministic acceptance validation. An earlier live attempt failed closed on ambiguous output; it was not counted as a successful loop.

## Automated verification

- `npm run build`: passed (TypeScript kernel and Vite renderer).
- **179 targeted tests passed**, zero failures or skips, covering Goal acceptance, foundation repairs, RunController, registry, resume/walk/stop, production Loop parity, shell/API/editor and workflow context.
- Goal-specific cases include fifty iterations with bounded requests, scoped model history retrieval, self-proposed revision activation, simultaneous edits, failed-trial restore, pause/resume with completed setup, immutable best evidence, candidate children, parallel shared-call limits, malformed output, and escaping junctions.
- `git diff --check` passed for changed tracked implementation files.

Run the focused suite with `npm run verify:goal`. For live app verification, make Playwright available through `FLYT_PLAYWRIGHT_ROOT` (or install it locally), then run `npm run verify:goal:app`. The harness uses a connected model and consumes provider usage; `FLYT_VERIFY_MODEL` selects a different configured model.

## Boundaries

Strict isolation is **not implemented by the current local provider**. Selecting it refuses creation before any model runs; there is no silent downgrade. Folder focus is available and is accurately labelled. The filesystem-view isolation provider, and its full file/shell/descendant boundary proof, remain outstanding.

The delivered scope is a Goal-wide folder plus clean candidate-test folders. Arbitrary nested Workspace groups in the editor are not implemented. Candidate workflow execution is currently the fixed-test operation on `candidate.source`, rather than a general run-workflow block in the palette.

The initial rubric supports exact output/file content checks and fixed-input candidate tests. This verification proves runtime behavior, not statistical workflow optimality. Weighted benchmark metrics, held-out evaluation and automatic repeated ranking of noisy candidates remain future work. Full artifacts and checks are preserved in iteration records; creating or publishing a workflow in the library remains a separate operation.
