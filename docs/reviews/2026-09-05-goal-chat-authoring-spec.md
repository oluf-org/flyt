# Goal authoring through chat and a visual loop

Date: 2026-09-05. Status: proposed product and engineering specification. This document does not implement the feature. It builds on the current Goal implementation and the user's request for scoped chat edits, human review, visible AI changes, circular visualization, and fixed execution choices.

## Recommended experience

Make chat, the graph, and the field editor three views of one versioned Goal definition. Chat proposes structured changes; it never replaces the definition by rewriting a free-form document. The user can select an exact field or text range, ask for a change, and trust that the application rejects changes elsewhere.

Use a spacious circular overview for one iteration, with setup outside the circle and one contextual sidebar on the left. General loop information and selected-step editing share that sidebar. Authoring chat opens only on request in a compact floating “Change request” modal. Keep the existing workflow engine as the execution authority. Graph coordinates have no execution meaning.

The initial generated draft has normal fields, with a draft-level “AI draft · not reviewed” label. Every subsequent AI change is visibly marked until reviewed. A review decision and a runtime verification result are different facts.

## 1. Screen layout

At a wide desktop width, use two regions: one resizable contextual sidebar on the left and a graph canvas that takes the remaining width. There is no permanent chat column or separate right inspector. This layout supersedes the original three-column sketch.

| Region | Contents and behavior |
|---|---|
| Left: Loop overview, no node selected | Planned objective, acceptance checks, setup summary, step count, model/harness bindings, workspace, locks, limits, and review readiness. During execution, include actual progress, usage, current/best result, and stop reason. Group secondary details into expandable sections. |
| Left: Step inspector, node selected | Replace the overview with that step's editable fields, model and execution environment, input/output contract, tools, workspace, locks, and before/after changes. “Back to loop overview” clears selection. |
| Main: Loop canvas | Setup strip above the circular iteration overview; objective and iteration status in the center. Selecting a node updates the left sidebar. Clicking empty canvas clears selection and restores the overview. Draft/running revision switch is explicit. |
| Floating: Change request | Visible only after a user trigger. Contains the small title, close control, quoted scope, conversation, proposal/error messages, and composer inside a single compact chat-window border. It overlays the page without reserving a column or resizing the graph. |

Start with a sidebar around 280–340 px wide and let the canvas grow. Keep the no-selection overview concise enough to scan; detailed logs and evidence open on demand. Node changes update sidebar content without changing its width or recentering the graph. Preserve unfinished direct edits and surface validation issues rather than losing text when selection changes.

### Floating request window

- Open through the header's “Change request” action, “Ask AI to change…” on a field or selection, or the empty-state “Describe your loop” action. Merely selecting a node does not open chat. Existing Goals load with chat closed.
- Render one compact dialog, approximately 440–520 px wide on desktop, with height driven by its contents up to roughly 70% of the viewport. Scroll the conversation inside it and keep the composer available. Use only the chat window's own border, a subtle shadow, and a small “Change request” title; no large outer modal card, padded frame, or second header. A transparent backdrop can provide modal focus/pointer behavior while leaving the loop visible.
- Place the dialog over the canvas, keeping the quoted node and its sidebar field visible where space allows. Clamp it to the viewport; responsive sizing takes priority over the preferred desktop width. Opening and closing must not reflow the underlying layout.
- Focus the composer on open. Trap keyboard focus inside the modal and return it to the trigger on close. Close and Escape dismiss it without discarding the composed text, quoted targets, request history, or pending proposal. While the modal is open, Escape closes it first; it does not also clear node selection.
- Closing does not approve a proposal, cancel a submitted request, or clear change indicators. Keep in-flight progress and pending-review counts accessible through the header and affected nodes while the window is hidden. Completion never automatically reopens it. Cancellation, when needed, is a separate explicit action.
- Clicking a quote or “Inspect changes” closes the modal, selects the target, and focuses the relevant sidebar field/diff. Reopening restores the conversation and composer. Scope is fixed when submitted and never follows later graph selection.
- Keep conversations and composer drafts scoped to their Goal. Switching Goals cannot carry a quote into another definition. On reload, restore saved request content but keep the window closed until triggered; revalidate stale quotes before submission.

The header shows Goal name, draft/review status, active revision, “Change request” with pending activity when applicable, and the appropriate Review and start / Pause / Resume action. During execution, show “Running revision 4 · Draft revision 5” rather than implying edits already changed the run.

Use the current app's Slate & Sage typography and surface tokens. Color is supplementary: pair changes, locks, selection, and runtime statuses with text or icons. Avoid putting full prompts, logs, and every statistic directly on graph nodes.

At medium widths, the contextual sidebar can collapse into a drawer. At narrow widths, switch between Steps and Loop details; selecting a step shows its inspector in the details view. Chat remains an on-demand dialog, sized to the available viewport above the on-screen keyboard, with its close control and composer reachable. Retain selection and pending requests across these layouts. An ordered step list is always available and provides a keyboard-accessible equivalent to the circle.

## 2. Creating the first draft

1. User triggers “Describe your loop” to open the floating request window and describes the objective and any fixed requirements, for example: “Create a folder once. Draft with model A. Use the GPT harness for implementation. Never change the evaluator.”
2. The authoring assistant generates a structured draft and a concise explanation. Unresolved model/harness choices are visible requirements, not silent guesses. Draft generation has no workspace or execution side effects.
3. The user dismisses the request window to inspect the spacious graph. With no node selected, the left sidebar summarizes the planned loop; selecting a node replaces that content with step settings. Fields support direct editing or quoted requests that reopen the modal. Locks can be established before the first generation; the first draft must respect them.
4. Review and start presents the objective, acceptance checks, execution bindings, workspace operations, budget, locks, and unresolved changes. A human explicitly approves the complete runnable revision.
5. Starting creates the run instance and performs setup. Creating a folder during design is never implied by describing a folder operation.

The initial baseline is established atomically when the first complete, validated draft is saved. Streaming partial content remains a preview. Its first materialized fields receive creation provenance but no individual “AI changed” indicators. Changes made after that baseline are highlighted, even before the first execution. Restarting chat or regenerating the draft does not reset this baseline.

## 3. Direct edits and quoted changes

Every field has a stable address, independent of label, graph position, or array index. Example: `iteration/node-implement/instructions`. Node identities persist across rename and reorder and cannot be reassigned by the model.

Provide “Ask AI to change…” on a field, a selected text range, a step, or an explicitly selected group. This action opens the floating “Change request” window with the target attached. Its composer shows removable chips such as “Implement → Instructions → selected sentence”. Clicking a chip dismisses the modal and focuses the original field in the left sidebar. Keyboard selection and the ordered list support the same workflow. Reopening a pending request preserves its explicit targets; changing node selection alone never changes them.

| Selection | Allowed changes |
|---|---|
| Text range | Replace only that range, using a stored field version, exact old text, and range offsets. The rest of the field must remain identical. |
| Field | Replace that field's value. Sibling fields remain identical. |
| Several fields | The union of those exact addresses; no implicit common-parent permission. |
| Step | Explicit editable fields on that step. Moving, deleting, replacing its type, or changing connections requires separately displayed structural permission. |
| Group | Explicit selected descendants and allowed operations, snapshotted when the request is submitted. New descendants do not silently join the grant. |

A quote is a structured reference with a human-readable excerpt, not copied prose that the model interprets as authority. References in assistant messages or tool outputs never grant edit permission.

With no quote, chat may propose changes across unlocked draft fields, but the proposal must display its exact changes and await review. With a quote, the application creates a narrow edit grant. “Make this better” does not widen the grant. Multiple requested fixes can be submitted together as one atomic proposal.

Direct typing saves a human-authored revision. It is not highlighted as an AI edit. If it modifies an unreviewed AI change, preserve that provenance and mark the affected change as human-edited; unrelated AI changes remain pending. Direct edits and chat proposals use the same version and schema checks.

## 4. Hard enforcement of edit scope

This must be enforced in the application backend, not just the assistant prompt or the renderer.

For every request, the backend stores an immutable, expiring edit grant containing the Goal/draft ID, base revision and content hash, policy version, allowed addresses/operations, and optional exact text ranges. The model receives an opaque grant ID and read context. Read context may include the entire loop without granting write authority to it.

The assistant returns typed operations and a rationale. The backend:

1. Authenticates the request and loads the grant and exact base revision.
2. Applies operations to an isolated in-memory copy, never the live definition.
3. Computes its own semantic before/after diff, including defaults, resolved bindings, node identity, structure, and connections. It does not trust the assistant's declared changed paths.
4. Rejects the entire proposal if any change exceeds the grant, violates a lock, changes an indirect dependency of a locked setting, or leaves an invalid workflow.
5. Validates the canonical workflow, references, execution capabilities, workspace rules, and fixed Goal contract.
6. Atomically stores a pending proposal with its diff and provenance. It cannot become an executable revision until the configured human review requirement is met.

No partial application on error. In particular, do not discard an unauthorized operation and silently apply the rest. The assistant must receive an actionable structured error, and the user sees “No changes applied.”

Example response:

```json
{
  "code": "EDIT_OUT_OF_SCOPE",
  "proposalId": "proposal-18",
  "allowed": ["iteration/node-implement/instructions"],
  "violations": [{
    "address": "iteration/node-evaluate/execution/model",
    "operation": "replace"
  }],
  "applied": false
}
```

Other stable errors: `LOCKED_FIELD`, `STALE_REVISION`, `STALE_QUOTE`, `INVALID_WORKFLOW`, `UNSUPPORTED_EXECUTOR`, `REVIEW_REQUIRED`, and `GRANT_EXPIRED`. On a stale revision or quote, require a refreshed proposal; never silently locate a similar sentence or rebase onto a different field. Automatic repair attempts retain the same grant, have a small fixed retry limit, and cannot widen permissions. A dependency conflict is reported with a suggested additional selection; only the human can grant that selection.

All mutation routes must use this validator: chat, visual editor, YAML import, restore, clone transformations, and runtime self-redesign. The authoring assistant gets definition-edit tools only; it cannot bypass them through shell/file tools, direct IPC calls, or an arbitrary save-source endpoint. Audit files and policy storage are host-owned. If execution tools can write application metadata, locks cannot be advertised as enforced; keep that storage outside their writable scope.

## 5. Change indicators and review lifecycle

| State | Presentation |
|---|---|
| Initial creation | Normal field styling; one draft-level “AI draft · not reviewed” label. |
| Later AI modification | Persistent “AI changed” badge and a subtle accent background on the field. |
| Later AI addition | “AI added”; new node receives the same label. |
| AI deletion | Retained removal row/tombstone in the proposal and graph review overlay until resolved. |
| Human edit | Normal field styling, with authorship available in history. |
| Accepted AI change | Normal styling; provenance and before/after values remain in history. |
| Rejected AI change | Proposed value removed; rejection recorded; approved value preserved. |

Clicking a badge selects its node and opens before/after values, rationale, author, request/quote, and Accept / Reject / Edit in the left sidebar. Review remains available with chat closed; “View request” explicitly opens the corresponding conversation in the floating window. Opening a field, viewing a diff, closing chat, restarting the app, or beginning a new run does not clear indicators. No-op operations produce no change badge. Restoring an older revision through AI is still a new AI change.

Default to atomic Accept proposal / Reject proposal. Individual acceptance is supported only when the backend proves the resulting revision is valid and independent of remaining operations; otherwise group the dependent changes. Never create a half-valid graph through partial approval. A proposal awaiting review is separate from both the active run revision and the human-editable draft.

Track review against immutable content hashes. If the AI changes an accepted value again, it becomes unreviewed again. If a human changes the draft while a proposal is pending, accepting that stale proposal fails and requires a refreshed proposal. Repeated proposals retain their own provenance; the displayed diff is against the current reviewed baseline.

## 6. Locks and fixed execution choices

Support “Lock from AI” at a field, step, group, and Goal contract level. Locks are host-owned policy records, separate from editable recipe fields. The assistant cannot unlock, delete, move around, or replace a locked target to evade a lock. Renaming or creating a look-alike node does not transfer identity or permission.

A full step lock covers existence, type, configuration, position/required control-flow participation, connections, and inherited settings. A field lock pins that field's effective value and the continued existence of its owner; it does not claim to freeze all surrounding behavior. Show lock scope explicitly. A locked required task cannot be bypassed by adding a branch or changing its parent condition. Enforce this with conservative structural restrictions in the first version, rather than attempting to prove arbitrary workflow equivalence.

Humans can deliberately unlock a draft setting through an explicit control; the action is logged. Once an instance starts, contract-level values such as objective, evaluation contract, maximum authority, and total budget cannot be changed in place. Changing those creates a new instance with an explicit new contract and compatibility review of carried-over evidence. Recipe edits use the existing iteration boundary.

### Model and harness are separate settings

Represent each step's execution binding with:

- Execution mode: ordinary Flyt model step, supported agent harness, or deterministic operation.
- Provider/account reference and exact model identifier where applicable.
- Harness ID, installed version or resolved version evidence, and capability requirements.
- Model parameters, tool authority, workspace scope, timeout, and optional explicit fallback policy.
- Inheritance source and whether the effective setting is locked.

“Use model A for this task” pins the resolved model/provider binding, not the current value of a mutable global default. “Use the GPT harness” means choosing a particular installed execution integration, not merely choosing a GPT model in a dropdown. Until the exact integration is selected, this is an unresolved requirement. The existing Codex CLI adapter is a potential integration to assess, not proof that this per-step harness contract already works.

The UI separates “Model” and “Runs with”. A locked model must never silently fall back. If the provider disappears or the selected harness cannot meet required tools, cancellation, workspace, result, or accounting guarantees, block dispatch with a specific error. Runtime records include requested and effective bindings. Every step and descendant uses the same policy resolution and shared Goal budget. Harness-internal calls must not be reported as one fully measured model call when their usage is opaque; show unavailable accounting and reject hard guarantees the integration cannot enforce.

Authoring-assistant model selection is independent of execution models. Authoring calls have separately displayed usage; they must not silently consume or bypass the run budget.

### Folder operations

Offer a typed Create workspace setup operation with parent folder, safe folder name/template, create-once semantics, and collision policy. Default to a dedicated instance directory and fail on an unexpected existing target. Record an intent and ownership marker so a crash after creation can resume without making a second folder. Validate canonical paths and ancestor links; do not overwrite existing content. Resume reuses the recorded directory.

Workspace groups inherit scope into descendants. Users can lock the folder binding, operation, or full setup group. Changing setup after it completed requires a new instance or a separately reviewed migration; it never silently reruns side effects. Folder focus remains honestly distinct from enforced filesystem isolation. Strict mode stays unavailable until the selected provider can enforce it.

## 7. Circular graph semantics

The circle visualizes one pass through the top-level recipe. It does not create another execution language.

- Show setup as a separate entry strip connected to the first iteration step, clearly labelled “Once”.
- Lay top-level sequential steps clockwise, with numbered nodes and arrow direction. Center the short objective and current iteration/revision.
- Show the runtime-owned verification/commit/continue decision as a distinct system node. Its continuation edge returns to the recipe entry; its exit edge leads to the actual stop outcome. Authored evaluator steps remain separate from this decision.
- Keep parallel branches and If/Until/Repeat containers collapsed on the overview, with type and child count. Expand them into a local structured view or inspector. Do not draw parallel children as consecutive work.
- A locked node has a lock marker. A changed node shows the count of pending field changes. Execution state (queued/running/done/failed/skipped/waiting for human) is visually separate from change state.
- Keep node positions stable across runtime updates. Selection never reorders execution. Reordering is an explicit structural edit with a preview and validation.
- Start with a practical overview of roughly 3–8 top-level nodes. Larger recipes use collapsed named groups and an ordered list; never silently regroup the executable definition for visual convenience.

The left sidebar's no-selection overview shows actual iterations, acceptance results, calls, known/unknown spend, elapsed time and limits, current/best result, and stop reason when running. Before execution, emphasize the planned objective, setup, steps, checks, bindings, workspace, limits, and unresolved requirements; show “Not run” rather than invented performance. Selecting a node replaces this overview with its inspector; “Back to loop overview” restores it. Keep only essential run status in the header while inspecting a step. Logs and detailed evidence are drill-downs.

## 8. Human verification during execution

Definition review and result verification need separate controls. “Accept edit” means the user accepts a configuration change; it does not mean the resulting artifact passed an evaluation.

Default policy: review all AI definition changes before activation. While an iteration runs, approved edits queue for the next boundary. A pending unreviewed proposal pauses at that boundary with “Waiting for review”; it never modifies the active iteration. The user can reject it and continue with the previous approved revision. Automatic activation may be offered later for explicitly allowed unlocked areas, with the same hard edit-scope and lock checks and persistent unreviewed-change indicators.

Add an optional Human review step for results. It pauses durably with an immutable artifact snapshot, evidence, and a precise decision: Approve result, Request changes, or Stop. Request changes can quote a region in the artifact and feed a bounded correction into the next iteration. This is a separate target type from a recipe-field quote. Editable artifacts need stable IDs/content hashes and a matching scoped patch validator; until supported, offer feedback without claiming exact artifact-edit enforcement.

Human review receipts bind to instance, iteration, recipe revision, artifact hash, and evidence revision. If the artifact changes, approval is invalidated. Resume and restart retain pending reviews; repeated clicks cannot execute a step twice. Approval cannot override a failed mandatory runtime check unless the original contract explicitly defines a human override rule.

## 9. Data and API additions

Keep one canonical semantic definition, compiled to the existing stack representation. Graph layout and collapsed state are presentation metadata and excluded from executable hashes. Persist stable node IDs and address mappings; reject ambiguous imports or duplicate IDs.

Maintain a separate per-Goal authoring UI state: selected node or overview, sidebar width/collapse state, request-window visibility, composer draft, explicit quote targets, and active conversation/request ID. Persist recoverable content independently of modal mounting; window visibility defaults to closed on reload. Closing or unmounting the modal must not interrupt request delivery or lose a proposal. Selection and window visibility are presentation state, never edit authority.

| Record | Required data |
|---|---|
| Draft | ID, definition/schema version, first-draft baseline, current revision/hash, approved revision/hash. |
| Execution policy | Immutable instance contract, per-step bindings, locks, allowed operations, policy revision/hash. |
| Edit grant | Target definition, actor identity, base revision/hash, policy hash, explicit scope, text anchors, expiration. |
| Proposal | Grant ID, operations, computed diff, rationale, authorship, request ID, status, validation result. |
| Review receipt | Proposal or result reference, exact hashes, human decision, timestamp, applicable instance. |
| Runtime event | Instance/iteration/node identity, pinned definition and policy, effective executor/workspace, usage, evidence. |

Suggested commands (names provisional): `goal:author-message`, `goal:grant-edit`, `goal:propose-edit`, `goal:review-proposal`, `goal:edit-fields`, `goal:set-lock`, `goal:review-result`. Bind them through the existing API/preload allowlist. The backend derives actor identity; a model-supplied `author: human` is never trusted. Transactions are idempotent by request ID, and accept operations compare current draft and policy versions atomically. Approval consumes the proposal/grant for application; replay returns the same receipt.

Use append-only proposal/review history plus an atomic state projection, following current Goal persistence patterns. Persist chat references with bounded context summaries; reload authoritative definitions and grants for each edit request rather than reconstructing them from conversation text.

## 10. Changes needed in the current implementation

| Existing area | Required extension |
|---|---|
| `src/v2/GoalPage.jsx` | Build a two-region layout with one contextual left sidebar and an expanding graph/list canvas. Add an on-demand `ChangeRequestDialog`, shared overview/step-inspector selection state, sidebar review surface, and runtime settings/evidence. Remove permanent chat-column assumptions. |
| Authoring UI state and dialog lifecycle | Keep request/conversation state outside the modal component. Add explicit triggers, close/reopen persistence, pending activity indicators, focus management, quote-to-inspector navigation, and responsive placement without graph reflow. |
| `src/v2/BlockEditor.jsx` | Shared stable field addresses, quote actions, lock controls, provenance badges, and structured field editing. Retain the detailed editor as a graph drill-down. |
| `core/goalController.js` | Add draft/proposal/review records, scoped transactions, locks, and human gates. Current whole-source and command revisions have version checks but no quoted-field authority. |
| Fixed worker validation and `core/kernelHost.js` | Replace the single Goal-wide worker restriction with host-resolved per-step policy while retaining strict dispatch checks and shared budgets. Current validation rejects block model overrides. |
| `core/adapters/codexCli.js` and execution adapters | Assess harness capabilities and expose truthful per-step execution contracts; existing adapter availability is insufficient by itself. |
| Canonical stack commands and runner | Support validated execution bindings, deterministic workspace setup/group scope, and durable review waits through the existing engine. |
| `core/api.js`, Electron IPC/preload | Add typed authoring/review commands and close bypass paths. Keep actor identity and edit-grant creation outside model control. |
| Goal events and persistence | Project field provenance and review queues across reload, crash recovery, pending revision activation, and history. |

Migrate existing Goals by treating their stored recipe as an existing baseline, with no fabricated field-edit history. Preserve their contract worker as an explicit inherited binding. Existing running instances retain their recorded execution/review policy; enabling new human-review requirements occurs through an explicit migration at a safe boundary. Do not silently reinterpret old instances.

## 11. Delivery sequence

1. **Enforcement foundation:** stable addresses, semantic diff, edit grants, field/structural locks, atomic proposals, review receipts, bypass-route protection. Ship with existing editor first.
2. **Floating chat and human editing:** initial draft generation through an explicit trigger, compact request modal, quotations, close/reopen persistence, focus management, direct edits, persistent change indicators, sidebar before/after review, and reload recovery. Requests continue independently of modal visibility.
3. **Spacious visual loop:** two-region layout, contextual left sidebar with planned-loop overview when no node is selected, selected-step inspector, circular overview, expanded container view, accessible list, revision selection, and real runtime event/stat projections. Verify that chat never reserves a column or resizes the graph.
4. **Fixed execution systems:** per-step model/harness bindings, capability validation, deterministic folder setup, workspace inheritance, and human result gates.
5. **Integrated release verification:** actual app creation, a rejected out-of-scope proposal, an accepted scoped edit, locked execution, setup once, successful iterations, and review/resume recovery.

The complete requested experience needs all five stages. A visual-only editor is not sufficient to claim that quoted edits or fixed systems are enforced. Stronger evaluation/benchmark optimization from the earlier roadmap remains a separate feature; the interface must accurately display the checks that actually exist.

## 12. Acceptance and end-to-end verification

Automated boundary tests must prove:

- A request for field A that changes A and B returns `EDIT_OUT_OF_SCOPE`; neither field changes, and the assistant receives the error.
- A quoted sentence replacement preserves every character outside its range. Duplicate text and stale offsets never cause heuristic retargeting.
- Indirect changes through parent replacement, defaults, renamed/deleted nodes, reordered arrays, import, restore, runtime redesign, or mutable execution references cannot bypass locks or scope.
- The initial generated draft has zero per-field change badges; every subsequent AI addition, deletion, or modification has correct persistent provenance.
- Human edits are distinguished from AI edits; opening a diff does not accept it; reload preserves unresolved changes.
- Partial acceptance cannot create invalid workflow references. Duplicate proposal/approval submission is idempotent. Stale approval fails atomically.
- A locked exact model never falls back; an unavailable harness refuses dispatch; descendants inherit authority and accounting policy.
- Workspace setup is idempotent across crashes and resume. New instance behavior and folder collision/link checks are verified.
- Active iterations keep their pinned recipe. Human gate approvals bind to exact artifacts and are invalidated by changes.
- Circle/list ordering matches the canonical executable structure; parallel/container semantics and runtime states are faithful.
- The default layout has one contextual left sidebar and no permanent chat column or separate right inspector. No selection shows planned-loop information; selecting a node shows its settings; clearing selection restores the overview without losing saved or unfinished field edits.
- Chat is hidden until explicitly triggered. Opening/closing does not change canvas bounds or node positions. The modal has only its own compact chat boundary and small title, with no oversized outer frame.
- Close/reopen and reload preserve composed text, quote targets, conversation, and pending proposals. Submitted requests finish with the modal closed; activity is visible without auto-opening chat. Switching Goals cannot leak request context or quote authority.
- Keyboard focus is trapped and restored correctly. Escape dismisses the modal without clearing the graph selection. Quote navigation dismisses the modal and focuses the target field. Desktop and narrow layouts keep the composer and close control reachable.

Actual Electron acceptance scenario:

1. Trigger the floating request window and author a small two-pass Goal with folder setup once, one locked model binding, and explicit runtime checks. Close it and verify the graph uses the released space and the left sidebar shows the planned-loop overview.
2. Select a node to inspect its normal initial fields, then quote one instruction field to reopen “Change request”. Compose a request, close/reopen to verify preservation, and submit it. Confirm graph geometry is unchanged by opening chat and that clearing node selection restores the overview.
3. Inject an intentionally invalid response changing that field plus the locked model. Confirm visible rejection, an error delivered to the assistant, and identical stored state.
4. Produce a valid scoped proposal while chat is dismissed. Confirm the pending indicator, reopen the request, and use “Inspect changes” to return to highlighted before/after values in the left sidebar. Directly edit a different field and verify stale proposal handling before accepting a refreshed proposal without requiring chat to remain open.
5. Start the approved definition. Verify setup only once, the effective model/harness identity, actual graph events, and budget reporting.
6. Exercise a durable human review gate, restart the app while waiting, resume from the exact evidence, and finish at least one successful loop with an achieved outcome.
7. Save screenshots, definition/proposal/review records, effective execution evidence, and test results. Mocked executor checks supplement, but do not replace, the successful real-app run.

## Recommended defaults and remaining product choices

Recommended defaults are an on-demand compact “Change request” modal, one contextual left sidebar that opens on the planned-loop overview, a spacious circular canvas plus an accessible ordered list, strict quoted scope, atomic proposal review, all AI definition changes reviewed before activation, field badges after first draft creation, and explicit locks from AI. The earlier three-column mockup is superseded by this layout specification.

The main unresolved integration choice is the exact meaning of “GPT harness”: identify the desired installed executor and its required capabilities during implementation. Also decide whether the first release needs editable artifact quotes as well as definition quotes, and whether automatic activation of narrowly permitted self-redesign is needed immediately. Neither decision weakens the required rejection of edits outside an authorized area.
