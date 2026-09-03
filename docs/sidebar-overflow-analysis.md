# Right sidebar overflow — analysis of the workflow run page

Task: "Analyze right sidebar structure and overflow causes" (analysis only; the fix is a
follow-up task). The goal of this document is that the implementing task can open the two
relevant files, apply the listed changes, and be done — every finding below names its
selector, its DOM owner, and the exact overflow mechanism.

Sources read in full for this analysis:

- `src/v2/Work.jsx` — the workflow run page; owns the right sidebar (`DetailsRail`).
- `src/v2/workStyles.css` — the complete stylesheet for every `.work-*` selector cited here.
- `src/v2/traceView.js` — the view model that produces the strings the sidebar renders.
- `src/v2/Shell.jsx`, `src/v2/DailyRoot.jsx`, `src/Root.jsx`, `src/main.jsx` — shell/routing context.

---

## 1. What "the right sidebar" is

The workflow run page is `Work.jsx` rendered in run mode (`div.v2-work.work-run-mode`).
Its body is a fixed three-column grid:

```css
/* workStyles.css */
.work-run-grid { flex: 1; min-height: 0; display: grid;
  grid-template-columns: 190px minmax(420px, 1fr) 310px; }
```

| Column | Component (`Work.jsx`) | Root element |
| --- | --- | --- |
| 1 (left rail) | `RunRail` | `aside.work-run-rail` |
| 2 (main) | `BlockEditor mode="run"` + `Interaction` + reply form | `main.work-run-main` |
| 3 (**right sidebar**) | **`DetailsRail`** | `aside.work-details` |

`DetailsRail` (tabbed: `log` / `result` / `runs`):

```text
aside.work-details                       DetailsRail
├─ div.work-details-tabs                 [ log | result | runs ]
├─ div.work-log                          tab "log" (overflow: auto)
│   ├─ button.work-open-trace            "Open full Trace"
│   ├─ button.work-show-earlier          "Show N earlier queries"
│   └─ details.work-query    × N         QueryEntry (one per model step)
│       ├─ summary > code{blockId} + span{request.model}
│       └─ div.work-query-body           when open
│           ├─ div.work-attempt × N      strong{…effective} · span{ms} · small{error}
│           ├─ p.work-metrics            tokens · tok/s · $
│           ├─ dl.work-query-facts       dt/dd: Finish, Token ceiling, Route
│           ├─ details×3 > pre.work-query-pre   Request sent / Internal reasoning / Visible response
│           └─ div.work-tool × N         strong{call.name} + span{running|error|done}
├─ div.work-results                      tab "result" (overflow: auto)
│   └─ article × N   > code{blockId} + pre{block.showing}
└─ div.work-runs                         tab "runs" (overflow: auto)
    └─ button × N    > strong{run.name ?? flowName ?? id ?? runId} + small{stage ?? status}
```

## 2. Container and layout chain — what can and cannot blow out

This matters because the fix must go where the defect actually is.

- `.work-run-grid` columns are `190px | minmax(420px, 1fr) | 310px`. The sidebar track is
  fixed at **310px** (≈264px of inner content width after the panes' 12px padding, card
  borders, and summary padding).
- The grid minimum content width is 190 + 420 + 310 = **920px**. At the width where the
  sidebar is visible (viewport > 1050px), `.v2-work` inner width is ≈ viewport − left nav
  rail − small paddings ≈ 960px or more, so the three tracks fit; at ≤1050px a media query
  hides the sidebar entirely and drops the grid to two columns. The risk band for sidebar
  overflow is therefore **≥1051px**, where the sidebar is permanently at its narrowest.
- **The 310px track itself cannot be blown out by content.** `.work-details` is
  `overflow: hidden`, which makes it a scroll container, so its automatic minimum size
  (`min-width: auto`) collapses to 0 — it shrinks to the track and clips. The same is true
  of `.work-run-rail` (`overflow: auto`) and `.work-run-main` (explicit `min-width: 0`).
  So "the sidebar pushed the layout wide" is **not** the failure mode on this page.
- The failure mode is **inside** the sidebar: flex/grid rows whose items keep the default
  `min-width: auto` (cannot shrink below their min-content width), rendering tokens with no
  soft-wrap opportunities (underscores, long letter/digit runs, URLs). Those rows grow past
  the card border (`overflow: visible` on the cards), the overflowing text paints outside
  the card, and the scroll panes (`.work-log` / `.work-results` / `.work-runs`,
  `overflow: auto`) convert the spill into inner horizontal scrollbars and layout jiggle.
  That is exactly the reported symptom: text spilling outside its container plus horizontal
  overflow inside the sidebar.

The one caveat to carry into the fix: `.work-details` only escapes track blowout *because*
of `overflow: hidden`. If that declaration is ever dropped or changed (e.g. to make the
sidebar sticky or resizable), the missing explicit `min-width: 0` becomes a real grid
blowout. Adding `min-width: 0` to `.work-details` is recommended belt-and-braces (§7).

## 3. Content structure — what long strings actually reach the sidebar

Field provenance (`traceView.js`, `runView` in `Work.jsx`):

- `entry.blockId` — stack block id (`stepView.blockId`). Block ids conventionally embed
  underscores (`auth_loop_research_9f81b2`), which have **no soft-wrap opportunity**.
- `entry.request.model` / `attempt.effective` — model ids, `effective` composed as
  `[provider, resolvedModel].join('/') || model` (`requestView`), e.g.
  `moonshotai/kimi-k3`, `openai/gpt-4.1-mini-2025-04-14`. Breakable at `/` and `-`, but
  wide.
- `attempt.error` — **raw provider error text** (`requestView.attempts[].error`): HTTP
  bodies, request ids (`req_…`), retry URLs, JSON fragments — single unbreakable tokens of
  arbitrary length. This is the field that carries fallback-resolved provider errors, so
  the "provider error" strings from the original request land here first.
- `route.line` — composed by `routeView`: on a degraded route,
  `asked for {requested}, answered by {effective} — {reason}` — a long composed sentence
  naming both models of a fallback. Rendered in `.work-query-facts dd`, which is already
  safe (`overflow-wrap: anywhere`) but shows where these strings concentrate.
- `call.name` — tool names. Tool ids in this codebase use underscore conventions
  (`mcp__filesystem__read_file`-style plugin-qualified names); underscores do not wrap.
- `block.showing` — block output text (result tab `pre`): arbitrary model/tool output —
  base64, hashes, minified JSON, long paths.
- `run.name ?? run.flowName ?? run.id ?? run.runId` — human/agent-chosen run names and run
  ids; names may contain underscores/paths, ids are hyphenated timestamps.

So every category named in the acceptance criteria (model names, tool names, parameter
values, error messages) reaches the sidebar, and each lands in a specific element listed
in §4.

## 4. Findings — exact overflow sources

Ordered roughly by frequency/impact. "Mechanism" for every finding is the same primer:
the element is a flex/grid item (or contains one) with default `min-width: auto`, and the
rendered token has no break opportunity, so the row cannot shrink to the card; `overflow`
on the card is `visible`, so the text visibly spills past the card border, and the pane's
`overflow: auto` turns the rest into a horizontal scrollbar.

### F1 — `.work-query > summary` (log tab, every query card) — high

- **DOM**: `QueryEntry` renders
  `<summary><code>{entry.blockId}</code><span>{entry.request?.model}</span></summary>`.
- **CSS**: `.work-query > summary { display: flex; justify-content: space-between; gap: 8px; padding: 9px; … }`.
  Neither child has `min-width: 0`, truncation, or `overflow-wrap`; `.work-query` itself
  sets no overflow.
- **Mechanism**: `code{blockId}` is the worst offender — underscore-bearing block ids are
  single unbreakable tokens; at the summary's 9px mono size (~5.4px/char) a 50-char id is
  ≈270px, which alone exceeds the ≈264px inner width. `span{model}` adds min-content on
  top, and `justify-content: space-between` pushes the second item past the right edge.
- **Symptom**: block id / model name visibly spills out of the query card's right border;
  the log pane grows a horizontal scrollbar.

### F2 — `.work-tool` rows (log tab, tool calls inside an open query) — high

- **DOM**: `<div className="work-tool"><strong>{call.name}</strong><span>{running|error|done}</span></div>`.
- **CSS**: `.work-tool { display: flex; justify-content: space-between; … }` — no wrap,
  no `min-width: 0`, no truncation on `strong`.
- **Mechanism**: plugin-qualified tool names with double underscores are unbreakable
  tokens; `strong` cannot shrink below min-content and pushes the status `span` out of the
  card.
- **Symptom**: tool name spills past the query card; horizontal scrollbar in the log pane.

### F3 — `.work-attempt small` (attempt error line) — high, and the fallback-error case

- **DOM**: `<small>{attempt.error}</small>` inside
  `<div className="work-attempt">` (e.g. "Failed `moonshotai/kimi-k3` — `429 …`").
- **CSS**: `.work-attempt { display: flex; flex-wrap: wrap; … }` with
  `.work-attempt small { flex-basis: 100%; … }` — **no `overflow-wrap`** anywhere in the
  chain (contrast: `.work-query-facts dd` and `.work-query-pre` both have
  `overflow-wrap: anywhere`; this element was missed).
- **Mechanism**: provider error strings contain URL/request-id/JSON tokens with no break
  opportunities; `flex-basis: 100%` forces the line but does nothing about token width.
- **Symptom**: raw provider error text spills horizontally out of the query card. This is
  the exact string family the original request describes (fallback-resolved provider
  errors) — they are currently rendered full-width here (and in the header, F7).

### F4 — `.work-results article` (result tab) — high

- **DOM**: `<article><code>{id}</code><pre>{block.showing}</pre></article>`.
- **CSS**: `.work-results article code` — no wrapping/truncation (same underscore-token
  risk as F1). `.work-results pre { white-space: pre-wrap; … }` — `pre-wrap` only wraps at
  existing soft-wrap opportunities, and this `pre` **lacks `overflow-wrap: anywhere`**
  (unlike `.work-query-pre`, which has it and is safe).
- **Mechanism**: block output is arbitrary model/tool text; one long base64/hash/URL token
  exceeds the card.
- **Symptom**: spilled text plus a horizontal scrollbar on the whole results pane (the
  most common visible case, since block output is unbounded).

### F5 — `.work-runs button` (runs tab) — medium

- **DOM**: `<button><strong>{run.name ?? run.flowName ?? run.id ?? run.runId}</strong><small>{stage}</small></button>`.
- **CSS**: `.work-runs button { display: flex; flex-direction: column; … }` — no
  `overflow-wrap` on `strong`/`small`.
- **Mechanism**: run names containing underscores/paths (or ids, mostly hyphen-safe) have
  unbreakable tokens; in a column flex the box stretches correctly but the **text**
  overflows the button border.
- **Symptom**: long run names spill out of the run card.

### F6 — `.work-query-body` grid items generally (structural note) — low

`.work-query-body { display: grid; gap: 8px; … }` has a single implicit `auto` column.
Items with unbreakable min-content (F2, F3) can push the track past the body width; the
visible result is identical to the item-level spill. Fixing the items' wrapping
(`overflow-wrap: anywhere`) collapses their min-content and resolves the track growth too,
so no separate grid rule is needed — just don't add fixed-width content here later.

### F7 — Adjacent, same page, same defect class (flagged, out of sidebar scope)

- `.work-model-status span` renders `latestAttempt.error` — the same raw provider error —
  in the run header flex row with no bound, so a long error token overflows the header.
- `code.work-run-id` (run id in the header) has no truncation; it is only hidden ≤900px.
- The `Interaction` approval card's `<pre>` (`.work-interaction pre`, main column) is
  `pre-wrap` without `overflow-wrap: anywhere` — long unbreakable strings inside tool
  argument JSON spill. Parameter values therefore overflow on this page **outside** the
  sidebar (inside the sidebar, parameter values only appear inside `pre.work-query-pre`,
  which is already safe).
- The Trace overlay (`src/v2/Trace.jsx`) renders the same `traceView` shapes and likely the
  same `.work-log article` selectors (dead on the run page since the log switched to
  `details.work-query`, but present in `workStyles.css`); it should get the same treatment
  as a follow-up, not in the sidebar fix.

## 5. What is already correct (the repo's own fix patterns to copy)

- `.work-rail-step > span:last-child { min-width: 0 }` + `strong { white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis }` — the left rail does it right.
- `.work-run-models code { max-width: 170px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap }` — header model chips are clamped.
- `.work-query-pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px;
  overflow: auto }` — long request/response/reasoning text is fully contained.
- `.work-query-facts dd { overflow-wrap: anywhere }` — long fallback `route.line`
  sentences wrap correctly (they get tall, not wide — correct behavior).
- `.work-run-main { min-width: 0 }`, `.work-run-title { min-width: 0 }` — main column and
  header title are contained.

The right sidebar simply never received the same pass the left rail and header got.

## 6. Recommended fixes (minimal, per selector — all in `workStyles.css`)

1. **F1** — clamp the summary children:
   ```css
   .work-query > summary > code { min-width: 0; flex: 1 1 auto;
     overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
   .work-query > summary > span { flex: none; max-width: 55%;
     overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
   ```
   (Ellipsis fits the block id's role as identity; the model span stays secondary.)
2. **F2** — `.work-tool strong { min-width: 0; overflow: hidden; text-overflow: ellipsis;
   white-space: nowrap; }` and keep `.work-tool span { flex: none; }`.
3. **F3** — `.work-attempt strong { min-width: 0; overflow-wrap: anywhere; }` and
   `.work-attempt small { overflow-wrap: anywhere; }` (wrap, not ellipsis: these lines are
   error evidence and must stay readable).
4. **F4** — `.work-results pre { overflow-wrap: anywhere; }` (match `.work-query-pre`) and
   `.work-results article code { display: block; overflow-wrap: anywhere; }` or ellipsis.
5. **F5** — `.work-runs button strong, .work-runs button small { overflow-wrap: anywhere; }`
   (optionally a 2-line `-webkit-line-clamp` on `strong`).
6. **Belt-and-braces** — `.work-details { min-width: 0; }` so the grid track stays safe
   even if `overflow: hidden` is later changed.
7. Optional catch-all for future id fields inside the sidebar:
   `.work-details code { overflow-wrap: anywhere; }`.

## 7. Verification plan for the implementing task

- Add a renderer/DOM test with adversarial fixtures — a 50+ char underscore block id, an
  `mcp__plugin__tool`-style name, a 400-char provider error URL, a base64 block output —
  asserting `scrollWidth <= clientWidth` for `aside.work-details`, each `details.work-query`
  card, each `article`, and the three panes (`div.work-log/.work-results/.work-runs`), at a
  fixed 1051–1100px viewport (the worst band) — before and after the change.
- Manual pass at 1051 / 1280 / 1600px, light and dark themes, with a run that contains a
  fallback (`route.degraded`) and a failed attempt, open and closed query cards.
- Confirm the ≤1050px and ≤760px media queries still hide the sidebar/rail as before.

## 8. Method and limits of this analysis

- Every `.work-*` selector cited lives in `src/v2/workStyles.css`, which was read in full;
  `Work.jsx` (which renders all sidebar DOM) and `traceView.js` (which shapes all sidebar
  strings) were read in full, so the finding list is complete for the sidebar as shipped.
- The global sheet `src/styles.css` (~250KB) was spot-checked (design tokens, header and
  activity patterns) but not exhaustively audited for element-level `code`/`pre`/`summary`
  defaults. That can only change emphasis, not the findings: none of the sidebar-specific
  rules for the affected elements set any wrapping or truncation, so the default
  (`overflow-wrap: normal`, flex/grid `min-width: auto`) governs regardless.
- Page-level containment was verified down to `.v2-work` (`min-width: 0`,
  `overflow: hidden` in run mode) plus the 920px grid minimum and the ≤1050px media query;
  the `.v2-shell-body` / `.v2-panel` rules were not audited and do not affect the
  sidebar-internal findings.
- Related context: the long error/route strings analyzed here are the same ones the
  provider-fallback task (issue 1 of the original request) wants demoted from banners to
  log-level detail. This document only records where those strings render and why they
  overflow; the severity/UX change belongs to that task.
