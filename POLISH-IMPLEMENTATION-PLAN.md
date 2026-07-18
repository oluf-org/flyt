# LLM Flow — Polish Implementation Plan

**Status:** Proposed (2026-07-18).
**Scope decided by owner:** all of `DESIGN-POLISH-IDEAS.md` (Tier 1+2) · tabs **A** (baseline strip) + **D** (deck switcher) · flare **1** (sigils — **"burst" variant, `sigil-v4.html` variant I**) · flare **3** (edge weight) · flare **5** (focus dimming) · flare **6** (replay) · flare **7** (plaintext mirror).
**Explicitly out:** tabs B/C, flares 2, 4, 8–12, Tier 3 ideas 12–15. Demo reference: `design-demos.html`, `flare-demos.html`.
**Read alongside:** `DESIGN-SPEC.md`, `TABS-DECISIONS.md`, `GOALS.md`.

Ordering principle: token/motion foundation first (everything sits on it), then leaf features (canvas, panels, run views) which are independent of each other, tabs last (only item with data-model prerequisites). Phases 1–3 can interleave; nothing in them blocks anything else.

---

## Phase 0 — Foundation (do first; everything else builds on it)

**0.1 Derived color system** *(idea 5)*
- Rewrite `src/styles.css` tokens: two seeds (`--accent-h` etc. via `oklch`), derive `--accent-soft`, `--ok`, `--err`, hover/press shades with `color-mix(in oklab, …)` + relative color; collapse light/dark pairs with `light-dark()` + `color-scheme` where the value is derivable, keep literal blocks where it isn't.
- Keep a commented "compiled" hex table at the top so designers can still read the palette.
- *Files:* `src/styles.css` only. *Depends on:* none.
- *Acceptance:* both themes visually identical to before (screenshot diff of canvas, inspector, runs list); changing `--accent` alone produces a coherent new palette in both themes.

**0.2 View Transitions + retire the broad transition rule** *(idea 3)*
- Wrap theme toggle and section switches (`App.jsx` rail navigation) in `document.startViewTransition(cb)` with a `!document.startViewTransition` fallback (call `cb` directly).
- **Remove `.app, .app * { transition: … }`** — replace with explicit transitions on the ~10 components that need hover/press feedback. This is the perf payoff: no style-recalc tax on every theme-affecting mutation across the whole tree.
- Give the run-header ↔ run-card a shared `view-transition-name` for the morph.
- *Files:* `src/App.jsx`, `src/styles.css`. *Depends on:* 0.1 (do the CSS surgery once).
- *Acceptance:* theme swap is one crossfade; DevTools performance trace shows no full-tree style recalc on hover of a single node.

**0.3 Motion & type primitives** *(ideas 7, 10, 11)*
- Add `--spring: linear(…)` token; apply to node select pop, inspector `panel-rise`, buttons (`transform` only).
- Noise texture layered into the `--canvas` background (static SVG data-URI, both themes).
- `font-variant-numeric: tabular-nums` on run timers/token counts; `text-wrap: balance` on empty states and dialog titles, `pretty` on paragraph copy; try `text-box-trim` on chips/buttons behind a one-line class so it's trivially removable.
- *Files:* `src/styles.css`. *Depends on:* 0.1. *Acceptance:* visual QA; timers don't jitter.

---

## Phase 1 — Canvas life (the run view earns its "mission control" claim)

**1.1 Border-beam running signal** *(idea 1)*
- `@property --beam` + conic-gradient pseudo-element on `.flow-node.status-active` and `.orch-node.status-active` (orch already animates `--orch-angle` — reuse that pattern, one shared keyframe). Keep the icon-chip accent fill; drop the spinner or keep it inside the icon only (owner taste call at PR time).
- `contain: paint` on `.flow-node` (audit: ports/stamps must not overflow, or scope containment to the pseudo-element).
- *Files:* `src/styles.css`, `src/FlowCanvas.jsx` (class only). *Depends on:* 0.1.
- *Acceptance:* 4 parallel active nodes at 60fps on the dev machine with DevTools paint-flashing showing repaints confined to node rects.

**1.2 Custom edge component: signal dots + weight** *(idea 2 + flare 3 — one component, do together)*
- Add `src/FlowEdge.jsx` registered as the default edge type. It renders the base path, plus:
  - **weight:** `strokeWidth` bucketed (1 / 2.5 / 4 / 6px, `opacity` capped) from `data.contextBytes`; a `title`/tooltip shows the number. Buckets, not linear scale — outliers would otherwise dominate.
  - **signal dot:** when `sourceStatus === 'active'`, one `<circle>` child with `offset-path: path(edgePath)` animating `offset-distance` (CSS class, no JS per frame). Path string is already computed by React Flow's `getBezierPath`.
- **Data source for weight:** the runner already knows what context each node received. Persist `contextBytes` (and later `contextTokens`) per edge into `meta.json` when context is assembled (`upstreamContext()` / `buildMinimalContext` in `core/flowRunner.js`) — a few lines; file-based state stays the truth. Authoring mode (no run): all edges width 2, as today.
- *Files:* new `src/FlowEdge.jsx`, `src/FlowCanvas.jsx`, `src/runGraph.js` (map meta → edge data), `core/flowRunner.js` (persist sizes), `src/styles.css`. *Depends on:* 0.1.
- *Acceptance:* a run with a `contextSpec` node visibly shows thin edges into it vs thick full-context edges elsewhere; dots appear only while the source streams; no rAF/JS timers introduced.

**1.3 Focus dimming with lineage** *(flare 5)*
- CSS does the dim: `.react-flow:has(.flow-node:hover) .flow-node:not(.lit) { opacity/filter }` (verify `:has()` cost on 40+ nodes; fallback is a `dimming` class set on the pane via `onNodeMouseEnter`).
- JS does the lineage (CSS can't walk a graph): on `onNodeMouseEnter`, compute ancestor set from the edge list (one upward BFS, memoized per topology rev) and set `lit` on those nodes + edges; clear on leave. ~30 lines.
- Delay activation by ~150ms so drag-passes don't flicker; disable entirely while dragging.
- *Files:* `src/FlowCanvas.jsx`, `src/styles.css`. *Depends on:* none.
- *Acceptance:* hovering a deep node highlights its full upstream chain and dims the rest; no dimming during node drag; a 50-node graph shows no measurable hover lag.

---

## Phase 2 — Panels & lists

**2.1 `content-visibility` on long lists** *(idea 4)*
- `content-visibility: auto; contain-intrinsic-size: auto <rowH>` on runs-list rows, log lines, live-stream history blocks.
- *Files:* `src/styles.css`. *Depends on:* none.
- *Acceptance:* a 500-run list scrolls with no jank; no layout shift on scroll (intrinsic sizes match real row heights).

**2.2 Scroll-driven progress & fades** *(idea 8)*
- Named `scroll-timeline` on log/result panes → sticky 2px accent progress bar; `view()`-timeline settle-in on runs-list rows (once, ≤60ms stagger); overflow fade masks on the live-tabs strip.
- *Files:* `src/styles.css` (+ 2 wrapper divs in `RunResult.jsx` / `LiveStream.jsx`). *Depends on:* none.
- *Acceptance:* zero scroll listeners added (verify no new `addEventListener('scroll')`); bars/fades work in both themes.

**2.3 Auto-grow inputs & animated accordions** *(idea 9)*
- `field-sizing: content` + `max-height` on the run-panel prompt textarea and Inspector text fields; delete any JS resize code.
- `interpolate-size: allow-keywords` at `:root`; Inspector sections animate `height: 0 ↔ auto` with `--spring`.
- *Files:* `src/styles.css`, `src/Inspector.jsx`, `src/RunBar.jsx`. *Depends on:* 0.3.
- *Acceptance:* typing grows the box smoothly to cap then scrolls; accordions animate open/closed with no measured-height JS.

**2.4 Anchor-positioned tooltips & menus** *(idea 6)*
- Replace `title=` on ports/status glyphs with a styled tooltip: `anchor-name` per target, one shared `[popover]` element repositioned via `position-anchor`, `position-area`, `position-try-fallbacks: flip-block`; `@starting-style` spring-in.
- Node context menu (if/when added) uses the same popover pattern — top-layer, never clipped by the canvas.
- *Files:* `src/FlowCanvas.jsx`, `src/Inspector.jsx`, `src/styles.css`, small `src/Tip.jsx` helper. *Depends on:* 0.3.
- *Acceptance:* tooltips flip near window edges, are never clipped by pane overflow, and no positioning JS (no manual `getBoundingClientRect` math) exists.

---

## Phase 3 — Run comprehension (new small features, not restyling)

**3.1 Run sigils** *(flare 1 — variant chosen)*
- **Chosen variant: "burst" (variant I in `sigil-v4.html`)** — 8–14 evenly spaced radial ticks with seeded inner/outer radii, some dot-tipped; the length pattern is a visual "barcode" of the run id. Port that generator as-is into a pure function `sigil(id, size) → svgString` in new `src/sigil.js`. Deterministic from `runId`. (`sigil-v2.html` variants and the rest of v4 are reference only — delete after port.)
- **Implementation cautions:** SVG `<defs>` ids (gradients) must be suffixed with the id hash — duplicates across list rows silently break gradients. Burst needs no filter, so no rasterization step; it's plain strokes + circles, cheap at list scale by construction.
- Surface: runs-list rows, run-view header, deck cards (4.2). Sizes 20/26/34 — verify tick legibility at 20px (burst quantizes well, but if 20px muddies, floor the ray count at small sizes).
- *Files:* new `src/sigil.js`, `src/RunsList.jsx`, run header in `App.jsx`. *Depends on:* nothing — variant is decided.
- *Acceptance:* same id ⇒ identical sigil across restarts; 200-row list renders without filter jank; sigils respect both themes (currentColor/`var(--accent)` only).

**3.2 Replay scrubber** *(flare 6)*
- `src/runReplay.js`: fold `log.jsonl` into ordered frames `{t, nodeStatus{}, taskStatus{}, line}` — reuse the event vocabulary `runProgress.js` already parses; this is a pure function over an already-loaded file.
- UI: in run view for **finished** runs only, a scrubber strip (range input + play button, `tabular-nums` timestamp). Scrubbing feeds the frame's status map into the same props the live canvas already consumes (`runGraph.js` path) — the canvas doesn't know it's time-traveling. Exiting replay = snap to final frame.
- Guards: hidden while `meta.stage` is live; capped at ~5k frames (fold consecutive same-shape events).
- *Files:* new `src/runReplay.js`, `src/App.jsx` or `RunResult.jsx` (strip UI), `src/styles.css`. *Depends on:* 1.2 (edges show weight during replay too — free once edge data is in meta).
- *Acceptance:* scrubbing a finished 4-node parallel run shows the wave structure (two nodes active at once); play advances in real event order; live runs unaffected.

**3.3 Plaintext mirror** *(flare 7)*
- `src/runDocument.js`: pure function `(meta, tasks, log) → string` — typeset dossier (box-drawing rules, aligned columns, statuses, per-node durations/artifacts, footer with run folder path). It's a *projection of files that already exist*; no new state.
- UI: toggle in run view (`Canvas ⇄ Document`), rendered in a `<pre class="mirror">`; Copy button (the point is pasteability into issues/PRs). Wrap the toggle in a View Transition.
- *Files:* new `src/runDocument.js`, `src/RunResult.jsx` or `App.jsx`, `src/styles.css`. *Depends on:* none. Pairs naturally with 3.2 (document reflects scrubbed frame — optional, only if free).
- *Acceptance:* document matches `meta.json`/`tasks.json` for a finished run incl. spawned tasks; copy-paste into a markdown code block renders aligned.

---

## Phase 4 — Tabs A + D (last; the only item with data-model prerequisites)

**4.0 Decision gate — resolve the minimum set from `TABS-DECISIONS.md`:**
T1 (tab = workspace folder — recommended), T2 (runs per-project; flows/templates stay global for v1), T3 (existing globals become the "default project"), T5 (focus-existing), T6 (single renderer, recommended (a)), T7 (`projectId` on IPC + scoped pushes), T8 (per-tab state list), T13 (close = keep running), T14 (**Ctrl+Tab cycles/deck, Ctrl+1..9 stay on sections** — pick and write it down), T17 (restore tabs). T4/T11-extras/T16/T18/T19 can ride defaults. **Do not start 4.1 until these are written into `DECISIONS.md`.**

**4.1 Tabs A — baseline strip**
- Main process: project registry (open tabs, active id) in `settings.json`; `RunStore`/`FlowStore` instances keyed by project (runs dir per T2/T3 decision); IPC handlers take `projectId`; pushes carry it, renderer drops non-matching (guard mirrors the existing `snapRef` rev-matching).
- Renderer: per-tab state bundle = the T8 list (activeFlowId, activeRunId, snapshot, selection, undo stacks, viewport, run-panel state); tab switch = flush debounced autosave → swap bundle. Theme/settings/models stay global.
- Strip UI in the titlebar (per demo A): folder-name label, unsaved dot from `saveState`, live-run micro-indicator (reuse `--beam` token as a 6px dot), hover ×, middle-click close, drag reorder, `＋` → recents/folder-picker page (T15), overflow = Chrome-style shrink then scroll.
- *Files:* `electron/main.js`, `electron/preload` surface, `src/App.jsx` (state bundling — the big one), new `src/TabStrip.jsx`, `src/styles.css`. *Depends on:* 4.0; benefits from 0.2 (tab switch = View Transition).
- *Acceptance:* two projects open; runs land in the right project; background project's live run doesn't mutate foreground snapshot; restart restores tabs + active tab; closing a tab with a live run keeps the run executing (T13) and reopening the project shows it.

**4.2 Tabs D — deck switcher**
- Holding `Ctrl+Tab` ≥150ms opens the deck overlay (quick tap = instant MRU switch — both behaviors, like OS switchers); release or click selects; `Esc` cancels.
- Card = project name + status line + preview: live topology mini-render (nodes→dots, edges→lines from `*.layout.json` — a degenerate case of the sigil renderer; share code in `src/sigil.js`) + run state badge + sigil of the latest run (3.1).
- Overlay is a `<dialog>` with `::backdrop` blur (small area, per the anti-ideas rule this is the sanctioned blur use); cards spring-deal with `--spring` stagger, `transform/opacity` only.
- *Files:* new `src/TabDeck.jsx`, `src/styles.css`, `electron/main.js` (Ctrl+Tab before-input-event so the webview never eats it). *Depends on:* 4.1, 3.1.
- *Acceptance:* tap = MRU flip; hold = deck with accurate live states; keyboard-only operation works; open/close at 60fps with 6 tabs.

---

## Sequencing & sizing

| Order | Item | Size | Risk |
|---|---|---|---|
| 1 | 0.1 → 0.2 → 0.3 | M | Low — CSS-only + one API, but 0.2's transition-rule removal needs a careful visual pass |
| 2 | 1.1, 2.1, 2.2, 2.3 (any order, parallel-friendly) | S each | Low |
| 3 | 1.2 (edge component + meta persistence) | M | Med — touches `core/flowRunner.js`; keep the persistence additive (new key in meta, old runs render width 2) |
| 4 | 1.3, 2.4 | S–M | Low |
| 5 | 3.1 (after variant pick) → 3.3 → 3.2 | S / M / M | Low — all pure views over existing files |
| 6 | 4.0 → 4.1 → 4.2 | **L** | High — 4.1 is the one genuinely architectural task (per-project stores + IPC scoping + App.jsx state bundling). Land it as its own PR series; everything else must already be merged so tabs rebase cleanly on a polished, stable UI |

**Global verification, every phase:** (a) both themes screenshot-diffed; (b) DevTools performance trace while a 4-parallel-node run streams — no long tasks introduced, paint confined to changed rects; (c) `npm test` green (3.2/3.3/1.2 get unit tests on their pure functions — `runReplay.js`, `runDocument.js`, bucket mapping in `FlowEdge`); (d) motion policy audit — the only *continuous* animations remain: live-panel pulse/caret, active-node beams, active-edge dots.
