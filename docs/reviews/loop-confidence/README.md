# Loop confidence audit — 7 September 2026

This is a live-provider acceptance exercise, not a claim that every possible long-running workflow is reliable. The trials use OpenRouter `z-ai/glm-5.3-flash`, the same model used by the failed Everest audit. Fixtures are local, deliberately small in scope, and never execute application code. The long-reading fixture contains 18 fictional maintenance records totaling about 255 KB.

`scripts/verify-loop-confidence.mjs` creates real drafts, publishes them through the authoring API, starts the ordinary Goal controller, watches them to settlement, and saves evidence. Mock mode is explicitly disabled. Run state and full canonical logs remain under `.flyt/confidence-live/workspaces/`. The release-notes trial was created and controlled through the Windows UI, with its own app profile.

## Problems found and changes

1. **Everest context failure:** OpenRouter streamed thousands of reasoning-text fragments as separate replay items. The last protected exchange could exceed the application ceiling by itself. Adjacent compatible text/summary fragments are now reassembled, preserving their content and metadata. Opaque/encrypted items and different metadata stay separate. Historical requests receive the same normalization before budgeting. The actual failed request fell from **381,357 to 48,856 characters**, with a durable checkpoint. This follows the provider's documented [reasoning replay guidance](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) and its [streamed-fragment bug discussion](https://github.com/OpenRouterTeam/ai-sdk-provider/issues/519).
2. **False live indicators:** the failed Everest Work view displayed “2 live” and a waiting response after execution had stopped. Terminal operational views now settle unfinished activity and stop waiting-for-token indicators; the raw log stays intact.
3. **Conflicting output instructions:** every intermediate step received the instruction to return the final Goal envelope. Orient and Analysis consequently wrapped ordinary handoffs in candidate JSON, despite their own instructions. The controller now distinguishes intermediate block schemas from the final envelope.
4. **Model-simulated iterations:** the first runbook trial wrote a useful document labeled iteration 2 while the controller had completed only one iteration. The controller's packet now explicitly owns the iteration number and prohibits simulating subsequent iterations inside a block. A separate regression trial retains the original failed behavioral evidence.
5. **Fatal final-envelope typo:** the checklist's Until → Evaluation → If → Work chain completed and wrote its artifact, but a missing closing brace failed the entire Goal. A bounded, tool-free formatting recovery now preserves the exact completed candidate string, uses the existing model/call/spend limits, and verifies it with the original checks. It cannot fabricate passing text, introduce workflow code or proposals, or replay completed writes. The saved live failure recovered with **one additional call**, from 4 to 5 total.
6. **Confusing resume review:** the resume dialog said “start” and showed a total budget without explaining retained usage. It now names start/resume/retry correctly and explains that prior calls, iterations, and spend remain charged.
7. **Reasoning consumes the whole response:** the first migration publisher used all 6,000 tokens on reasoning three times, producing neither a tool call nor an answer. Recovery now explicitly identifies the shared reasoning/output allowance and asks the model to finish from existing work. If bounded recovery fails, the error identifies the allowance and the remedy instead of saying only “no visible answer.” The ceiling is never silently increased. The fresh migration trial completed with the ordinary 16,384-token allowance. The longer runbook also exercised the new recovery live: its critique exhausted 16,384 tokens without output, then returned a usable answer on the next call.
8. **Hidden budget-stop cause:** time-limited runs reported “Execution cancelled before dispatch.” The controller now reports the reached call, time, or spend limit and that saved progress was retained, even when cancellation interrupts dispatch.

## Output quality review

The `.md` files beside this report are unedited model deliverables. The `.json` files contain execution evidence. Keyword checks are smoke checks; the qualitative review below is separate.

| Deliverable | Useful content | Review limitations |
|---|---|---|
| [Support FAQ](support-faq.md) | Answers all five tickets; preserves offline storage, no sync, export/import, replacement and uninstall loss. | Overstates “do not promise recovery” as “recovery is impossible.” Requires an editorial correction before customer publication. |
| [Release plan](release-plan.md) | Correct owners, estimates, sequencing, parallel implementation, QA after implementation, day-10 rollback reserve and cloud-sync exclusion. | Calls extra QA on days 7–9 “light” without an estimate. Useful planning draft, not an approved staffing commitment. |
| [Storage decision](storage-decision.md) | Makes a coherent SQLite recommendation for transactional imports and 50,000 local entries; compares the alternatives and includes a migration outline. | No benchmarks or platform tests. Post-cutover rollback needs a fresh, verified export of subsequent writes; periodic exports alone can lose changes. |
| [Original runbook](two-pass-runbook.md) | Preserves data/logs, avoids uninstall/clear-storage, requires a verified backup and consent, verifies count and samples, escalates appropriately. | The claimed second iteration was not a controller iteration. Count this as a failed behavioral trial despite its passing file checks. |
| [Completed two-pass runbook](runbook-completion.md) | Two actual controller iterations, one setup, 21 calls and 15 checkpoints over 21.84 active minutes. Final version preserves backup, offline work, consent before replacement, sample/count verification, and escalation; unknown operational details remain explicitly unsupplied. | Useful review draft, not an executable recovery procedure until its placeholders are resolved. Clarify “never modify the originals” as preserving the evidence copy: a confirmed restore necessarily changes the live app data. Repeated line citations and self-reported fact-checking do not replace that editorial review. |
| [Evaluation checklist](check-and-branch.md) | Four actionable sections; evaluation passed, Until exited, If selected the publisher, and the artifact was written. | Storage-specific examples are assumptions. The evaluator also confused test-orchestration requirements with checklist content. Keep workflow test instructions out of a real product brief. |
| [Migration tasks](migration-completion.md) | Exactly three task cards; correct conversion, both numeric examples, unknown-field preservation, backups, atomic replacement and all five regression cases. Proposed paths and runtime assumptions are labeled. | Useful starting backlog, not three fully independent implementation tickets. Task 1 must invoke Task 2's backup path, and tests depend on both. The interface is deferred. “No code changes during this planning run” was also over-interpreted as a restriction on future application integration. |
| [Maintenance priorities](long-evidence-retest.md) | All 18 counts, owners and recorded actions independently match their source files; the sum is 171 and the top three are service-18, service-17 and service-16. Survived ten durable context checkpoints. | One proposed action refers to a “recorded expected recovery time” that the fixture does not actually specify. Record that target before using it as a pass/fail condition. |
| [Release notes](ui-release-notes.md) | Two actual iterations; incorporates specific reviewer corrections, retains planned/not-shipped wording, and flags missing product/version metadata. | A useful customer-facing draft; it still needs those publication details. |

## Blocks I would remove, merge, or hide from ordinary Goals

- **Split:** remove from the default path. In the migration trial it mostly repackages the three tasks Backlog plan already produced. Keep it as an explicit conversion utility when the input truly is unstructured.
- **Backlog plan:** hide from ordinary document/audit Goals. Its extra queue fields and path-grounding work overlap with Plan and add cost when nothing will be queued. Keep it for actual backlog creation.
- **Backlog handoff:** hide from the Goal block picker. Its queue tool is forbidden inside Goals, so it is unusable in that execution mode. It remains useful for the separate backlog queue. This conclusion is from the implementation, not a live handoff trial.
- **Prompt refiner and Interrogate:** consolidate the default entry experience or make refinement optional. A complete brief should not pay for another paraphrase or risk an unattended question. Prompt refiner was tested; Interrogate was source-reviewed only.
- **Orient:** offer as a survey preset for Analysis rather than a mandatory first step. Its “relationship to the subject” framing added little to a five-question FAQ and invited unnecessary scope discussion. Repository orientation can still be useful when explicitly bounded.

Keep **Work**, **Plan + ForEach**, **Parallel + Compare**, and typed **Evaluation + If/Until**: the trials show distinct uses. Evaluation needs a clear way to preserve the artifact it judges; copying an entire checklist into its explanation is an awkward handoff workaround. **Combine** earns its place after multiple work packages, but is redundant after a single already-polished answer.

Human checkpoint is useful for attended work, but unsuitable for an unattended loop unless that pause is intentional. The UI trial exercised Goal result review, not the separate Human checkpoint block. Plan & dispatch, Interrogate, Backlog handoff, and the Repeat container were not live-tested here.

## Confidence boundaries

- Inspect controller iteration counts and durable events; never trust a document's self-reported iteration or “verified” wording.
- A keyword passing in a file does not establish factual accuracy or safe operational instructions. The FAQ and storage decision demonstrate this directly.
- The first large-reading run exhausted its configured 15-minute budget during publishing. That is retained as a limit/cleanup trial, not counted as a successful artifact run. A fresh retest uses a 45-minute limit and the ordinary 16,384-token completion allowance.
- The first runbook regression reached the real second iteration but exhausted the same 15-minute budget. Its completed first iteration remains available; the completion trial starts a fresh, explicitly longer instance rather than altering an exhausted run's contract.
- Clarifying the intermediate-output instruction reduces conflicting guidance; it does not make model compliance deterministic. The runbook's Analysis still voluntarily wrapped its text in a candidate envelope. Typed list/evaluation handoffs and the final result are checked by the runtime.
- These are bounded live trials on one provider/model, not a multi-day soak test. They do not establish behavior through machine sleep, network outages, OS reboot during a write, or every plugin and model.
- Source fixes and the locally built verification app are tested here. A Windows installer containing these changes is available at `release/loop-confidence-local/Flyt-2.1.4-win-x64.exe`; no release was published and the existing installed binary was not replaced. SHA-256: `22BEA9675500757CCAAE212048427D59B6F060DA780828E587A518DC2222326E`.

## Reproduce and inspect

Run `npm run build:kernel` first. `node scripts/verify-loop-confidence.mjs <case-id>` creates missing fixture drafts and runs the selected ready instance using the locally configured real OpenRouter connection. Existing results are retained. `--collect` only exports existing evidence; `--resume <case-id>` explicitly retries a failed/interrupted/paused instance within its original budget. Exhausted instances stay terminal. Raw settings and credentials are excluded from the evidence directory.

The completion variants use the normal response allowance and a 45-minute total cap. The original low-budget variants deliberately remain available as failure evidence. [UI completion screenshot](ui-achieved.jpg) and [UI review history](ui-release-notes.json) show the separately operated desktop trial.

## Regression and build validation

- Full `npm test`: **2,561 passed, 4 skipped, 0 failed** (2,565 tests).
- A subsequently added regression for time-limit cancellation during pending validation also passes (1 additional test).
- `npm run lint`: all six bundled stacks pass.
- TypeScript kernel and Vite renderer builds pass.
- Windows installer builds and its package-integrity hook verifies all 15 required application entries plus the native sandbox runner. The first package attempt hit a Windows rename error while extracting Electron; rebuilding from the already installed Electron distribution succeeded.
- Automatic approval review blocked cleanup of the first attempt's temporary `release/loop-confidence` directory (“blocked by policy”); it remains separate from the successful installer directory.
- [Build verification](build-verification.json) independently hashes the changed runtime files and renderer chunks and confirms they match the packaged archive. [Everest request verification](everest-context-verification.json) reconstructs the original saved failure and confirms it now fits the 96,000-character ceiling without mutating its log.
- Regression coverage includes replay reconstruction, historical context budgeting, terminal activity, bounded formatting repair, rejection of changed repair text, recovery of a saved failure without replaying its completed recipe, reasoning exhaustion bounds and retained call caps. Existing tests also exercise 50 iterations and recovery/control boundaries with deterministic providers.

## Execution ledger

**8 distinct scenarios completed successfully after fixes and reruns, across 12 instances.** The four other instances are retained as failed behavior, failure, or budget-stop evidence. All trials are settled; none is still consuming model calls. Total: 149 charged calls, $0.16713 known spend plus 3 unpriced calls.

| Instance | Outcome | Iterations | Calls | Active minutes | Checkpoints |
|---|---|---:|---:|---:|---:|
| support-faq | Completed | 1 | 9 | 7.86 | 3 |
| release-plan | Completed | 1 | 13 | 10.74 | 1 |
| storage-decision | Completed | 1 | 9 | 7.07 | 1 |
| two-pass-runbook | Behavioral failure despite achieved status | 1 | 18 | 10.55 | 15 |
| check-and-branch | Completed | 1 | 5 | 4.79 | 1 |
| migration-backlog | failed | 0 | 11 | 14.58 | 2 |
| long-evidence | limit_reached | 0 | 19 | 15 | 13 |
| runbook-revision | limit_reached | 1 | 13 | 15 | 3 |
| long-evidence-retest | Completed | 1 | 15 | 5.67 | 10 |
| runbook-completion | Completed | 2 | 21 | 21.84 | 15 |
| migration-completion | Completed | 1 | 9 | 6.4 | 1 |
| ui-release-notes | Completed | 2 | 7 | 2.19 | 0 |

Live coverage: 11 leaf block types and five container types. ForEach produced three work packages; Parallel produced two alternatives; Until passed on its first cycle and If took its publishing branch. This does not claim live coverage of the Until repair cycle or the alternate If branch.
