# Goal UI implementation and live verification

Implemented 2026-09-05. The linked implementation report described the existing runtime; the adjacent `2026-09-05-goal-chat-authoring-spec.md` supplied the UI design. That pre-existing, untracked specification was left unchanged.

## Delivered

- A circular overview of the canonical iteration, separate setup strip, runtime-owned verification node, and equivalent ordered list. Parallel and conditional containers retain their structure; selecting their children opens the contextual inspector.
- One left sidebar for overview, step configuration, pending proposal review, and runtime evidence. Its width can be changed with pointer or keyboard and is remembered. Narrow layouts have Steps / Loop details navigation.
- A compact, on-demand Change request dialog. Native modal focus containment, Escape dismissal, trigger focus restoration, and quoted-field navigation keep interaction predictable. Opening chat does not resize the graph. Composer text and quotes survive close/reopen, draft switching, and reload; requests complete independently of dialog visibility. Cancellation is explicit.
- Saved authoring drafts and history, separate from active Goal recipes. Direct field edits keep a revision-bound local buffer, survive selection changes, and fail closed if another editor changed the draft. Draft and running recipe views are explicit. Canonical runtime node states, current and best artifacts, checks, usage, setup completion, and stop reasons remain inspectable.
- Host-side edit grants with exact addresses and optional text ranges, semantic before/after diffs, atomic accept/reject, version and policy checks, persistent pending indicators, and field/step locks for AI definition proposals. Out-of-scope operations reject the entire proposal. Whole-source operations cannot bypass a scoped grant or locked structural dependencies. Human edit buffers are never silently rebased.
- The authoring model has no workspace execution tools. Its calls and known/unpriced usage are displayed separately from the Goal budget. Duplicate request submission is idempotent; cancellation and application shutdown abort active authoring calls. Host transactions use a process lock and atomic state replacement.
- Review before launch/publication, exact Goal model/provider resolution, and human review of runtime recipe proposals before their next iteration. New authoring Goals pause at the boundary for pending draft review. Older Goals retain their existing runtime policy.
- Optional durable human result review, with receipts tied to the iteration artifact digest. Approve, request changes, and stop are distinct decisions. Approval cannot make failed mandatory checks pass. Clone instances receive independent authoring state, including inherited authoring locks.
- Existing file checks, candidate workflow tests/template, tools, limits, detailed BlockEditor editing, recipe restore, and evidence inspection remain accessible.

## Verification

- `npm run build`: passed.
- 139 targeted tests passed, zero failures or skips: Goal controller/foundation/authoring, RunController, resume, block editor, Loop kernel parity, workflow context, shell, and model selection. [Full results](goal-ui-e2e/tests.txt).
- The final canonical-node-status projection change also passed the 13 authoring/canvas tests. [Results](goal-ui-e2e/authoring-tests.txt).
- `git diff --check` passed using the repository's configured line-ending handling.

The live test used the real Electron renderer, preload/API, Goal controller, canonical kernel, and OpenRouter, with mock mode disabled. The profile and runtime data were isolated from the user's already-running app.

- Model: **z-ai/glm-5.3-flash**, resolved provider **openrouter**.
- Goal: **f8166e5c-fdce-4817-9d60-4caa13c488e1**.
- One real authoring request proposed a change to the quoted instruction field while chat was closed. It required explicit acceptance.
- Keyboard focus containment, unchanged canvas bounds, draft-switch isolation, close/reopen persistence, reload with chat closed, and the narrow dialog were exercised in the renderer.
- Setup ran once. Iteration 1 produced `ALPHA` (one of two checks); iteration 2 produced `ALPHA BETA` (both checks).
- The app was closed and reopened while waiting for the first human result review. Both review receipts survived and the loop resumed without repeating setup.
- Final status: **achieved**, with **2 iterations**, **3 execution calls**, **$0.001272975** reported execution cost. Authoring used **1 call**, **$0.00031665**, separately recorded.
- After the final display correction, the achieved instance was replayed through Electron without model calls, asserting that the canonical step displayed **Done**.

Evidence: [state, proposals, reviews, and best result](goal-ui-e2e/result.json), [achieved view](goal-ui-e2e/goal-result.png), [chat](goal-ui-e2e/change-request.png), [pending changes](goal-ui-e2e/pending-changes.png), [human review](goal-ui-e2e/human-review.png), [narrow dialog](goal-ui-e2e/narrow-chat.png), [memory](goal-ui-e2e/goal-memory.png).

Run `npm run verify:goal` for the focused suite. For live verification, set `FLYT_PLAYWRIGHT_ROOT` to an installed Playwright package directory and run `npm run verify:goal:app`. The default verification model is GLM 5.3 Flash; `FLYT_VERIFY_MODEL` overrides it. This command makes real provider calls.

## Boundaries

Execution still uses the existing Goal-wide model binding and Flyt model-step executor. Per-step harnesses, arbitrary nested workspace groups, and strict filesystem isolation are not implemented; the UI states these limitations and does not offer an executor it cannot enforce. Authoring locks govern definition proposals, not arbitrary file/shell access under Folder focus. Partial proposal acceptance and exact artifact-region editing are not exposed. Human result feedback is bounded text, not a claim of scoped artifact patching.

The live scenario is a deterministic two-pass acceptance fixture; it verifies the loop and UI plumbing, not code-review quality or statistical optimization. Restart the normal Flyt instance to load the new main-process APIs.

Automatic approval review rejected an optional cleanup command for two temporary verification settings files and an obsolete failure screenshot, reporting only “blocked by policy.” Those files were left in place. Successful subsequent verification runs removed their own copied settings in the harness's normal cleanup path.
