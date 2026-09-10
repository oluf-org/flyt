# Chat assets

Implemented 2026-09-10. This is the first image-support release, using a general asset reference contract so PDF and other importers can follow.

## User-facing behavior

The workflow launcher, follow-up composer, and free-form node answers accept PNG, JPEG, WebP, and static GIF files. Users can choose files, paste images, or drop files into the composer/conversation. The desktop also has an explicit **Paste image** action. Animated images and SVG are refused with a named error.

Each node that has executed shows a small **Context assets · count** disclosure. It describes the assets in that invocation's context; it does not claim the model has inspected them. Opening it loads thumbnails, names, and full-size previews. The input node shows the originally attached assets. Native model delivery and the chosen route are recorded in the trace.

Image-only messages retain empty user text. Draft text and references are isolated by project/conversation, survive renderer reload through session storage, and clear only after acknowledgment. Import errors retain valid attachments. Request IDs deduplicate concurrent sends and retries after a backend restart. Follow-ups create immutable runs with the earlier references preserved.

## Extension points

- `kernel/src/types.ts`: `AssetRef` carries a durable ID, `kind`, MIME type, original size, name, and optional image dimensions. `ChatSubmission` is additive; string API callers still work. `Message.parts` is canonical multimodal input, while `content` remains its text projection.
- `core/assetImporters.js`: format-specific signature validation, decoding, and preview variants. Add a future importer here alongside a matching message-part serializer, capability fact, budget calculation, and preview UI. Unknown asset kinds currently fail explicitly at the model boundary.
- `core/assets.js`: project ownership, atomic publication, immutable originals, variant hashes, validation, and draft adoption. It does not depend on a renderer or the original file path. The public import operation accepts bounded bytes instead of an arbitrary filesystem path.
- `kernel/src/plugins/stack-runner.ts`: attachment scope travels separately from text, including sequence, parallel, repeat, until, branch, and foreach. Parallel lanes inherit copies; produced references become visible downstream at the join. Saved outcomes restore those scopes on resume. Delegated workers inherit their parent's explicit references.
- `src/AssetComposer.jsx`: shared drafts, ingestion, preview, and the generic context disclosure. Images are the first preview renderer. Closed node disclosures do not load image bytes.

Originals live under each run store's `_assets/<content-hash>/`; manifests and normalized previews are published by an atomic directory rename. Temporary projectless references carry a random draft capability and are copied into the destination project before launch. The host derives metadata and checks ownership and hashes. Image bytes are hydrated at the provider boundary, never in session JSONL or renderer snapshots.

There is deliberately no per-run asset deletion: deleting or archiving one run must not break a continuation. Project adoption carries the asset directory with the run store. Orphan collection is a follow-up requiring a complete scan of durable run, child-session, and draft references; unused drafts currently consume disk until their containing storage is removed.

## Model transport

OpenAI Chat Completions, OpenRouter, and Anthropic receive native image blocks. Capability checks apply separately to the model and the adapter on every fallback attempt. The host checks the configured workflow before acknowledging an image launch; missing capability information remains unknown. It never enables another provider or invents a paid fallback. Allowed native fallback routes are retained; a route with no image support fails clearly.

Codex CLI stages validated images in a per-call directory, passes repeated `--image` arguments, and removes the directory after completion or cancellation. Its existing restriction against running Flyt tool loops still applies. Claude Code and Kimi image transports are not enabled.

Limits: 10 images/message, 20 MiB/original, 50 MiB original bytes/message, and 40 million decoded pixels/image. Native dispatch additionally enforces conservative 20 MiB aggregate encoded data, 10 MiB/image, and 8000-pixel dimensions. Image tokens are estimated separately from text, using dimensions and a conservative minimum. A request that would discard image evidence during compaction is refused.

The conversation supervisor summarizes text results and attachment names, with an explicit instruction not to claim it inspected pixels. Original references are independently carried into the next run.

Encoding references: [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision), [OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding), [Anthropic image blocks](https://platform.claude.com/docs/en/build-with-claude/vision). Codex's installed `exec --help` confirms its native image flag.

## Verification and remaining work

- 87 targeted regression tests passed across chat assets, workflow context/reliability/model tiers, adapters, LLM seam, context budgeting, session logs, daily work, and workflow UX.
- 19 subscription-adapter tests passed. One additional integration test passed for adding an image through a node answer and delivering it downstream (107 distinct passing tests total).
- Kernel and renderer production builds passed.
- Browser preview checks passed for file selection, image-only launch, full-size preview, the node asset disclosure, bitmap paste, and restoring a project-specific draft after switching tabs.
- An isolated Windows unpacked package passed the package-integrity hook. Its bundled Sharp decoder loaded and decoded an image under Electron 44. The packager's initial archive-extraction rename failed with EPERM; packaging succeeded using the already installed Electron distribution.

No live provider calls were made. Windows Snipping Tool/Explorer formats, IME behavior, app restart with native clipboard data, and other operating systems still require manual verification. The browser clipboard check is not a claim of native platform parity.

Follow-on scope from the original proposal: allowed-route OCR/text-interpretation caching, image URL import, project/artifact reuse controls, Goal authoring attachments, a scoped image file tool, reference-aware orphan cleanup, image editing, and additional file types. These are not advertised by this initial implementation.
