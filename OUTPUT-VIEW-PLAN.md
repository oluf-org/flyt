# Output View & Summary Nodes — Plan

**Feature:** Readable LLM output (especially markdown) on the run canvas, plus right-click
summarization that creates a summary node.
**Status:** Shipped 2026-07-23 — all four phases implemented (505/505 tests, build green).

**Problem.** Every LLM output today renders as raw mono `<pre>` inside the 372px right
column: Inspector sections, NodeFocus stream (fixed 140px), RunResult (max 220px),
LiveStream (168px). There is no markdown rendering anywhere. Reading a real result means
scrolling a tiny box or opening the run folder.

---

## A — Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| D1 | Where reading happens | **Expand node in canvas** — the node itself grows into a readable card. No separate reader panel/tab. |
| D2 | Markdown renderer | **react-markdown + remark-gfm** (safe by default, no raw HTML — deliberately no rehype-raw). |
| D3 | Expand mechanics | **Toggle + resizable**: expand button / double-click grows the card to a reading size (~560×640), then a React Flow `NodeResizer` handle sizes it freely. Size remembered per node. |
| D4 | Neighbor handling | **Local displacement**: only nodes that would overlap shift just far enough (animated); collapse restores their exact previous positions. Manual placements survive. Full re-layout rejected (graph jumps, discards manual positions). |
| D5 | Summary node semantics | **Run artifact**: created in the run graph, edge-linked to source(s), writes `summaries/<key>.md`. Not part of the flow definition; never reruns. |
| D6 | Summary staleness | **Leave as-is** — a summary is a snapshot of what it read. No staleness tracking. But record the source's status at creation and badge summaries made **before the source completed** ("summarized mid-run"). |
| D7 | Summary shape | **TL;DR + key points**: one bold TL;DR sentence, then 3–6 bullets. |
| D8 | Summarize is offered on | **Any node with output** (aiStep, agentTask, orchestrator plan/aggregate, spawned tasks), **the run result** (result.md), and **multi-select** (one combined summary, edges from each source). Not on summary nodes themselves (no chains). |
| D9 | Which surfaces render markdown | All: run result panel, node output views (canvas card, NodeFocus), live token stream, summary cards. Everything is expandable/collapsible; **summary nodes and the result/Output node default to expanded**, everything else defaults collapsed. |
| D10 | Raw investigate mode | A **Rendered / Raw toggle** in the expanded card header (raw = current mono `pre`). This covers the "investigate raw" want at near-zero cost; the existing NodeFocus investigate panel stays as-is otherwise. |
| D11 | Inspector output sections | **Removed for now** in run view (Inspector keeps config, goal/constraints, tool calls, retrospective). Whether the Inspector shrinks further is a future investigation. |

## B — Design

### B1. MarkdownView (shared component)
- `src/MarkdownView.jsx`: wraps `ReactMarkdown` + `remark-gfm`. One `.md-body` stylesheet
  block in styles.css using the existing tokens (`--tx`, `--card`, `--border`, Plex Mono
  for code). Tables get horizontal scroll; code fences get the mono treatment.
- Inside canvas nodes it wears `nowheel nodrag nopan` so inner scrolling and text
  selection don't fight canvas zoom/pan/drag.
- **Streaming tolerance:** rendered on the existing ~250ms snapshot cadence, memoized on
  the text. Before parsing, close an unterminated trailing code fence (append ```` ``` ````)
  so half-streamed fences don't swallow the document. The live caret renders after the
  last block while status is `active`.

### B2. Expanded node card (the reader)
- Collapsed card = today's card plus an expand affordance (⤢ button; double-click does the
  same). Expanded card ≈ 560×640 with header (title, status pill, Rendered/Raw toggle,
  Copy, collapse ⤡) and a scrolling `MarkdownView` body with stick-to-tail while live.
- `NodeResizer` active only while expanded; chosen size remembered per node (per-run UI
  state, in-memory; persisting it is a later nicety).
- Expanded/collapsed is UI state per run — `expandedNodes: { [nodeId]: {w,h} }` in App's
  per-run state, not written to run files.
- **Default-expanded rule (D9):** summary nodes always mount expanded; the Output node
  auto-expands when the run reaches a terminal stage. Everything else mounts collapsed.

### B3. Local displacement (D4)
- On expand: compute the expanded bbox; for each overlapping node, shift it along the
  minimal-translation vector (plus 24px gutter), cascading if a shifted node now overlaps
  another. Record `{id, from}` for every moved node.
- On collapse: restore recorded positions exactly. If the user manually dragged a
  displaced node meanwhile, drop it from the restore set (their move wins).
- Animate via a CSS transition on the node transform (`.displacing` class, ~240ms,
  disabled under `prefers-reduced-motion`); edges follow for free.
- Pure displacement math lives in `src/displace.js` with unit tests — no React Flow
  dependency in the tests.

### B4. Summary node (D5–D8)
- **Menu:** NodeMenu gains "◇ Summarize output" (enabled when the node has any output;
  works mid-run — that's what the D6 badge is for). With a multi-node selection the same
  item reads "Summarize N nodes". RunResult's header gains a small "Summarize" button for
  result.md.
- **Engine:** new IPC `run:summarize (projectId, runId, sourceIds[])` →
  `flowRunner.summarizeOutputs`. Resolves the model exactly like `investigateNode`
  (priority chain; degrades to `no-model`). Prompt: produce `**TL;DR** — <one sentence>`
  then 3–6 bullets, grounded only in the provided output(s); multi-source prompts name
  each source section.
- **Persistence (auditable-files philosophy):** writes `runs/<id>/summaries/<key>.md`
  (key = joined sanitized source ids) and registers the node in
  `runs/<id>/summaries/index.json`:
  `{ id, sources: [{ id, statusAtCreation }], at, model, file }`.
  Snapshot assembly includes summaries; the canvas derives summary nodes + dashed edges
  from it. Nothing touches flow.json.
- **Card:** distinct summary styling (accent border, ◇ icon), default expanded, markdown
  body. If any `statusAtCreation` wasn't terminal → persistent badge
  "summarized before completion". Failure states: `no-model` note (mirrors NodeFocus
  copy) and error + Retry. While generating: shimmer placeholder node.
- **Placement:** beside the source (prefer right, then below) using the same displacement
  routine to find room; multi-source at the sources' centroid. User can drag it anywhere;
  position saved in index.json so it survives reload.
- **Delete:** summary nodes are deletable from their card / context menu (removes file +
  index entry). Restart/branch/investigate items don't apply to them.

### B5. Surface cleanup
- **RunResult:** result body and follow-up outcomes render via MarkdownView, collapsible,
  default expanded (D9). Height cap raised (result is the point of the run).
- **Inspector (run view):** output/`result.md` sections removed (D11); config,
  tool calls, and retrospective stay.
- **NodeFocus:** Output section becomes MarkdownView with the same Rendered/Raw toggle;
  everything else unchanged.
- **LiveStream:** rendered markdown with the tolerance rules from B1; caret kept.

## C — Implementation order

1. **Markdown foundation** — deps, `MarkdownView.jsx`, `.md-body` styles, streaming
   tolerance. Swap into RunResult + NodeFocus (immediate value, no canvas risk).
2. **Canvas reader** — expand toggle + NodeResizer, `displace.js` + tests, Rendered/Raw
   toggle, Output-node auto-expand, live streaming into expanded cards.
3. **Summary nodes** — IPC + `summarizeOutputs`, summaries store + snapshot, canvas
   summary node + edges, NodeMenu/RunResult entry points, multi-select, mid-run badge.
4. **Cleanup** — strip Inspector output sections, polish (reduced-motion, keyboard:
   Enter expands selected node, Esc collapses), doc note in RUN-MODE.md.

Each phase ships independently; 1 and 2 don't touch the engine at all.

## D — Risks & guards

- **Canvas perf:** many expanded markdown nodes re-rendering on 250ms snapshots →
  memoize MarkdownView on text, and only the active node's text changes per tick anyway.
- **Zoom legibility:** an expanded card at 40% zoom is unreadable — acceptable; the
  expand gesture is when you care, and scroll-to-read implies you've zoomed in. (A
  "zoom to node on expand" nicety can come later.)
- **Displacement cascades** on dense graphs could shove distant nodes — cap cascade depth
  and fall back to plain overlap beyond it.
- **Security:** react-markdown without rehype-raw escapes HTML by default; model output
  can't inject markup.
- **Multi-select summarize token size:** concatenated outputs may be huge — truncate each
  source to a budget (like investigate does for logs) and say so in the prompt.

## E — Open (deferred, not blocking)

- Persist expanded sizes across app restarts.
- Zoom-to-node on expand.
- Inspector's long-term role in run view (D11 said "investigate later").
- Summary depth variants (Quick/Deep) — D7 chose one shape; revisit if TL;DR+bullets
  proves too shallow for orchestrator aggregates.
