# Block acceptance audit — 6 September 2026

All 15 registered block types were exercised through the production kernel with **z-ai/glm-5.3-flash**, in two passes using different tasks. The original pass found four failing block contracts (Split, Plan, Backlog plan, Backlog handoff). Repairs were followed by another full pass, output review, combination tests, failure-path tests, and targeted live reruns. Every latest acceptance case passes. Expected human rejection and exhausted Until cases terminate as failures and are counted as successful checks of that behavior.

The production Build UI also passed insertion, configuration, and output-declaration checks for all 15 blocks, plus authoring all six controls. A real isolated Electron session created a workflow, ran Repeat with inputs 0 and 10, and showed results 2 and 12; the final container and child both displayed Done. [Desktop evidence](desktop-repeat-done.jpg). Newly created workflows appear selected in Work immediately after Build → Run. [Editor evidence](ui-authoring.json), [selection screenshot](fresh-workflow-selected.png).

## Coverage

Final trial time includes tools and model latency; calls are recorded completed model responses. Deterministic checkpoint/handoff blocks require no model calls.

| Block | First task | Second task / final repair check | Final time / calls |
|---|---|---|---|
| Combine | Merge latency and invalidation notes — passed | Merge offline/zero/Unicode requirements — passed | 42s / 1 |
| General analysis | Compute 75% success and limits — passed | Compute total 20; explain zero counts — passed | 25s / 2 |
| Plan | Plan boundary tests and null-result documentation — found fault | Plan quantity validation and Unicode documentation — passed | 89s / 2 |
| Research | Open Node test-runner documentation — passed | Open JSON RFC 8259 — passed | 48s / 5 |
| Split | Split keyboard and JSON-documentation tasks — found fault | Split zero-count and Unicode tasks — passed | 55s / 1 |
| Plan & dispatch | Dispatch two actual read-only scheduling workers — passed | Dispatch two actual read-only inventory workers — passed | 30s / 6 |
| Work | Create and run departure boundary tests — passed | Create and run empty/zero inventory tests — passed | 64s / 7 |
| Interrogate | Ask for export format; incorporate JSON answer — passed | Ask for export format; incorporate CSV answer — passed | 137s / 4 |
| Orient | Distinguish local schedule from airline platform — passed | Distinguish offline calculator from marketplace — passed | 21s / 2 |
| Compare | Select B under an 8 MB hard limit — passed | Select A preserving zeros and labels — passed | 50s / 1 |
| Evaluation | Pass correct arithmetic — passed | Retry incomplete ALPHA/BETA candidate — passed | 8s / 1 |
| Human checkpoint | Approve and continue — passed | Reject and stop — passed | 0s / 0 |
| Prompt refiner | Refine schedule tests without code changes — passed | Refine inventory tests without scope expansion — passed | 37s / 1 |
| Backlog plan | Ground two scheduling backlog tasks — found fault | Ground inventory tasks with new write paths — passed | 150s / 6 |
| Backlog handoff | Queue a real scheduling task — found fault | Queue a real inventory task — passed | 0s / 0 |

The first fixture was a local departure scheduler; the second an offline fruit inventory calculator with zero quantities and Unicode labels. Work created real node:test files and executed them. Both generated suites were independently rerun successfully after the audit. [Verification](generated-tests-rechecked.json).

| Combination / edge case | Final outcome | Time / calls | Evidence |
|---|---|---|---|
| analysis-files | done / expected | 23s / 3 | [record](second-final-general-analysis-analysis-files-foreach.json) |
| foreach | done / expected | 138s / 3 | [record](second-input-only-foreach.json) |
| parallel-sequence | done / expected | 100s / 4 | [record](second-controls-foreach-parallel-sequence-repeat-until-if.json) |
| repeat | done / expected | 17s / 3 | [record](second-controls-foreach-parallel-sequence-repeat-until-if.json) |
| until | done / expected | 11s / 2 | [record](second-controls-foreach-parallel-sequence-repeat-until-if.json) |
| if | done / expected | 21s / 2 | [record](second-controls-foreach-parallel-sequence-repeat-until-if.json) |
| plan-handoff | done / expected | 72s / 4 | [record](second-quality-split-prompt-refiner-backlog-plan-compare-parallel-sequence-plan-handoff.json) |
| parallel-failure | failed / expected | 7s / 1 | [record](second-edge-split-foreach-parallel-failure-until-exhausted.json) |
| until-exhausted | failed / expected | 8s / 2 | [record](second-edge-split-foreach-parallel-failure-until-exhausted.json) |

Sequence, Parallel, Repeat, For each, Until, If, virtual Input, generated worker children, both If branches, human approval/rejection, actual queue persistence, loop bounds, and downstream failure propagation were exercised. For each was tested with complete task strings and objects, including non-ASCII text. The final input-only variant prevents task-description summaries from starting repository exploration.

## Faults found and corrected

1. **Fragmented task lists:** Split/Plan/Backlog plan split output into individual lines, producing 26, 49, and 16 fragments instead of two tasks. The shared parser now decodes JSON arrays and groups legacy Markdown task details. Invalid JSON fails visibly; a single Markdown task also stays intact.
2. **Truncated plans:** a real Plan response consumed its 4,096-token budget partly on reasoning and ended mid-JSON. AI steps now have a configurable 16,384-token default and bounded continuation on provider length stops.
3. **Missing evidence access:** General analysis and Plan lacked repository readers. Their ceilings now permit read-only evidence tools, with no writers or shell.
4. **Unrunnable handoff:** Backlog handoff unconditionally failed. It now validates explicit task objects and queues through a dedicated permission-checked tool, with durable receipts, replay-safe identities, and honest partial-failure receipts. It never starts the supervisor. Denied approval and narrowed ceilings were tested; ordinary worker queue restrictions remain enforced.
5. **Lost For each objects:** task objects became “[object Object]”. Object items now serialize as JSON; workers received both complete acceptance criteria in live runs.
6. **Hidden parallel failure:** a successful last lane could let a containing sequence/loop continue after another lane failed. All containing controls now stop on any failed child. A real rejected checkpoint alongside a successful model lane verified that downstream work did not run.
7. **Incorrect control status:** Repeat stayed Pending and For each could stay active after completion. Authored controls now record their active/terminal lifecycle, including empty paths and failures. Recovery keeps legacy tool ownership separate from control status events.
8. **Stale workflow picker:** Build → Run on a newly created workflow left “Select workflow” in Work. The catalog refreshes after authoring/plugin changes and before launch selection.
9. **Missing editor outputs:** palette/command insertion dropped registered outputs, preventing normal loop binding. Canonical insert commands now preserve them.
10. **Uneditable JSON settings:** condition fields discarded intermediate invalid text while typing. They now keep draft text and validate on Save. Blank optional numbers/enums remove the override; structured settings are edited as JSON. The checkpoint checkbox now shows its actual enabled default.
11. **Misleading checkpoint prompt/trace:** the question assumed every artifact was a refined planning request, and tool events lacked block identity. The question now applies to any artifact, and trace attribution is explicit.
12. **Unusable backlog write scope:** plans omitted required new test files from blastRadius because they did not already exist. The planner now distinguishes writable deliverables (including new files) from read-only context. The final inventory plan explicitly permits inventory.test.js.
13. **Wrong comparison target and expanded briefs:** Compare sometimes ranked reviewers rather than the actual options; Split invented implementation details; Prompt refiner authorized unrelated metadata changes. Their defaults now preserve scope, identify assumptions, and compare the requested alternatives. Explicit system-prompt overrides remain respected.
14. **Unbounded verbosity and unnecessary exploration:** numeric word ceilings in step instructions now receive the shared correction/enforcement behavior. “Use input only” explicitly removes tools for transformations. An unrestricted For each rerun hit the four-minute audit watchdog; the corrected input-only run completed with intact task content and no tools. Provider reasoning time still varies.

## Verification and limits

- npm test: **2534 passed, 0 failed, 4 skipped**, 2538 total. [Log](final-tests.log).
- npm run build: passed. [Log](build-latest.log).
- npm run lint: all six shipped stacks passed. [Log](lint.log).
- Real authoring UI: 15 blocks, six controls, defaults, partial/invalid/valid JSON edits, and fresh-workflow selection passed; no browser page errors. [Record](ui-authoring.json).
- 67 recorded kernel audit runs, 178 completed model responses, approximately **$0.0571** provider-reported cost across those records. Small additional desktop calls are recorded in the isolated app profile. No model other than GLM Flash was used for these live checks.

The four skipped tests require a Windows restricted-token sandbox unavailable for this sign-in; the existing baseline skipped the same four. Real command tests used explicitly unconfined disposable workspaces, as permitted for this unattended audit. These are focused acceptance fixtures, not a throughput benchmark or a guarantee for arbitrary prompts/models. No personal project files were used as test subjects, and the pre-existing working-tree changes were preserved.

Original failures remain in [first-pass evidence](first.json) and subsequent repair records. The first collector was corrected to read structured outputs and generated children from canonical block.status events, not block.output; those collector mistakes are not reported as app faults. The full second pass initially passed automated checks, then manual review exposed the write-scope/comparison/verbosity issues above; later records document their repairs.

## Reproduce

Set FLYT_VERIFY_SETTINGS to a settings file with an OpenRouter connection, then run node scripts/verify-all-blocks-live.mjs --pass=first and --pass=second. The script asserts the selected model is GLM Flash or an explicitly selected free model and creates isolated temporary workspaces. Individual repair cases use --only=id,id. This sends real provider requests.

For the authoring UI, run node scripts/verify-blocks-ui.mjs with FLYT_PLAYWRIGHT_ROOT pointing to an installed Playwright package and optionally FLYT_BROWSER_EXECUTABLE. It uses the real authoring controller and React UI with fixture app services; it does not execute model work. The live audit above verifies execution separately.
