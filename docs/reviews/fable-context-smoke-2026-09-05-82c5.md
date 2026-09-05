# Supervised Fable at home context-isolation smoke test

**Outcome: completed successfully; context checks passed. Separate scheduler bugs were confirmed.**

Run: `2026-09-05T09-46-40-854Z-82c5`. Launched from the current checkout with
`node bin/flyt.js run fable-at-home`, the saved workflow/model configuration,
the default Medium preset, and a read-only execution sandbox. The kernel was
rebuilt before launch. This was a live provider run, not the mock provider.

The input requested two independent source reviewers followed by a synthesis
task depending on both reports. Reviewers could read only their two assigned
files, with a requested four-read limit; synthesis was to use the reports
without tools. All generated `writeFiles` lists were empty.

## Completion and context evidence

- Execution began at **09:46:40 UTC**, September 5, 2026.
- Both reviewers started at **09:48:06.826 UTC** in distinct child sessions.
- Request review completed at **09:54:19.844 UTC**.
- Scheduler review completed at **10:00:59.975 UTC**, after one automatic retry.
- Synthesis completed at **10:04:15.236 UTC**; the parent reached `done` at
  **10:04:15.251 UTC**.
- The app's supervisor summary completed at **10:04:19.638 UTC** without
  fallback. The CLI exited **0** and the live lease file was removed.

Total wall time through final summary: approximately **17 minutes 39 seconds**.
The refiner, planner and workers used `z-ai/glm-5.3-flash` through OpenRouter.
The final app supervisor used
`openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`.

All **13 logged workflow model requests** had an explicit block scope. Their
canonical `step.prompt` references reconstructed the recorded message counts.
The planner received its own system prompt and the refined input, without the
refiner's transcript. Worker tool rounds retained only their owning transcript.
Neither independent reviewer received the other's completed report, including
scheduler retry requests sent after request review had finished. Only synthesis
received both reports, and it started after both dependencies completed.

There were **11 successful native `read_file` calls**, all confined to the four
assigned source paths. Request review used four reads. Scheduler review used
three reads in its discarded attempt and four in its successful retry.
Synthesis used no tools. There were no file-writing or shell tool calls.

The separate app supervisor summary is outside the 13 workflow-request count.
This verification reconstructs requests at the canonical assembly boundary;
it is not a network payload capture. No message-interception events occurred.
Fable uses generated task-graph children, so this live run does not replace the
static parallel-container regression tests added with the fix.

## Issues observed during the run

1. **Provider stream failure and expensive restart.** At **09:53:26.505 UTC**,
   scheduler review's first attempt failed with `stream_terminated`: OpenRouter
   ended the stream without a terminal completion state. The workflow correctly
   used its second and final attempt. Since no durable write existed, it restarted
   with a fresh transcript and repeated reads. Recovery worked, but contributed
   substantially to the long latency for this small audit.

2. **False repair event.** The first planner response passed validation, yet
   parent event **seq 256** reported `task_graph_repaired`. The append is
   unconditional at
   [blocks-task-graph.ts](D:/electron/llm-flow/kernel/src/plugins/blocks-task-graph.ts:670),
   so the trace can claim repair when no repair occurred.

3. **Source-reference and output-budget quality.** `read_file` supplied bounded
   previews without line numbers. Reviewers disclosed incomplete coverage, but
   request review still gave inaccurate estimated line references: request
   assembly was cited around line 470 instead of actual line 378, and the closing
   fold around line 1150 instead of line 899. Synthesis repeated those estimates.
   Scheduler review also returned approximately 513 whitespace-delimited words
   and synthesis 456, exceeding the requested below-450-word cap. The synthesis
   claimed full constraint compliance despite these limits and without visibility
   into the discarded scheduler attempt. Its compliance claim is not authoritative.

4. **Plugin hardening/audit gap, not an observed leak.** The source inspection
   confirms that hooks can replace the scoped messages after assembly at
   [run.ts](D:/electron/llm-flow/kernel/src/blocks/run.ts:400). The subsequent prompt record
   stores a canonical locator, not the replacement messages. Trusted hooks can
   therefore weaken both isolation and exact replay if they inject context.
   No such hooks ran in this test.

## Scheduler findings independently reproduced

The reviewers flagged these issues during the live run. A separate local kernel
fixture, using deterministic blocks and no model calls, confirmed the behavior:

| Issue | Reproduction | Observed result | Source |
|---|---|---|---|
| Repeat silently skips later executions | A repeat with `count: 2` and one recording block | The block executed once; run reported `done` | [runRepeat](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:511), [runBlock](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:677) |
| Foreach resume skips remaining elements | Seed a two-item roster and a completed first-item block, then resume | No item block executed; the remaining item was skipped and run reported `done` | [runForEach](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:621) |
| Until stop writes a false exhausted-pass failure | Stop after the first unsuccessful pass of `max: 3` | Run reported `stopped`, but container recorded `failed`, `passes: 3` | [runUntil](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:565), [failure record](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:586) |

These were separate from the transcript-isolation behavior exercised by this
Fable run and were unfixed when the original supervision ended. The follow-up
implementation below addresses them; the observations above describe the
original run, not the patched behavior.

## Follow-up fixes

- Repeat/foreach/until now identify each execution durably, replay completed
  iterations on resume, and keep stop status distinct from pass exhaustion.
  Foreach exports the last completed element's structured results.
- Generated workers retain completed evidence after transient stream failures.
  Child identities distinguish iterations and fresh restart boundaries.
  Provider truncation itself remains an external failure; recovery no longer
  discards successful reads merely because they did not write files.
- Valid first planner responses no longer emit a false repair event.
- Source previews now use numbered contiguous pages and exact continuation
  offsets. Citation instructions prohibit estimated line references.
- Explicit word ceilings are checked, with one bounded correction before failure.
  Dependency consumers receive recorded execution facts and an explicit statement
  that other constraints are unverified. Model prose is not a compliance oracle.
- Scoped message replacements from plugins are rejected before dispatch;
  permitted replacements in explicitly shared sessions are logged verbatim.

Regression coverage includes `iterationRecovery`, `sourceReadPagination`,
`blockRun`, `taskGraphBlock`, and the existing context, resume, session, reference,
and production-host suites. See [the execution contract](../workflow-context.md)
for precise scope, compatibility, and output-checking behavior.

## Live follow-up verification

Two additional real `fable-at-home` runs were supervised to terminal completion
using one read-only worker, one source read, and a below-60-word answer:

- `2026-09-05T10-53-57-843Z-lew7`: completed, 48 words, correct line-5 citation.
  Inspection caught the tool normalizer dropping the new `file` preview kind;
  that integration issue was corrected and covered through the registered tool.
- `2026-09-05T10-56-54-633Z-x09w`: completed, 43 words against the enforced
  59-word ceiling, one `read_file`, no other tools/writes. The logged tool result
  delivered numbered source lines and its citation matches source line 5.
  All five prompt locators reconstructed with matching message counts. One real
  invalid planner graph was repaired, so its repair event was appropriate.

The second run's optional final-summary provider returned an upstream Nvidia
capacity error through OpenRouter. The existing fallback summary displayed the
completed result; CLI exit was zero and the workflow remained `done`.
This is an external provider limit, not an unhandled workflow failure.

The second run's `verification.json` preserves the checks and final execution
facts next to its parent session. These small follow-ups verify the changed
production path; the earlier two-lane live run and deterministic overlapping-lane
tests provide the broader isolation evidence.

Validation: kernel TypeScript build passed. The full repository test run passed
2,445 tests with zero failures (`.flyt/followup-tests.log`); focused regression
checks were rerun after the final compatibility and correction-path changes.

## Saved evidence

In `.flyt/runs/2026-09-05T09-46-40-854Z-82c5/`:

- `session.jsonl`: authoritative parent trace, links and outputs.
- `context-audit.json`: all parent/child request scopes, reconstructed counts,
  tool calls, dependency-artifact presence checks, warnings and outputs.
- `context-verification.json`: final context/completion verification, passed.
- `scheduler-reproductions.json`: the three independently confirmed failures.

The inspection scripts are `.flyt/context-smoke-audit.mjs` and
`.flyt/check-smoke-findings.mjs`. The latter is a diagnostic reproduction of
known failures, not a passing correctness suite.
