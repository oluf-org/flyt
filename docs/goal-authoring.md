# Goal authoring chat

## Reusing goals and loops between projects

Open **Loop library** from Goals to search saved definitions across all projects.
Every saved draft with an objective, including the authoring record of a started
Goal, appears automatically. The catalogue reads application data, so its source
project does not have to remain open or on disk. Deleting an unstarted draft also
removes that definition from the catalogue; copies already reused elsewhere are
independent. Unsaved field edits are saved before the library opens.

**Use in this project** creates an editable, unreviewed draft. It copies the
objective, loop/setup steps, checks, limits, model and tool choices, then binds the
workspace to the destination project. It does not copy runtime IDs, progress,
memory, spending, conversations, selected context files, locks, grants or prior
approvals. Editing the new draft does not modify the source. Starting still uses
the ordinary review and per-project Goal controller.

**Required project paths** lists input files or directories the project supplies,
one relative path per line (`src`, `docs/security.md`). Missing paths are warnings,
not compatibility gates. Diagnostics identify the affected field, refresh every
five seconds, and can be refreshed with **Recheck paths**. The start review and
model context also receive them. Clearly quoted paths, bare relative file paths,
and Windows absolute paths in existing instructions are inspected as advisory
references. Reference detection is deliberately conservative; declare actual
prerequisites explicitly. Output files used by acceptance checks are not treated
as missing prerequisites.

An empty workspace binding uses the destination project; relative bindings are
resolved against that project, never the application's working directory. New
drafts work in the project folder by default. **Create a new folder for each run**
opts into the existing dedicated Goal workspace behavior: files from the parent
are not copied, and the UI warns about required inputs even if they exist in the
parent. Once started, diagnostics check the actual Goal workspace. Invalid or
unavailable workspace roots still need fixing before execution. Absolute paths,
traversal and links escaping the workspace are flagged without probing their
external targets. Unavailable saved models remain visible and need rebinding.

API actions: `goal:library`, `goal:reuse` (`projectId`, `libraryId`), and
`goal:requirements` (`projectId`, `draftId`). `requiredPaths` is a definition field
and becomes part of the fixed contract on start. The runtime receives readiness
diagnostics under `projectRequirements`; only mechanical acceptance checks decide
whether a candidate passes.

The loop designer supports explanation (`message`), clarification (`question`),
and reviewable edits (`proposal`). Explanations and questions do not create a
proposal or change the definition revision. Older untyped proposal responses
remain accepted for compatibility.

## Context and memory

`core/goalAuthoringContext.js` contains the standing prompt. Each request receives
the current definition, host-issued edit grant, locks, installed Goal block
contracts (including settings schemas, outputs and tool ceilings), available
model identifiers, execution restrictions and validated YAML examples.

Conversation context includes up to 12 recent user/assistant exchanges within
32,000 characters, plus up to 12 accepted/rejected proposal summaries. The
current request appears once. Responses and review decisions persist with the
draft; history is context, never a replacement for the current definition or
edit grant.

## Scope and read-only access

The scope pill in the composer controls the backend grant. It lists the two
kinds of narrowing and every step by name, so choosing a step is one click
rather than a kind and then a second selector:

- **Selected fields:** exact quoted fields; selected text preserves its prefix
  and suffix character-for-character.
- **A single step:** that node's title and config fields. It does not grant
  changes to descendants, structure or inherited Goal settings.
- **Entire loop:** Goal fields and complete recipe/setup replacements, still
  subject to locks and the fixed contract of a started Goal.

Removing the last quote does not silently widen scope: the pill stays on
selected fields, says so, and the request cannot be sent until a field is
quoted again or the scope is changed. Choosing a broader scope explicitly
clears the quotes. Scope, quoted fields and context-file selections
persist with the composer. Changes to model, tools, workspace, parallelism and
budgets are expanded and marked in proposal review.

The authoring controller implements a bounded JSON tool protocol independently
of the execution tool registry. Models may request:

- `read_project_file`: read one of up to eight explicitly selected relative
  project file paths. Paths and resolved links must stay inside the project.
  Reads are limited to 32 KiB and report truncation; binary files are refused.
- `inspect_block`: inspect an installed, supported Goal block contract.
- `validate_proposal`: run the same scope, lock, revision and definition checks
  used for proposals, without storing a proposal, applying edits or executing a
  workflow. Start-readiness errors are reported separately from draft validity.

Authoring cannot run commands, write project files, change grants, accept
proposals or start execution. Running-loop tool selections grant none of these
authoring capabilities. Each inspection and validation failure appears in chat.

Every final proposal receives a non-executing validation pass. One automatic
response correction may use the returned error, with the original grant intact.
A request is bounded to six model calls, with inspection unavailable on the last
call. Every attempted call contributes to authoring usage; unavailable cost is
counted separately. Cancellation is checked before proposal persistence even if
an adapter returns a response after being aborted.

## Response reliability and diagnostics

Authoring streams progress into the persisted request, coalesced to at most one
write per 750 ms while content arrives. The UI can show waiting, thinking,
receiving and validation states, elapsed time and received character counts.
Reasoning text is neither persisted nor displayed; its character count is kept
for diagnosing reasoning-only output. Closing chat does not stop delivery.

Each attempt retains its raw answer (bounded to 64,000 characters with explicit
truncation), completion reason, usage, timing, response mode, validation error
and available transport metadata. Partial answer text survives a timeout. Empty
answers, output-limit exhaustion, malformed JSON and provider refusals are
distinct diagnostic outcomes. Provider refusals do not trigger correction.

For OpenRouter, authoring checks advertised `supported_parameters`, using a
cached public catalogue when saved capability metadata is absent. It requests a
strict JSON schema where `structured_outputs` is advertised, or JSON mode where
only `response_format` is advertised. Schema requests restrict provider routing
to endpoints that support the parameters. Other adapters use their supported
schema integration or explicit prompt-only mode. See the
[OpenRouter structured-output documentation](https://openrouter.ai/docs/guides/features/structured-outputs).

The closed schema keeps string replacements (including YAML) in native
`valueText` strings, avoiding double escaping. Non-string values use `valueJson`;
exactly one is populated and the host decodes it before normal validation. Available edit addresses are
derived from the current draft, scope and locks, and constrained in the schema
when the list has at most 500 entries. Internal graph-inspection fields are not
advertised as editable. Exact criteria/test value formats are included in the
edit contract. The existing restriction on tools that enqueue work or read
unrelated runs/references is checked during proposal validation, so the model
can correct it before review. Schema conformance never replaces semantic or permission checks.

An explicit provider rejection of format support permits one visible, counted
fallback to prompt-only output within the same six-call ceiling. Invalid
schemas, authentication failures and timeouts do not silently downgrade.

Correction is a focused final-answer request: it retains the definition, edit
contract, grant, locks, relevant block contracts and recent evidence, while
omitting the full catalogue, examples and conversation history. It cannot request
tools. Its output budget is 4,096 tokens with a 90-second hard limit, compared
with 12,000 tokens and 180 seconds for ordinary authoring calls. Both use a
90-second idle limit that resets when the provider streams progress.

## Verification

Run `npm run verify:goal` for controller and boundary tests, and `npm run build`
for the production renderer. `npm run verify:goal:authoring-ui` uses the real
React page and authoring controller with a deterministic model boundary. It
requires Playwright, optionally located by `FLYT_PLAYWRIGHT_ROOT`, and accepts
`FLYT_BROWSER_EXECUTABLE` for an installed Chromium browser.

The browser check covers conversational responses and memory, read/validation
traces, step proposal acceptance, field-scope rejection, an emptied field scope
refusing to send, reload persistence, execution-setting review and narrow
layout. It writes screenshots under
`docs/reviews/goal-authoring-chat`. This test makes no paid provider calls and
does not establish model quality or runtime verification of a designed loop.

For an explicit paid provider check, set `FLYT_VERIFY_SETTINGS` to an existing
Flyt settings file and run `node scripts/verify-goal-authoring-live.mjs`.
`FLYT_VERIFY_MODEL` defaults to `z-ai/glm-5.3-flash`. The check creates a temporary
draft, requests a security-review design and requires a proposal to pass static
start-readiness validation (or a clarifying question). It never publishes or
starts a Goal. Diagnostics are written to `docs/reviews/goal-authoring-live.json`;
credentials are kept in memory and excluded from the report.

On 2026-09-06, the live security-review design check passed with
`z-ai/glm-5.3-flash`: one schema-mode call, 62.3 seconds, $0.0010743 reported cost,
and a proposal with `valid: true`, `readyToStart: true`, `runtimeVerified: false`.
This is evidence that creation completes, not a guarantee of audit quality or
successful runtime execution. Earlier address, readiness and encoding failures
are retained in the neighboring `goal-authoring-live-*-failure.json` reports.
