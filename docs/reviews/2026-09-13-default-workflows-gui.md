# Default workflow GUI acceptance — 13 September 2026

See the [portability follow-up](2026-09-13-default-workflows-portability.md) for
later fixes, recovery demonstrations and additional GUI acceptance. The original
observations below are retained as historical evidence.

Status: completed diagnostic testing — all 18 GUI scenarios supervised and their
final results inspected. This is not a release sign-off.

## Method

Run all six default workflows on three distinct tasks each. The scenarios use
isolated copies of a small offline order-management product with implementation,
tests and conflicting historical/current product documents. They represent real
software tasks, but are synthetic repositories, not customer production work.

`benchmark/default-workflows/gui-scenarios.mjs` freezes the requests and independent
acceptance checks. `scripts/verify-default-workflows-gui.mjs` launches the built
Electron app visibly, selects the workflow, types the request and clicks Run.
It observes the GUI every 15 seconds, saves screenshots and visible text, answers
the planned stakeholder question, and inspects the final interface. It does not
start workflows through IPC, CLI or kernel APIs. Coding outputs are also checked
outside the agent with withheld assertions and the resulting project tests.
Research, reviews and plans require semantic assessment; keyword matches are only
an aid, never acceptance. Read-only scenarios must preserve all project files.

The interactive native and browser tools both failed at initialization with
`failed to write kernel assets: Systemet finner ikke angitt bane. (os error 3)`.
The native tool was reset and retried with the same result. Testing therefore uses
the repository's existing headed Electron/Playwright approach, with screenshots
and saved GUI observations inspected during execution.

Each run uses the user's saved standard model route, an isolated app profile and
a separate Git repository. Credentials remain in a temporary local app profile,
outside scenario workspaces and report artifacts. The user's development project
and normal Flyt profile are not test targets. The harness has a supervision limit
of 15 minutes per ordinary task and 30 minutes per complex task; it stops through
the GUI when that limit is reached. These are test limits, not changes to shipped
workflow budgets.

Sandbox-escalation cases were stopped by the test supervisor, not by a natural
workflow failure. The computer-use skill's required guidance says, "Do not act on
security or privacy permission requests." Sandbox widening was treated as such a
request. Those outcomes establish that the confined configuration needed human
intervention; they do not establish that the workflow would fail if a user granted
the requested one-call access. No such grant was simulated.

## Scenarios

| Workflow | Task 1 | Task 2 | Task 3 |
| --- | --- | --- | --- |
| Make a change | Safe spreadsheet CSV export | Stable filtered pagination | Configuration validation |
| Fix a bug | Fully discounted line total | Final-day monthly reporting | Retry after rejected cached load |
| Review a change | Inflated revenue regression | Correct missing-file recovery | Cross-file response contract break |
| Research a question | Trace the order data path | Reconcile release-scope documents | Shared-workstation readiness |
| Plan an idea | Monthly finance report | Recoverable local backups | Clarify customer follow-up scope |
| Deliver a complex task | Reporting, API and CSV integration | Versioned storage migration | Validation and order creation |

## Issues found during supervised execution

1. **Electron sandbox probe failed before command tools were offered.** The probe
   used `process.execPath -e`, which launches Electron in the desktop host. The
   fixed probe explicitly runs that fixed script in Electron's Node mode. The
   restricted-token wrapper, required enforcement and outside-write denial check
   are unchanged. The initial CSV run stopped incomplete and remains in evidence.
2. **Work omitted generated stages and final conversation updates while live.**
   Snapshot diffing supported legacy flow fields but omitted canonical `stack`,
   `conversation` and `session`. The codec now carries them. A regression test
   verifies delivery of generated review stages and the final answer without
   reopening the run. The next GUI run visibly displayed its generated work.
3. **The worker assumed Unix syntax on Windows.** The second CSV attempt sent
   Unix inspection commands with `/dev/null` redirection to cmd.exe and interpreted
   the error as unavailable shell access. Subsequent worker instructions identify
   Windows/cmd.exe and direct the model to use file readers and valid commands.
4. **Piped Node child processes fail under the Windows restricted token.** The
   functional filesystem probe passes, but `node --test` fails with `spawn EPERM`.
   An independent confined reproduction narrowed this to child stdio `pipe`;
   `ignore` and `inherit` succeed. The CSV worker could run test files directly,
   but the requested `npm test` remained blocked. No confinement was relaxed.
   Upstream libuv's [child stdio setup](https://github.com/libuv/libuv/blob/v1.x/src/win/process-stdio.c)
   and [Windows pipe implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c)
   use named pipe pairs for piped subprocess streams. This supports investigating
   pipe-object access specifically; it does not by itself establish the precise
   failing Windows access check. Granting the ordinary user SID as a restricting
   SID would undermine outside-workspace write denial and is not an acceptable fix.
5. **Detected implementation defects can stop before repair.** The second CSV
   worker changed the header and order. Its own tests passed. The format-recovery
   result identified the mismatch against the original request, but the workflow
   treated all `remaining` entries as terminal rather than routing repairable
   defects through repair. It also included an optional test suggestion in that
   blocking list. The independent CSV assertion rejected the output.
   Fixed after the research-conflict run: a non-blocked completion with unmet
   requirements now spends the existing repair allowance. Persistent defects
   still exhaust that allowance without acceptance. External blocked status is
   still terminal. Schema guidance distinguishes mandatory defects from optional
   suggestions. Both recovery and exhaustion have regression coverage; the
   original CSV failure remains the measured outcome for that attempt.
6. **Interrupted diagnostic work can leave the candidate worse than an earlier
   point, and the final summary can misdescribe it.** The date worker reproduced
   the actual defect, fixed it and passed the direct reproduction, then reverted
   the source to demonstrate red regression tests. It next requested sandbox
   escalation. When stopped at that approval, the buggy source remained. Its
   conversation summary claimed no steps, changes or tests had happened, despite
   the recorded calls and added regression test file. The independent final check
   correctly evaluates the files left on disk rather than the earlier green run.
   After the complex-report attempt, cancellation wording now names the next
   model step and points to retained tool activity, instead of suggesting that
   no work began. Intentional deterministic summaries no longer count as degraded
   provider calls, so they do not generate warning banners.
7. **Sandbox approval is not reflected in the main status.** During the cache
   case the header continued to say `Running` while the visible document contained
   `APPROVAL REQUIRED · SANDBOX`. The approval section follows the expanded stage
   activity, below the initial viewport. A user looking only at the header can
   miss why progress has stopped.
   The header now displays `Needs approval` or `Needs an answer` and the interaction
   precedes expanded activity. The complex-report approval screenshot confirms
   `Needs Approval` in the header and the request above changes and activity.
8. **Research could search its own generated claims.** The release-scope run
   spent time investigating `.flyt/runs` matches, while file discovery already
   excluded them. Project search now shares that exclusion policy, retaining
   authored `.flyt` configuration. Local and execution-seam tests cover it.
9. **A rejected research answer was summarized as verified.** The source validator
   correctly rejected excerpts containing invented commentary and ellipses, but
   the optional conversation model described the result as fully source-backed.
   Incomplete runs now use the deterministic terminal facts and error instead of
   an optional model recap. Successful runs retain their concise model recap.
   The source schema also explicitly requests one contiguous copied excerpt.
10. **Output-format recovery can be invisible while running.** During the
    shared-workstation investigation, the GUI appeared unchanged after its last
    tool call while a format-recovery model call was actively streaming. The
    internal `.format` block lacked the generated-stage metadata needed for the
    normal task display. It now emits active and terminal display metadata;
    the projection regression passes. The complex-validation live screenshot
    confirms the correction call and its streaming activity are visible. The
    original hidden activity remains in the evidence.
11. **A structurally valid plan can falsely declare readiness.** The finance-report
    specification was marked `READY FOR IMPLEMENTATION`, but paired five CSV
    header columns with four-field TOTAL rows, shifting the monetary totals.
    It repeats the mismatch in acceptance examples. The planning path checks the
    structured schema and open-decision state, but does not independently check
    the specification's internal contracts. This remains a release blocker for
    treating `ready` as independently verified implementation readiness.
    The backup draft also contains conflicting retention ordering after a later
    live-write failure and an underspecified restore replacement. It is honestly
    labelled draft, but still needs revision. The clarification draft correctly
    incorporates the owner answer and is accepted as a useful scoped draft.
12. **Optional summary failures dominate a successful result.** The clarification
    workflow completed, but the separate free-tier supervisor provider returned
    resource exhaustion. The result was retained, as intended. The GUI displayed
    two large banners containing the same raw provider error, making an optional
    recap failure disproportionately prominent. This remains a presentation issue.

Single generated tasks also occupied a narrow fixed grid column. Changing the
grid to `auto-fit` lets them use the available width; the review-clean GUI
confirmed the improved layout.

A confined diagnostic confirmed that direct `node --test
--experimental-test-isolation=none test/*.test.js` runs these tests. This changes
test-file process isolation and is not silently substituted for the requested
`npm test` acceptance command. The option is rejected in `NODE_OPTIONS`, and
appending it through `npm test -- ...` after the fixture's file glob did not fix
the failure. These observations are retained in `.flyt/probe-node-options*.log`.

The original CSV holdout initially had an escaping error in its expected string.
It was corrected and rerun against the unchanged original artifact; it passes.
`independent-corrected.json` retains that verifier correction separately. The
original workflow still failed because it could not execute its checks.

Changes made between attempts are disclosed here; this is diagnostic acceptance
testing, not a controlled comparative benchmark. Original failures are retained.

## Evidence locations

- Original desktop failure: `.flyt/gui-workflows/2026-09-13/change-csv/`.
- Continued suite: `.flyt/gui-workflows/2026-09-13-fixed/`.
- Each case contains the request screenshot, live/final screenshots, timestamped
  GUI observations, final visible text, original request, independent check output
  and untouched canonical session evidence under its isolated workspace.
- Test implementation: `scripts/verify-default-workflows-gui.mjs`.

## Results

All six workflows were launched through the GUI on three distinct scenarios.
The main suite produced **6 accepted results, 3 natural workflow failures,
2 completed but defective specifications, and 7 supervisor-stopped approval
requests**. One accepted result is a useful draft plan, not a verified ready
specification. GUI status alone reported 8 Done, 3 Failed and 7 Stopped.

| Workflow | Accepted results | What the three scenarios established |
| --- | ---: | --- |
| Make a change | 0/3 | CSV contract wrong; pagination and configuration artifacts pass independent checks, but workflows did not complete acceptance |
| Fix a bug | 0/3 | Cache fix passes independent checks; discount remained unchanged; date fix was reverted before interruption |
| Review a change | 3/3 | Caught revenue and cross-file contract regressions; correctly accepted a clean missing-file recovery |
| Research a question | 2/3 | Useful architecture and concurrency answers; rejected invented source excerpts in release-scope research |
| Plan an idea | 1/3 | Useful clarification draft; finance specification has misaligned CSV totals; backup draft has conflicting failure ordering |
| Deliver a complex task | 0/3 | Partial first milestones pass project tests; all three stopped before acceptance and integration |

Detailed attempts, in scenario order:

| Scenario | GUI | Independent assessment | Seconds | Workflow calls |
| --- | --- | --- | ---: | ---: |
| change-csv | Failed | Incorrect CSV contract | 410 | 11 |
| change-pagination | Stopped | Code checks pass; stopped at approval | 288 | 12 |
| change-config | Failed | Code checks pass; workflow incomplete | 213 | 15 |
| bug-discount | Stopped | Original bug remains; stopped at approval | 107 | 9 |
| bug-date | Stopped | Final files retain bug after diagnostic revert | 395 | 12 |
| bug-cache | Stopped | Fix checks pass; stopped at approval | 394 | 15 |
| review-revenue | Done | Accepted review with actionable regression | 288 | 7 |
| review-clean | Done | Accepted review with no false blocking finding | 106 | 3 |
| review-contract | Done | Accepted cross-file contract finding | 91 | 6 |
| research-architecture | Done | Accepted, with verbosity/wording notes | 303 | 10 |
| research-conflict | Failed | Invalid quotations correctly rejected | 303 | 11 |
| research-readiness | Done | Accepted source-grounded risk assessment | 439 | 6 |
| plan-export | Done | Rejected: five-column header, four-field totals | 273 | 6 |
| plan-backup | Done | Draft needs failure-ordering and restore revision | 424 | 7 |
| plan-ambiguous | Done | Accepted scoped draft after one GUI answer | 319 | 6 |
| complex-report | Stopped | First-milestone tests pass; integration absent | 409 | 14 |
| complex-migration | Stopped | Schema tests pass; storage migration absent | 364 | 15 |
| complex-validation | Stopped | Validator tests pass; creation API absent | 394 | 17 |

All nine read-only scenarios preserved project files. Three of nine writing
artifacts pass the complete independent code checks, despite their incomplete
workflow status. No writing workflow reached end-to-end acceptance. The three
complex projects respectively pass 11, 9 and 35 project tests outside the sandbox,
but this does not certify their missing second milestones. The validation holdout
also interprets nonempty strings as nonblank; that stricter fixture assumption is
disclosed in the assessment and is not the sole reason to reject the incomplete
creation feature.

There were no harness failures or renderer exceptions in the main suite. The
original extra CSV desktop attempt is retained separately and is not counted as
one of these 18 outcomes. No sandbox expansion was approved and no normal user
profile settings were changed.

The recorded workflow provider calls total **182**, with approximately **$0.157
in known-price usage**; this is recorded usage, not a billing statement, and does
not include unrecorded or optional recap usage. Summed launch-to-close scenario
time was **92 minutes**, including GUI observation, questions and supervision.
It is not model-only latency. Complex planning alone took 132, 113 and 107 seconds;
the final case spent 57 of those seconds correcting output format. Stage timings
overlap when a format correction is part of another stage and must not be summed.

Per-scenario judgments and caveats are in
[gui-assessments.json](../../benchmark/default-workflows/gui-assessments.json).
Machine-readable events and extracted reports are in the local
[summary.json](../../.flyt/gui-workflows/2026-09-13-fixed/summary.json).
Representative GUI evidence shows the
[visible approval request](../../.flyt/gui-workflows/2026-09-13-fixed/complex-report/approval.png),
[live format correction](../../.flyt/gui-workflows/2026-09-13-fixed/complex-validation/format-recovery-live.png),
and [final incomplete result](../../.flyt/gui-workflows/2026-09-13-fixed/complex-validation/final.png).

## Regression validation for the integration fixes

- Build: passed.
- Follow-up repair, summary, search and snapshot regression cases: 54 passed.
- Default workflow suite after format-stage visibility: 31 passed.
- Stop-summary, default workflow and worker-parity tests with the normal test
  environment: 48 passed. An initial direct invocation omitted that environment
  and left four parity tests cancelled while waiting for a mock worker to start;
  the configured rerun passed with zero cancellations.
- Snapshot codec: 7 passed.
- Default workflows and shared worker regression: 41 passed.
- Real Windows sandbox suite, including the Electron-host probe: 6 passed,
  zero skips, with `FLYT_RELEASE_SANDBOX_E2E=1`.
- Initial full suite: 2,710 passed, one failed, one skipped. The failure was the existing
  campaign timing case `budget optimization explores families and reserves final
  verification until a frozen matched winner` (`Campaign did not settle`). It
  passed when rerun alone in 21.4 seconds. The original timeout remains recorded
  in `.flyt/gui-full-tests.log`; it is not reported as an entirely green full run.
- Follow-up full suite: 2,713 passed, two failed, one skipped. The campaign timeout
  recurred. The other failure was the editor's CSS assertion still expecting
  `auto-fill`; it now asserts `auto-fit`, matching the supervised layout fix.
  All 12 editor tests then passed. Full-run evidence is retained in
  `.flyt/gui-final-full-tests.log`; the timing failure remains unresolved.

## Shipping decision and next acceptance gates

Do not sign off the replacement defaults as release-ready from this suite.
Three review scenarios produced useful, grounded results. The writing workflows
did not reach end-to-end acceptance in the tested confined Windows setup, even
where the resulting code passed independent checks. Approval-stopped attempts
remain inconclusive about what would happen after an authorized wider run.
The finance plan's false readiness is a separate output-quality failure.

Before shipping:

1. Resolve or explicitly support the project's actual test-runner process needs
   inside the execution world. Preserve outside-workspace denial and process
   ownership. Repeat the writing scenarios with fully observed milestone checks
   and final integration; do not count an in-process alternative as a silent pass
   for a different requested command.
2. Add a bounded specification-consistency check before declaring a plan ready.
   Validate concrete examples against their own interfaces and field layouts;
   keep proposed defaults distinct from stakeholder decisions. Include the CSV
   and backup failure-ordering examples in its acceptance suite.
3. Measure structured-output reliability and latency on each intended shipping
   route. Format-only corrections and repeated reads are material overhead in
   these traces. Preserve rejection of invented quotations while reducing
   unnecessary reconstruction of long answers. A cheaper call is not necessarily
   a faster useful result.
4. Recheck cancellation and resume through the GUI after a genuinely accepted
   milestone, including unchanged accepted work, source drift, failed checks and
   a later integrated defect. This suite exercises supervised stopping, but its
   blocked complex attempts do not establish successful multi-milestone recovery.
5. Broaden acceptance to substantial existing repositories and other supported
   platforms. These realistic scenarios use a small synthetic product and one
   saved standard route (`z-ai/glm-5.3-flash`); they are diagnostic evidence, not a
   production success-rate estimate or a comparison with fable-at-home.

Plugin opportunities and core responsibilities are recorded separately in
[workflow-plugin-opportunities.md](../workflow-plugin-opportunities.md).
