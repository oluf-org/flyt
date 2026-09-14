# Default workflow evaluation

Retained live development measurements and limitations are in [development-findings.md](development-findings.md).

The fixed inputs in `cases.js` provide five small smoke cases for each of the six defaults. Expected files, text and executable assertions remain outside the candidate prompt. Each trial starts in a separate workspace and uses the production kernel, tools, confinement and session log. These cases check basic behavior; they do not represent the difficulty of a large migration or establish a production reliability rate.

## Running

List cases without using a provider:

```sh
npm run evaluate:defaults
```

Compare one case with a direct worker, with three matched repetitions:

```sh
npm run evaluate:defaults -- --live --case make-basic --baseline --repetitions 3
```

Run the complete smoke matrix, including the applicable earlier workflow:

```sh
npm run evaluate:defaults -- --live --case all --baseline --legacy --repetitions 3
```

`--model` and `--provider` select the same route for every variant. By default the script reads the saved standard-tier model and connected OpenRouter account from Flyt's settings. `--settings` overrides that file. Credentials are not printed or copied into the fixture directory. Live evaluation incurs the selected provider's ordinary charges.

`--minutes` sets a per-trial elapsed bound (10 by default); candidate workflows also receive a 30-attempt bound and a $0.50 settled-cost stop. An in-flight call can exceed that settled-cost stop. Direct and earlier workflows retain their own orchestration bounds and use the same elapsed timeout; their attempt limits are not claimed equivalent. Use the documented limits when interpreting results. Unknown costs remain null.

`--output` selects a new output directory; the default is a timestamped folder under `.flyt/default-workflow-evaluation/`. Reuse the source cases, not an existing trial's edited workspace. Results are saved after each trial in `results.json`; complete evidence lives in the associated canonical session logs. Candidate and comparison order alternates between repetitions. Provider attempts, tokens and costs include sessions reached through canonical child-session records.

## Reading results

`accepted` requires the expected runtime outcome and independently checked files/text/behavior. Cases explicitly requiring an incomplete result must not report `done`. `falseSuccess` means the run reported `done` while failing those fixed checks. This is a smoke-test definition, not a general semantic judge; inspect the actual output for ambiguous cases. The direct analysis baseline has no typed incomplete status, so an honest prose blocker can still fail that status requirement.

Calls, elapsed time and cost are measured separately from acceptance. Extra review calls need to produce useful evidence or catch failures to justify their expense; a more elaborate workflow is not automatically better. Do not infer cost from missing pricing or compare a stronger candidate model against a weaker baseline.

The deterministic production-host tests in `tests/defaultWorkflows.test.js` cover failure injection, false claims, failing required commands, stale evidence, independent citations, integration rejection, interruption after a write, retained accepted milestones and durable budgets. They complement these live smoke cases.

Before claiming shipping reliability, expand the matrix with representative product tasks: constrained refactors, unrelated test failures, subtle review defects, difficult source conflicts, blocked dependencies, and substantial multi-milestone changes. Repeat matched trials on intended shipping model configurations and inspect every failure. The six-case live development probe is useful integration evidence, not that release qualification.
# GUI scenario acceptance

The separate `gui-scenarios.mjs` suite contains 18 product scenarios (three per
default workflow), with real code, regression defects, review diffs, source
documents and stakeholder questions. See
[`2026-09-13-default-workflows-gui.md`](../../docs/reviews/2026-09-13-default-workflows-gui.md)
for supervised results and known limitations.

Use `npm run verify:defaults:gui` to build and list cases without provider calls.
Set `FLYT_PLAYWRIGHT_ROOT` to an installed Playwright package, then explicitly opt
in with `npm run verify:defaults:gui -- --live --case=all --output=<fresh-directory>`.
The harness uses the saved standard model and headed Electron GUI controls. It
does not launch runs through kernel APIs. Screenshots, observed GUI text, session
logs and independent checks remain under the chosen output directory. Review
and research answers still require human/agent semantic assessment; keyword
presence is not a pass. A failed or interrupted run remains a recorded attempt.
