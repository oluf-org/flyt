# LLM Flow — Design Polish Ideas

**Status:** Idea backlog, not a plan. Nothing here is committed.
**Companion:** `design-demos.html` — every idea marked ▶ has a working example there. Open it in any Chromium browser (or drag into the app window).

**Why "works 100%" is provable here:** the app ships Electron 33 → **Chromium 130, pinned**. There is no cross-browser matrix. Every feature below is stable in Chromium ≤130, so it either works on your machine today or it doesn't — no "works for 92% of users." That's the superpower of designing for Electron: you can use the newest platform CSS years before web apps can.

**Ground rules (from GOALS.md / DESIGN-SPEC §2.2, kept intact):**
- One accent, spent deliberately. Ideas below add *technique*, not new colors.
- Motion is deliberate and legible, not a screen full of competing animation.
- Performance rule of thumb used throughout: prefer compositor-only properties (`transform`, `opacity`), paint-contain anything that animates, never animate layout.

---

## Tier 1 — high impact, near-zero risk

### 1. ▶ Conic border-beam as the "running" signal
Replace/augment the spinner on active nodes with a thin animated gradient that sweeps around the node's border — a `@property`-registered `--angle` driving a `conic-gradient` border. It reads as "energy flowing around this unit of work," scales to parallel waves (several nodes glowing is calm, several spinners is noisy), and is visible at any zoom level where the 12px spinner isn't.

- **How:** `@property --angle { syntax: '<angle>' }` + `border-image: conic-gradient(from var(--angle), transparent 0 70%, var(--accent) 85%, transparent 100%) 1` or a padded pseudo-element mask. Animate `--angle` only.
- **Perf:** paint-only, scoped to the node; add `contain: paint`. One `@keyframes` shared by all active nodes. Registered-property animation runs on the fast path in Chromium.
- **Fits D9:** parallel nodes each glow; the *live panel* remains the single narrating element.

### 2. ▶ Signal dots traveling along active edges
The canvas is "the live transparency view of execution" (§6.1), but edges are static. Put a small dot moving along the actual edge path on edges whose source is producing — data visibly flowing downstream. This is the single most "alive" thing you can add to a node canvas, and it's pure CSS.

- **How:** React Flow gives you the SVG path; render a 3px circle with `offset-path: path(var(--edge-d))` and animate `offset-distance: 0% → 100%`. No JS per frame.
- **Perf:** `offset-distance` is compositor-animatable in Chromium. Cap at ~1 dot per active edge; dots only exist while `status-active`.

### 3. ▶ View Transitions for theme swap and page changes
`document.startViewTransition()` (same-document) turns the theme toggle and the Runs ⇄ Canvas ⇄ Nodes page switches into a single smooth crossfade — and elements given a `view-transition-name` (a run card → run header) *morph* between pages instead of blinking.

- **How:** wrap the state change: `document.startViewTransition(() => setPage(...))`. That's genuinely the whole API. Your existing `.24s` crossfade tokens transfer directly to `::view-transition-old/new`.
- **Perf:** browser-composited snapshot crossfade; cheaper than the per-element `transition: all-colors .24s` you currently apply to `.app *` — in fact, adopting it lets you *remove* that broad transition rule (a known style-recalc cost on large trees) and keep the same feel.
- **Reliability:** if unsupported it just runs the callback with no transition. Zero-risk progressive enhancement, but on Chromium 130 it's fully supported anyway.

### 4. ▶ `content-visibility: auto` on long lists
Runs list, log view, live stream history: give each row `content-visibility: auto; contain-intrinsic-size: auto 48px`. Off-screen rows skip layout & paint entirely — virtualization without a virtualization library, which matters as `runs/` grows into hundreds of entries.

- **Perf:** this is a pure win; it's the feature's entire purpose. No visual change at all.

### 5. ▶ Derived color system: `color-mix()` + relative color syntax + `light-dark()`
The palette hand-maintains ~25 hex pairs. Derive them instead from **two decisions** (accent hue, neutral tint) — `--accent-soft: color-mix(in oklab, var(--accent) 12%, var(--card))`, `--err: oklch(from var(--accent) l c calc(h + 155))` — and collapse the dual theme blocks with `light-dark()` + `color-scheme`. Polish payoff: every tint is *mathematically* related, so nothing ever looks slightly off between themes, and trying a new accent is a one-line experiment.

- **Perf:** resolved at style time, zero runtime cost.
- **Note:** keep the literal hexes as fallback comments; oklch mixing is also how you get perceptually-even hover/press shades (`color-mix(in oklab, var(--accent) 88%, black)`).

---

## Tier 2 — distinctive, still cheap

### 6. ▶ Anchor positioning + Popover API for tooltips and menus
Port titles (`node-port title=…`) and kebab menus currently rely on native tooltips / manual positioning. CSS Anchor Positioning (`anchor-name` / `position-anchor` / `position-try-fallbacks`) plus `popover` attribute gives you: instant styled tooltips, top-layer rendering (never clipped by the canvas), automatic flip when near a window edge — with **no positioning library and no JS math**.

- **Perf:** layout handled natively; removes floating-ui-style per-frame JS if you were ever tempted.
- This is the newest thing on the list (Chromium 125+) and almost nobody ships it yet — it reads as "how is this so smooth" polish.

### 7. ▶ Spring feel via `linear()` easing
Micro-interactions (node select pop, inspector panel rise, gate-approve button press) get real spring physics with the `linear()` easing function — a precomputed spring curve in one custom property, e.g. `--spring: linear(0, 0.36 5.8%, …, 1)`. No JS animation lib, no rAF.

- **Perf:** identical cost to `ease-out`; it's just a timing function. Use on `transform: scale()` only.

### 8. ▶ Scroll-driven progress + fades (zero JS)
- Log / result panes: a 2px accent **reading-progress bar** via `animation-timeline: scroll()`.
- Live stream: top/bottom **fade masks** that appear only when there's actually overflow, via `animation-timeline` + `mask-image`.
- Runs list: rows gently settle in with `animation-timeline: view()` (once, subtle, 60ms stagger — respects the motion policy since it only plays while scrolling).

- **Perf:** scroll-driven animations run off the main thread. This is the flagship "newest of the new" feature that costs nothing.

### 9. ▶ `field-sizing: content` + `interpolate-size`
- Prompt/User-Input textareas auto-grow to content with **one CSS line** (`field-sizing: content; max-height: …`) — delete any JS resize logic.
- Inspector accordion sections animate open to `height: auto` with `interpolate-size: allow-keywords` — the classic "impossible" animation, now two lines of CSS (Chromium 129+).

### 10. ▶ Texture: micro-noise on the canvas plane
A single static SVG `feTurbulence` data-URI at ~2.5% opacity over `--canvas` kills the "flat app-in-a-box" look and gives the dot-grid plane a paper feel, in both themes. Static image, tiled by the GPU — this is the cheapest "expensive-looking" trick in modern UI (Linear/Arc-style).

- **Perf:** it's a background-image. Zero ongoing cost. Do **not** use `backdrop-filter` grain or animated noise.

### 11. Typographic micro-polish (one-liners)
- `font-variant-numeric: tabular-nums` on timers, token counts, run durations — numbers stop jittering as they tick.
- `text-wrap: balance` on empty-state copy and dialog titles; `text-wrap: pretty` on paragraph copy.
- `hanging-punctuation` no (not in Chromium) — skip.
- `text-box-trim: trim-both cap alphabetic` (Chromium 128+) to optically center labels in chips/buttons — the subtle misalignment you can never quite fix with padding, fixed for real.

---

## Tier 3 — bigger swings (still perf-safe, more design work)

### 12. Depth model: layered canvas parallax at rest
Give the three planes (chrome / panels / canvas) a *static* depth story instead of borders doing all the work: canvas dot-grid + noise sits lowest, panels cast your existing `--shadow-float` inward, and node cards get a 1px top-highlight (`inset 0 1px 0 color-mix(in oklab, white 60%, transparent)`) for a machined feel. No motion — depth from light, not parallax scrolling.

### 13. The run as a "heartbeat" surface
While a run is live, the app chrome itself acknowledges it minimally: the titlebar's accent strip (already your "you are here" cue) breathes at the live panel's cadence — one shared `@keyframes`, `opacity` only, and *only* the strip. Stops on completion; failure flashes `--err` once. The point: you can feel a run from any page, without adding a single new region of motion.

### 14. Progressive canvas semantics at zoom (a real "out of the box" one)
Treat zoom like a map's level-of-detail. Zoomed out: nodes render as status-colored capsules with icon only (labels hidden — they're unreadable anyway), edges thicken, the *shape of the run* becomes the UI. Zoomed in: full cards with ports. React Flow exposes zoom; switch with a class at two thresholds, crossfade with View Transitions.
- **Perf:** *improves* at scale — fewer text nodes painted when zoomed out on a big orchestrator fan-out.

### 15. Command palette as the polish keystone
Not novel tech, but the single strongest "this app is finished" signal: `<dialog>` + `::backdrop` (blur only the 560px dialog area, not whole-window `backdrop-filter`), fuzzy match over flows/nodes/runs/actions, spring-in with `linear()`. Everything above makes it cheap to build well.

---

## Anti-ideas (rejected on your own constraints)

- **Whole-window glassmorphism / `backdrop-filter` on large panels** — the one trendy technique that *does* cost real GPU time per frame over a live canvas. Confine blur to small, transient surfaces (dialog backdrop, popovers) or skip.
- **Animated mesh-gradient backgrounds** — competes with the canvas as the center of attention; violates the motion policy.
- **3D node tilt / WebGL flourishes** — perf and pointless on a tool whose job is legibility.
- **Skeleton shimmer everywhere** — file-based state loads instantly from disk; shimmer would be fake latency theater.

## Feature-support receipt (Chromium 130 = Electron 33)

| Feature | Since | | Feature | Since |
|---|---|---|---|---|
| `@property` animation | 85 | | Popover API | 114 |
| `content-visibility` | 85 | | `linear()` easing | 113 |
| `:has()` | 105 | | Scroll-driven animations | 115 |
| View Transitions (same-doc) | 111 | | Relative color (`oklch(from …)`) | 119 |
| `color-mix()` | 111 | | `light-dark()` / `field-sizing` | 123 |
| `offset-path`/`offset-distance` | 55/116-compositor | | Anchor positioning | 125 |
| `text-wrap: balance` | 114 | | `text-box-trim` | 128* |
| `<dialog>` + `::backdrop` | 37 | | `interpolate-size` | 129 |

\* `text-box-trim` shipped unprefixed in 128; verify in your build before relying on it (not in the demo page — it's the one item here to eyeball first).
