# RUN-MODE — design decisions for the live-canvas experience

How the canvas should feel while a flow *executes*, as opposed to while you *edit* it.
Editing is a workbench: everything reachable, everything mutable. Running is a stage:
the app performs, you watch, and you intervene only deliberately. These decisions
implement that split.

## The split

| | Edit mode | Run mode |
|---|---|---|
| Canvas | Workbench — drag, connect, delete | Stage — read-only, ambient, follows the action |
| Attention | Wherever you put it | Guided — the camera reads the story to you |
| Controls | Toolbars, pickers, inspectors | Right-click + a minimal live chrome |
| Nodes | Static cards | Live actors (elapsed timers, beam ring, status glyphs) |

## Decisions

### 1. Follow execution (the "chat scrolls to the nodes" behavior)

Execution is a story; the camera reads it. While a run is live, the canvas glides
(`setCenter`, 600 ms) to each newly active node; parallel waves get a bounded
`fitBounds` (maxZoom 1 so you never get shoved into a node's face).

- **Default ON** — newcomers get the guided tour with zero setup.
- **Any manual pan/zoom disengages it** — the app never fights your hand. A small
  floating `▶ Follow execution` chip re-arms it. This is the single most important
  UX rule: guided by default, obedient always.

### 2. Right-click is the control surface

One menu (`src/NodeMenu.jsx`), cloned from the tab-menu pattern, plus arrow-key
navigation (new: the tab menu never had it — both newcomers and power users win).

- ◈ **Investigate** — always available; the safe first action.
- ↺ **Restart node** / **Restart with guidance…** — only when the run isn't live
  (disabled items *say why* in their tooltip — menus should teach, not just refuse).
- ⑂ **Branch from here** — fork the run with this node and everything upstream kept.
- ❚❚ **Pause** / ▶ **Resume**, ■ **Stop** — run-level, also on the pane menu so empty
  canvas right-click still works.
- Stop is a two-click inline confirm ("Click again to confirm stop", 3 s) — never a
  modal. Destructive needs friction, not interruption.

### 3. Pause is soft, Stop is hard — and the UI says so

- **Pause** = "finish the current step, then hold." The engine parks at the next wave
  boundary (`meta.paused` lands only when actually held; the meter goes amber and a
  "Paused" chip appears). Deliberately *not* mid-token — soft pause is honest,
  crash-safe, and comprehensible: it does exactly what the label says.
- **Stop** = hard: aborts in-flight HTTP (signal threaded through every adapter and
  the retry/backoff loop, which never retries an abort), settles approval and pause
  gates so nothing hangs, stage becomes `cancelled` ("Stopped" in the UI — neutral,
  not failure-red; you chose this, the run didn't fail).

### 4. Investigate = explain first, stream second, facts last

The Node Focus panel (`src/NodeFocus.jsx`) layers the same information for two
audiences:

1. **"◈ Explain this node"** — a model reads the node's output, retrospective, and
   recent log, and answers in plain language: what it's doing, is it healthy,
   anything notable. *This is the newcomer's front door.*
2. **Token stream** — the live/persisted output with stick-to-tail scrolling. The
   practitioner's raw feed.
3. **Technical details** — model, tokens, duration, tool calls, folded behind
   `<details>`. Advanced users lift the hood; nobody has it open by default.

With no model configured the panel degrades honestly: raw status with a note, not an
error.

### 5. Branch and Restart turn runs into conversations with the past

- **Restart** rewinds a node *and its downstream* (forward edges only — feedback
  channels don't get rewound) and lets you attach one line of guidance that lands in
  the node's prompt. "Do this part again, but differently."
- **Branch** forks the whole run directory at a node: upstream stays done, downstream
  re-runs, the original is untouched. Branches carry a `⑂ branch` chip in the run bar
  so provenance is always visible. This is how you explore "what if the analysis had
  gone the other way" without losing the original.

## Reading the output (OUTPUT-VIEW rework)

Until now every output rendered as raw mono `<pre>` in a 372 px column. The canvas
is now the reader: markdown renders everywhere, and the node you care about grows
into a real reading card in place.

### The node card is the reader

- **Expand in place** — every card has a quiet ⤢ affordance; double-click (or Enter
  on the selected node) does the same. The card grows to ~560×640 with a header
  (title, status pill, **Rendered/Raw** toggle — Raw is the old mono `pre`, for
  investigating exact bytes — Copy, ⤡ collapse / Esc) over a scrolling markdown
  body that sticks to the tail while the node streams.
- **Resizable, remembered** — a React Flow `NodeResizer` (active only while
  expanded) sizes the card freely; the size is remembered per node for the session.
- **Local displacement, not re-layout** — neighbors the expanded card would cover
  slide just far enough aside (minimal translation + gutter, cascading with a depth
  cap, 240 ms glide, off under reduced motion). Collapse restores their exact
  positions — unless you dragged one meanwhile; your placement always wins.
- **Markdown everywhere** — `src/MarkdownView.jsx` (react-markdown + remark-gfm,
  no raw HTML) backs the canvas card, Node Focus, the run result, and the live
  stream. A half-streamed code fence is closed before parsing so streaming never
  swallows the document.
- **The Output node opens itself** — when a run settles, its Output node(s)
  auto-expand; everything else mounts collapsed. The Inspector dropped its output
  sections (D11): it keeps config, goal/constraints, tool calls, and retrospective,
  and points at the canvas for reading.

### ◇ Summary nodes: condensation as a run artifact

Right-click any node **with output** → **◇ Summarize output** (a multi-selection
reads "Summarize N nodes" and produces one combined summary; the Run Result panel
has the same button for result.md). A model condenses the source(s) into
**TL;DR + 3–6 bullets**, and the result lands on the canvas as a distinct
accent-bordered ◇ card, edge-linked (dashed) from everything it read.

- **It's a file, not a view** — `runs/<id>/summaries/<key>.md` plus an entry in
  `summaries/index.json` (`sources` with each source's status at creation, model,
  timestamp, canvas position). Never part of flow.json, never re-runs. Deleting
  the card (✕ on it, or the context menu) removes both.
- **Honest about timing** — summarize mid-run and the card permanently badges
  "summarized before completion": a summary is a snapshot of what it read.
- **Degrades honestly** — no configured model → a note, not an error; a failed
  call → the error with Retry, in place. While writing, the card is a shimmer
  placeholder.
- **Placement** — beside the source(s) (prefer right, then below; multi-source at
  the centroid), using the same displacement routine to make room. Drag it
  anywhere; the position saves back into the index and survives reload.


## The chat run surface (CHAT-RUN rework)

Running from the home chat keeps the conversation put and unfolds the run
*below* the thread — this rework makes that unfold behave like the chat it
lives in.

### 6. The feed is the default: nodes scroll like messages

The graph flattens into a chat-style column of node cards (`src/NodeFeed.jsx`
over `src/nodeFeedData.js`) in execution order — topological with reading-order
tie-breaks, orchestrator children and spawned tasks indented under their owner
instead of drawn in a box. Each card is a "message": it streams the last few
output lines while it works (the half-typed reply) and lands with its output
excerpt + retrospective. Scroll is stick-to-bottom, the chat-client contract:
at the tail you glide down with new work; scroll up to read and the view is
yours, with a "↓ New activity" chip to jump back. The full canvas stays one
toggle away (`☰ Feed / ◇ Canvas`, persisted) — the graph is still the right
view for structure, just not the default for watching.

### 7. Summaries are opt-in and beside the point of scrolling

The `▤ Summary` toggle opens a right sidebar (`src/ChatSidebar.jsx`): progress,
elapsed, the final answer once the Output node has one, and per-node summaries
(retrospective status/confidence, problems, recommendation, output excerpt) —
only for nodes that have said something; pending rows are noise. Off by
default; persisted per user, not per run.

### 8. Gates block, and a parked run finds its user

The approval gate graduated from an inline bar to a dialog
(`src/ApprovalModal.jsx`): what is being asked, the exact tool call in mono,
the classifier's risk pill and reason, and "nothing runs until you decide" —
no scrolling past it. Danger gates focus Reject; Esc never decides.
"Review first" docks the gate above the composer — a persistent bar with the
same Approve/Reject plus Details ↑ back to the dialog — so the decision can
never scroll out of reach while reviewing the flow (the earlier in-scroll bar
could, and did).

When the window isn't focused, the renderer reports the gate
(`app:approvalGate` IPC) and the main process raises an OS notification +
taskbar flash until the gate settles or the window regains focus. Clicking the
notification restores and focuses the window. One notice at a time; a user
already looking at the dialog gets no nudge.

## Flare budget — spent deliberately, capped

Reviewed what makes the app feel alive vs. what makes it feel like a screensaver.
The rule: **flares must communicate state or reward completion, exactly once.**

Shipped:
- **Travelling conic beam** on the active node (pre-existing signature — kept).
- **Elapsed ticker** inside active node cards — information, not decoration.
- **Done bloom** — one soft 900 ms radial pulse when a run completes. Once per run,
  never on replay, never under `prefers-reduced-motion`.
- **Stage vignette** — the canvas deepens slightly while live; static, not animated.
- **Coach tip** — "right-click any node for run actions", shown *once ever*
  (localStorage), because right-click UIs are invisible until someone tells you.

Rejected (over the line): sounds, confetti, particle systems, node shake on failure,
3D tilt, animated gradients on idle nodes. If a flare doesn't carry information or
mark a genuine event, it's noise.

## Accessibility & motion discipline

Every continuous animation has a `prefers-reduced-motion` fallback; the bloom renders
*nothing* at all when reduced motion is preferred. Menus are real buttons with
`role=menu/menuitem`, arrow-key/Home/End navigation, Esc to close, and
viewport-clamped positioning.

## Failure honesty

- IPC rejections surface as a 4-second `.run-toast` (e.g. "run is live — stop or
  pause it first") — no `window.alert`, no silent swallows.
- Stop during an approval gate cannot hang the walk (gates settle on stop; a
  regression test caught and fixed this).
- A stopped run is deletable immediately (leaves the live registry), and follow-up
  turns remain legal from it.
