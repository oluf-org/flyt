# Chat images: repository audit and implementation specification

Date: 2026-09-10. Status: proposed implementation, based on source inspection and official provider documentation. No application behavior has been changed by this audit.

Follow-up implementation: the landing screen's Add to Loop mode, queue controls, enqueue handler, prompt conversion helper, receipt, and dedicated styles/test have now been removed. The findings below describe the pre-removal audit. Image support is still proposed; legacy backlog APIs and stored tasks are outside this UI cleanup.

The feature should let someone attach images once and use an existing workflow without editing its nodes. The implementation needs durable image storage, composer support, attachment propagation through the scheduler, provider encoding, and automatic capability handling. Adding a file picker alone would leave most of that path text-only.

## What “Add to Loop” does today

The landing button switches the composer into a queue mode; it does not submit immediately. Sending in that mode calls `DailyRoot.enqueue`, creates a project if needed, converts the prompt into a backlog task, and calls `window.flyt.addTask`. The backend handles `task:add` by calling `Backlog.add`, which persists a `.task.md` file. The first prompt line becomes the title, the complete prompt becomes the goal, and the chosen starting effort is saved.

It does not run the selected workflow, preserve that workflow's model selections, start the old supervisor, or create a current Goal. The receipt says the task has not started. However, legacy `loop:start` and supervisor infrastructure still exist: this is a real backlog write, not a disabled button, and a running legacy consumer may subsequently pick up the task.

Evidence: [landing mode switch](D:/electron/llm-flow/src/Lander.jsx:355), [enqueue handler](D:/electron/llm-flow/src/v2/DailyRoot.jsx:388), [prompt conversion](D:/electron/llm-flow/src/v2/workflowUx.js:55), [task API](D:/electron/llm-flow/core/api.js:1472), [legacy supervisor entry](D:/electron/llm-flow/core/api.js:2019).

Recommendation: remove the landing queue mode, its starting-effort controls, receipt, and handler. Keep the workflow launch action. Do not rename the same handler to “Add to Goal”: Goals require a definition and acceptance criteria, and this handler creates neither. Keep historical backlog data intact. A separate retirement pass should inventory remaining backlog APIs, CLI commands, supervisor entry points, old chat, and documentation before deleting backend compatibility code. Removing this UI is not equivalent to retiring that entire subsystem.

## Current gaps

| Layer | Finding | Required change |
| --- | --- | --- |
| [Landing composer](D:/electron/llm-flow/src/Lander.jsx:193) | Local text state; text required; clears immediately after invoking submission; no image input handlers | Shared attachment composer, image-only submission, acknowledgment before clearing, drafts per project |
| [Replies and questions](D:/electron/llm-flow/src/v2/Work.jsx:12) | Separate textareas; reply clears before asynchronous success | Use the same composer for replies and free-form node answers; leave approval buttons as approvals |
| [Desktop bridge](D:/electron/llm-flow/electron/preload.cjs:87) | Workflow launch, reply, and answer carry text | Add typed attachment references and narrow import/read operations in preload, main-process bindings, and backend contracts |
| [Workflow API](D:/electron/llm-flow/core/api.js:429) | `input` and `userMessage` are text; reply starts a new immutable run using the previous assistant result/summary | Persist attachment ownership and explicitly carry references into the continuation run |
| [Scheduler](D:/electron/llm-flow/kernel/src/plugins/stack-runner.ts:500) | Sequence replaces input with the previous output string | Carry attachments independently of changing text, including parallel joins and nested invocations |
| [Block contract](D:/electron/llm-flow/kernel/src/blocks/types.ts:70) | `BlockRun.input` and `BlockOutcome.output` are strings | Add an optional attachment envelope while preserving old text APIs |
| [Model messages](D:/electron/llm-flow/kernel/src/types.ts:33) | `Message.content` is a string | Add ordered, provider-neutral text/image parts with durable asset references |
| [Session replay](D:/electron/llm-flow/kernel/src/session/jsonl.ts:390) | `deriveMessages` coerces event content to strings | Reconstruct image parts losslessly; update events, projections, restart/resume, and inspection |
| [Model facts](D:/electron/llm-flow/kernel/src/models/capabilities.ts:31) | Image modality facts and attachment budget hooks exist | Connect facts to routing and real images; distinguish model support from adapter support |
| [Catalog ingestion](D:/electron/llm-flow/core/modelSource.js:213) | OpenRouter mapping retains prices, context length, and tools, but drops image modalities | Preserve input modalities, provenance, freshness, and provider/model identity through normalized facts |
| [Provider seam](D:/electron/llm-flow/kernel/src/plugins/llm-adapters.ts:120) | Translates text messages to OpenAI-compatible shape | Resolve scoped assets and encode images per selected provider, including each fallback attempt |
| [Anthropic transform](D:/electron/llm-flow/core/adapters/transforms/anthropic.js:3) | Converts content with `String(message.content)` | Serialize actual image blocks without breaking tool results or signed reasoning replay |
| [CLI adapters](D:/electron/llm-flow/core/adapters/codexCli.js:37) | Codex and Claude Code receive plain prompt strings | Implement and verify native image transport for each CLI; do not paste filenames into prompts as a substitute |
| [File tool](D:/electron/llm-flow/core/tools/read_file.js:107) | Binary files are detected rather than visually understood | Add scoped image inspection through the existing tool/service boundary |

The current desktop root mounts `DailyRoot`. The old [backlog chat](D:/electron/llm-flow/core/chat.js:1) and [ChatSidebar](D:/electron/llm-flow/src/ChatSidebar.jsx) are separate from workflow chat. Implementing images only in `chat:send` would miss the current landing screen entirely. Goal authoring in [GoalWorkspace](D:/electron/llm-flow/src/v2/GoalWorkspace.jsx) is another separate composer and requires an explicit follow-on integration if image-based Goal instructions are included.

## How people add images

Ship these entry methods together:

1. Paste a screenshot or copied image with Ctrl/Cmd+V. Read image `ClipboardEvent` items; preserve accompanying plain text once. Handle clipboard payloads containing duplicate bitmap/HTML representations without attaching the same image twice.
2. Drag one or several image files from Explorer/Finder onto the composer or active conversation. Show a drop overlay, preserve ordering, and prevent navigation when files are dropped. Restrict the handler so it does not break workflow-builder drag and drop. Explain rejected files individually.
3. Use an “Attach images” button and a native or browser multi-file picker. Make it keyboard accessible and reset the picker after selection so the same file can be selected again.
4. Support an explicit “Paste image” menu action as a desktop fallback where DOM paste events do not expose the bitmap. Read the clipboard only on that user action, not through polling.

Electron provides [clipboard image reads](https://www.electronjs.org/docs/latest/api/clipboard). For disk-backed web Files, use a narrow preload helper around [webUtils.getPathForFile](https://www.electronjs.org/docs/latest/api/web-utils), not the retired `File.path` property. Clipboard-created Files can have no disk path and need a bounded byte import. Keep these two ingestion paths behind one asset service.

Add next using the same service:

- “Attach from project” and “Use in chat” on an existing image artifact: reuse or import a durable image reference.
- Explicit “Attach image from URL”: download once and retain a local snapshot. Ordinary pasted URLs remain text. Handle browser image drags with URL-only data through this explicit import route, with failure feedback for inaccessible/authenticated images.
- Screenshot capture and crop/annotation: optional conveniences after screenshot paste works. Capture needs its own platform permission and selection UI. Never make automatic screen capture part of ordinary paste.
- Clipboard file-copy formats, HEIC/TIFF/BMP conversion, and animated-image support: extend only after native platform tests. Do not label every `image/*` format supported merely because the picker permits it.

Start with PNG, JPEG, and WebP. Support a static GIF only when decoding confirms it is static; tell users when an animation is unsupported instead of silently analyzing one frame. SVG needs a dedicated safe rasterization path and should initially be rejected. PDF/video are separate features.

Suggested initial application limits: 10 images per message, 20 MiB per original, 50 MiB total input bytes, and 40 megapixels per decoded image. These are proposed Flyt limits, not provider guarantees. Apply stricter provider request limits after normalization, accounting for encoding overhead, dimensions, count, and available context. Revisit these defaults after memory profiling.

Every attachment gets a thumbnail, name, preparation/error state, remove action, and full-size preview. Allow text plus images or images alone. Keep image-only user text empty in storage; generate a display title such as “Image conversation” without changing the user's request. A node can ask what to do when an image-only request is ambiguous.

Keep drafts and attachment import results bound to their original project/conversation when users switch tabs. Preserve text and images after import, routing, or launch failure. Disable duplicate sends while submitting; clear only the submitted draft after a durable launch acknowledgment. Use a request ID so a lost acknowledgment can be retried without launching twice. Keep Enter/Shift+Enter behavior and respect IME composition. Never discard a draft the user edited while the earlier submission was pending.

## Durable data and message contract

Use a project-scoped immutable asset store, with temporary app-managed draft storage for a projectless composer. Import bytes before allowing Send. At launch, claim the imported assets into the destination project and record references before executing any node. Do not rely on the original file remaining on disk.

Suggested additive contract:

```ts
type ImageRef = {
  assetId: string;          // opaque; authorization also checks ownership
  name: string;
  mimeType: string;
  byteLength: number;
  width: number;
  height: number;
};

type ChatSubmission = {
  requestId: string;
  text: string;
  attachments: ImageRef[];
};

type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; assetId: string };

// Existing string callers remain valid. `parts`, when present, is canonical.
// `content` remains a derived text projection for legacy display/search.
type MultimodalMessage = { content: string; parts?: MessagePart[] };
```

The host must derive MIME type, dimensions, byte length, and ownership itself, rather than trusting submitted metadata. Validate signatures and decoding; normalize orientation and provider copies, stripping unnecessary metadata. Keep the original immutable and create thumbnails/provider variants separately. Record variant hashes and transformations so a crop or resize never silently changes the evidence.

Record image references with `run.created`, the user turn, and each model-visible message. Session replay must recreate those references without changing their order. Hydrate bytes only at the provider boundary, not into JSONL, prompt Markdown, telemetry, localStorage, or repeated renderer snapshots. The existing attachment token budget is usable scaffolding, but it does not upload or deliver images today. Budget image tokens separately from text; never estimate them from base64 string length.

Use atomic writes and a reference-aware asset lifecycle. Draft cancellation, run deletion, archive, project adoption/move, and conversation continuations must not remove bytes still referenced elsewhere. A crash between import and launch leaves an orphan eligible for delayed cleanup, not a corrupted run. A missing/corrupt asset produces a recoverable error that names the image. Exporting a conversation must either bundle its assets or explicitly produce a text-only export with attachment metadata.

Preview reads must resolve project-owned asset IDs through a narrow IPC/service endpoint. Avoid arbitrary `file://` rendering or a general filesystem-read bridge. If URL import is implemented, constrain schemes, redirects, response size, and private-network access. Keep imported images scoped to the run's existing execution permissions; an attachment is data, not authorization to read arbitrary files.

## Automatic behavior across nodes

The scheduler should carry `{ text, attachments }` internally, with a text-compatible adapter for existing block APIs. Attachments belong to an invocation's input scope. An ordinary text output does not erase them. At a parallel fork, lanes inherit the entry references; lane-produced assets remain lane-local until the explicit join. Child sessions receive only the parent's permitted input references. Resume restores those exact scopes.

Node semantics belong in built-in definitions/runtime policy, not required user configuration. An optional plugin metadata field can advertise image behavior; existing plugins default to preserving references, with a clear unsupported result if they need visual reasoning but bypass the shared multimodal model service.

| Node role | Default behavior with images |
| --- | --- |
| Refine, clarify, orient, plan, split | Use images to understand the request when the chosen model supports them; otherwise consume an attributed description/OCR prepared by an allowed vision model. Preserve references for workers. |
| Work / AI step / implementation | Receive original image references plus the task and upstream text. Vision-capable calls receive actual pixels. Tools can resolve a scoped local copy for asset use without guessing a path. |
| Review / critique / compare | Receive the visual evidence and relevant candidate images. A visual-comparison verdict requires actual images; an upstream caption alone is not sufficient evidence. |
| Summarize / format / extract | Retain references and use native vision or prepared text as needed. Once the task is explicitly formatting a text result, avoid sending all image bytes again. |
| Human checkpoint / clarification | Show thumbnails/full-size preview beside the question. Free-form answers can add images. Display is local; no model call is needed merely to show evidence. |
| Sequence / parallel / repeat / until / if | Preserve and scope references as control-flow data. Predicates still evaluate their declared structured fields; they do not interpret images. |
| For each / task graph / delegated worker | Inherit shared reference images and pass item-specific references to the correct invocation. Do not turn unrelated images into extra tasks. Record image selection with child input for replay. |
| Deterministic evaluation / file checks | Continue evaluating the declared artifact and checks. Merely having a screenshot never counts as a passing test. A visual evaluator needs an explicit runtime evaluator contract and image evidence. |
| Goal setup and repeated recipe | When integrated, persist references with the Goal definition and propagate them to setup, iterations, repair, review, and cloned instances with correct ownership. Reuse immutable assets across iterations. |

Start with reliable propagation of all user reference images inside the current invocation scope. Add semantic relevance pruning only when it has observable selection records and tests; heuristic pruning must not make a worker lose the image the user attached. Derived assets can narrow to child input scope as their provenance becomes explicit.

Do not loosen the existing block context boundary to fetch the entire session's images. [Workflow context isolation](D:/electron/llm-flow/tests/workflowContext.test.js) already protects parallel lanes and repeated invocations. Extend that invariant to image references.

## Model selection and fallback

Resolve image handling against BOTH the chosen model's image capability and the adapter's implemented transport. Missing capability information is unknown, not true. Extend catalog facts and registry wiring; do not hard-code “all models from provider X see images.” Retain tool/structured-output requirements while choosing vision-capable candidates.

Recommended dispatch policy:

1. If the selected model and transport support images, send native image parts.
2. If a node permits a textual interpretation, obtain a description and OCR through an already allowed vision-capable route, then keep the selected text model for that node. Include visible text, layout, relevant visual details, and uncertainty. Label this as derived information.
3. If the node requires direct visual reasoning, choose a compatible model only from the user's existing allowed route/fallback candidates. An explicit incompatible model pin should produce a clear explanation rather than silently being replaced.
4. If no permitted route can inspect the image, retain the draft/run and explain the missing capability. Do not silently omit attachments, pretend the text model saw them, enable a new provider, or move a free profile onto a paid model.

Cache general image interpretation by project, asset/variant hash, model route, and interpretation version. Keep task-specific analysis separate so a caption prepared for one task is not treated as complete evidence for another. Share in-flight preparation between parallel nodes and account for it in run cost/time/cancellation. OCR itself is not infallible and does not preserve all layout, color, or spatial information.

Provider encoding:

- OpenAI Chat Completions uses text and `image_url` content parts; local images can use data URLs. Responses uses a different `input_image` shape. Flyt currently uses Chat Completions, so endpoint migration is unnecessary for this feature. [OpenAI images and vision](https://developers.openai.com/api/docs/guides/images-vision).
- OpenRouter accepts multipart messages with `image_url`, including base64 data URLs for local images. Model/provider limits differ, so validate the resolved route. [OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding).
- Anthropic uses native `image` blocks with image sources. Implement this in its transform while retaining tool and reasoning blocks. [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision).
- Codex CLI documents an image flag. Stage validated copies within its permitted execution environment and test the installed CLI's noninteractive invocation, multiple images, cancellation, and cleanup. [Codex command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
- Claude Code documents `--input-format stream-json`, but the CLI flag reference alone does not establish the complete image-envelope contract. Verify that contract against the supported installed version before advertising native support. Preserve the adapter's tool restrictions. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).
- Kimi and plugin adapters need model-specific capability and transport verification. OpenAI-compatible text transport alone does not prove image support. The mock provider should record image references for deterministic tests.

Every fallback attempt must re-check capability, transport, size, context, and permissions. Re-encode from canonical references for the destination adapter. Keep provider reasoning replay protected as today. Record model changes and whether each image was sent natively, interpreted into text, or omitted under an explicit policy. User-facing feedback can be a compact status; detailed provenance belongs in the trace.

## Implementation order and completion criteria

1. Remove the discontinued landing queue mode and its UI-specific tests; retain historical storage. Add asset storage/import/preview and typed submission validation, with old string callers supported.
2. Extend kernel message parts, session events/replay, block inputs, scheduler carry, and provider request assembly. Cover sequence, branches, iterations, child sessions, and retries before enabling upload controls.
3. Implement API-provider image serialization, capability ingestion, context accounting, and automatic native/interpretation routing. Verify CLI support separately before marking those transports ready.
4. Add the shared attachment composer to landing, follow-ups, and node questions. Render image references in user-turn/input views, history reopening, and request inspection. Update [BlockEditor input rendering](D:/electron/llm-flow/src/v2/BlockEditor.jsx), [Work](D:/electron/llm-flow/src/v2/Work.jsx), [run projections](D:/electron/llm-flow/kernel/src/session/projection.ts), the [conversation supervisor](D:/electron/llm-flow/core/conversationSupervisor.js), desktop bridge, API contract, and [development mock](D:/electron/llm-flow/src/devMock.js).
5. Add project-image/artifact reuse, URL import, and Goal authoring integration through the same services. Crop/annotation and screenshot capture can follow without redesigning attachment storage.

Required automated coverage:

- MIME spoofing, malformed/oversized images, excessive decoded dimensions, ownership/traversal rejection, duplicate import, atomic failure, reference-aware cleanup, and projectless adoption.
- Image-only and text-plus-image messages survive serialization, projection rebuild, restart, retry, and reply-created immutable runs. A previous image remains available for “use the screenshot above.”
- Plan -> Work -> Review all receive the relevant original image even when Plan returns text. Parallel siblings cannot see each other's newly generated images before join. For-each/repeated execution scopes remain isolated on resume.
- Captured provider requests contain valid image blocks and matching text with tool/reasoning replay intact. Test native vision, text interpretation, unavailable/unknown capability, explicit model pins, free-only routes, and provider fallback without network calls.
- Budgeting does not count base64 as text or silently drop required images. Interpretation work is charged once when shared and is canceled with the owning run.
- Failed import/send preserves the draft. Switching project during import or launch cannot attach the image or show the resulting run in the wrong project. Retrying the same submission ID creates one run.

Native Electron checks are required in addition to unit tests: Windows screenshot paste, clipboard image copy, multi-file Explorer drop, mixed text/image paste, file picker, browser image drag, removal/re-add, keyboard/IME behavior, image preview, renderer reload, app restart, and production packaging. Use a separate verification profile. Test other supported desktop platforms before claiming parity. A synthetic DOM paste test does not prove that native clipboard formats work.

Useful existing regression suites: [workflow context](D:/electron/llm-flow/tests/workflowContext.test.js), [workflow reliability](D:/electron/llm-flow/tests/workflowReliability.test.js), [model tiers](D:/electron/llm-flow/tests/workflowModelTiers.test.js), [adapters](D:/electron/llm-flow/tests/adapters.test.js), [session log](D:/electron/llm-flow/tests/sessionLog.test.js), [daily work](D:/electron/llm-flow/tests/dailyWork.test.js), and [workflow UX](D:/electron/llm-flow/tests/workflowUx.test.js). Build the kernel and renderer after implementation. This audit does not claim those future image tests or live provider behavior have passed.

Audit verification: ran the existing workflow UX and workflow context suites against the current built kernel: 10 tests passed. This confirms the current queue conversion and context-isolation baseline; it does not validate image support. No live provider calls or native UI actions were performed.
