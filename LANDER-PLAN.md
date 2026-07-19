# Lander — Design & Implementation Plan

**Feature:** The chat-first home surface of every project tab. First thing a user sees; the app's first impression.
**Status:** Phases 1–6 built & verified (2026-07-19). The only remaining item is the dot-morph unfold upgrade (the Phase 4 stretch), deferred to real-Electron work — see §5 / §7.
**Read alongside:** `PRODUCT-SPEC.md` §2/§5 (chat-as-primary-interface intent), `DESIGN-SPEC.md` (Slate & Sage rules), `DESIGN-POLISH-IDEAS.md` (techniques reused here), `TABS-DECISIONS.md`/D22 (tab = project).

---

## 1. Decisions made (owner, 2026-07-19)

- **L1 — Placement:** the lander is the **home of every tab**. Each project tab opens on it. Canvas, flows, runs remain reachable via the rail, but the composer is the front door.
- **L2 — Submit behavior:** **chat unfolds into the live canvas.** The first message becomes the run's User Input; the workflow graph materializes and lights up as it executes. This is the signature moment.
- **L3 — Workflow selection:** **subtle chip in the composer** (like Claude's model picker). Default workflow pre-selected; familiar first, power discoverable.
- **L4 — Flare anchor:** **living constellation** — a faint, slowly drifting node-graph ambient behind the empty chat: the canvas "asleep" under the surface, waking on submit. Chosen because it *is* the unfold moment's setup, not decoration on top of it.
- **L5 — App-open lander (owner addition, 2026-07-19):** on first open (or when no tab is active) the app lands on the **same chat window, with no project**. Typing there and pressing Run **auto-creates a project** in the app's appdata folder — its own project directory, auto-named from the first prompt (slug heuristic, e.g. "fix-auth-flow"; renameable anytime; AI-rename possible later). The user is never forced through a folder picker to start.
- **L6 — Scratch tab retired:** the auto-created appdata project **replaces** the unbound "scratch tab" concept. Every tab is a project; unbound work just lives in an appdata-backed project. One mental model.

## 2. The one-sentence brief

> Open a tab and you're in a chat window you already know how to use — except the canvas is faintly breathing underneath it, and when you press Enter the message doesn't disappear into a box: the graph wakes up around it and you watch the work happen.

Familiarity is the shell (composer, placeholder, Enter-to-send, recent history below). The differentiator (transparency, workflows, the canvas) is *revealed*, never front-loaded.

And per L5, the very first launch obeys the same rule: no setup, no folder picker, no empty-state wall — a chat window that works immediately. The project entity is created *behind* the first message, not in front of it.

### 2.1 The projectless lander (L5/L6)

The app-open lander is the same `Lander.jsx` in a **projectless state**, not a separate surface:

- **When shown:** first launch, and whenever no tab is active (all tabs closed).
- **Differences from the per-tab lander:** greeting is "What should we build?"; constellation is seeded from a fixed app seed (a *neutral* constellation — projects get distinctive ones); no recent-runs strip (there is no project) — instead a compact **recent projects** list (reusing the recents data from `NewTabPage`), plus a quiet "Open folder…" link for users who want to bind an existing repo up front.
- **On submit:** before the normal run path, the app (1) derives a project name from the first prompt — lowercase slug of the leading meaningful words, deduped with a numeric suffix; (2) creates `<appData>/projects/<slug>/` with the standard project structure; (3) opens it as a new tab; (4) proceeds with the unfold + run exactly as §5. The name-derivation is a cheap synchronous heuristic so it never delays the run; an AI-suggested rename can come later. Rename is available from the tab context menu.
- **Adoption path:** an appdata project can later be bound to a real folder ("Move to folder…"), migrating its files. Specified here as a follow-up (Phase 6), not v1-blocking — but the storage layout must not preclude it.
- **Scratch retirement (L6):** `onOpenScratch` / the unbound-tab special case is removed; the 'default' scratch project's existing runs migrate into an appdata project named `scratch` on first launch of this version. `NewTabPage` drops its Scratch button; the projectless lander covers that need better.

---

## 3. Layout (empty state)

```
┌─ tab strip ──────────────────────────────────────────────┐
│ ┌rail┐ ┌────────────────────────────────────────────────┐│
│ │ ⌂  │ │            (living constellation, faint)       ││
│ │ ⎇  │ │                                                ││
│ │ ▦  │ │        ✳ project sigil (small, quiet)          ││
│ │ ⟲  │ │        What should we build in <project>?      ││
│ │    │ │                                                ││
│ │    │ │   ┌──────────────────────────────────────────┐ ││
│ │    │ │   │ Describe what you want…                  │ ││
│ │    │ │   │                                          │ ││
│ │    │ │   │ [◇ Coding Agent ▾]              [Run ↵]  │ ││
│ │    │ │   └──────────────────────────────────────────┘ ││
│ │    │ │                                                ││
│ │    │ │   Recent   ✳ fix-auth-flow   2h · done  12/12  ││
│ │ ⚙  │ │            ✳ dark-mode-pass  1d · done  8/8    ││
│ └────┘ └────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

Element notes:

- **Greeting.** One line, IBM Plex Mono `section-label` styling above a larger set title. Uses the project name ("What should we build in `llm-flow`?"); projectless state: "What should we build?". No time-of-day greetings, no exclamation marks — the app's voice is a quiet colleague, not a mascot.
- **Composer.** A multiline textarea, autofocused, `Enter` runs / `Shift+Enter` newline. Visually the brightest thing on screen (`--panel` on `--app`, 1px border, soft shadow, accent focus ring). Max-width ~680px, vertically at ~38% viewport height so it sits slightly above center — the composer placement every chat app has trained users on.
- **Workflow chip (L3).** Bottom-left inside the composer, like an attachment/model chip: small diamond glyph + workflow name + caret. Click opens a compact popover listing workflows (reuses the existing flow list data). Persisted per-tab (last used). The chip is the *only* place workflow choice appears on the lander.
- **Run button.** Accent-filled, right-aligned in the composer footer. Shows `↵` hint. Disabled with muted style when textarea is empty.
- **Recent runs strip.** Below the composer: up to 5 recent runs for this tab, each row = run sigil + name + relative time + `done n/n` stat. Clicking opens that run (Runs section, same as today). This replaces "empty page syndrome" for returning users and quietly advertises the sigil identity system. Empty project: a single muted line — "Runs will appear here."
- **Rail.** Unchanged, but gains a Home entry (see §6). The lander is a section, not an overlay — Esc doesn't dismiss it, it *is* the page.

### What we deliberately leave out

No feature tour, no sample-prompt chips ("Try: build a snake game"), no changelog, no settings nudges. Every competing app clutters this screen eventually; shipping it empty is part of the flare. One exception: a first-ever-launch state (no key configured) shows a single inline line under the composer — "Add an OpenRouter key in Settings to run" — linking to Settings.

---

## 4. The living constellation (L4)

The empty lander's background is a sparse node-graph — 10–14 dots, 8–12 connecting lines — in `--line`/`--muted` tones at low opacity (≈0.35 light / 0.5 dark), drifting almost imperceptibly. It reads as texture at a glance and as "there's a canvas under this" on the second look.

**Construction:**

- One absolutely-positioned SVG behind the content (`pointer-events: none`, `z-index` below everything, `contain: strict`).
- Node positions **seeded from the project id** using the existing FNV-1a hash + PRNG from `sigil.js` — every project gets its *own* constellation, stable across launches. The sigil system's determinism becomes an app-wide identity principle: *your project has a face*.
- Drift: each dot animates along a tiny (8–14px) elliptical `offset-path`, duration 20–40s, staggered phases. Compositor-only (`offset-distance` — same technique as the edge-dots idea, `DESIGN-POLISH-IDEAS.md` #2). Lines are drawn between fixed *anchor* positions and do **not** animate (redrawing lines per-frame would need JS; anchoring them keeps this zero-JS-per-frame). The dots drift *around* their anchors, so the graph feels alive without the lines ever moving.
- `prefers-reduced-motion`: dots render static. The constellation still does its identity job with zero motion.
- Interaction wink (cheap, optional, Phase 4): while the composer has focus, constellation opacity eases up ~15% and the dot nearest the composer gains an accent tint — the canvas noticing you're about to speak. Two CSS rules via `:focus-within`.

**Hard rules:** never legible as a *real* workflow (it's abstract, not the selected workflow's graph — that would promise the wrong thing), never above 0.5 opacity, never animates layout, single shared `@keyframes`.

## 5. The unfold (L2)

The submit moment, in order:

1. **Send.** User presses Enter. The composer's text lifts into a compact **user-message card** (right-aligned, chat-style — the familiar beat) that becomes the run's User Input node representation. Composer clears and shrinks to a single-line docked bar at the bottom (disabled during the run in v1 — follow-up input is out of scope, see §8).
2. **Wake.** The constellation dots brighten and glide to the *actual* layout positions of the selected workflow's nodes (`flowLayout.js` gives target positions; animate `offset-path`/`transform` to them, ~450ms, standard ease). Dots that have no node target fade out; missing ones fade in. The abstract graph resolves into the real one.
3. **Materialize.** Constellation crossfades out as the real FlowCanvas fades in at the same positions (one `startViewTransition` wrapping the section swap — the existing `withViewTransition` helper in `App.jsx` already does this for section changes). Run starts (`runFlow`), nodes light up via the existing live-canvas machinery.
4. **Frame.** RunBar appears at top; the user-message card docks as/next to the User Input node. From here it's the existing run view — the lander has handed off.

Total budget: under 700ms from Enter to live canvas. If the View Transitions choreography proves fiddly, the *fallback* is: steps 1–2, then a plain crossfade — still distinctive, half the risk. Build the fallback first, upgrade to the dot-morph after (Phase 4).

Reduced motion: instant swap to run view (the existing `withViewTransition` reduced-motion branch handles this for free).

---

## 6. Architecture & code touchpoints

The lander is a **new section** rendered per-tab, becoming the default `section` value.

| Change | Where | Notes |
|---|---|---|
| `Lander.jsx` (new) | `src/` | Greeting, composer, workflow chip, recent strip, constellation. ~250 lines. |
| `Constellation.jsx` (new, or inline) | `src/` | Pure component: `(projectId, width, height) → SVG`. Reuses `hash`/`rng` exported from `sigil.js` (export them — currently module-private). |
| Add `home` to `NAV` + rail icon | `src/App.jsx` | Icon: small sigil-burst or a house in the existing 1.6-stroke geometric language. `Ctrl+1` becomes Home; Flows/Library/Runs shift to `Ctrl+2/3/4`. |
| Default section per tab → `home` | `src/App.jsx` | Tab open/switch lands on Home. Per-tab remembered selection machinery already exists for sections — extend, don't rebuild. |
| Submit path | `src/App.jsx` | Lander submit calls the **existing** `runFlow` path (line ~923: `window.llmflow.runFlow(tab, flowId, input, workspace)`) then navigates to the run. No engine changes. The lander is a new face on `RunBar`'s input path, not a new pipeline. |
| Workflow chip data | `src/App.jsx` → `Lander` | Flow list is already loaded for the Flows section; pass it down. Persist last-used per tab in the same store as per-tab section memory. |
| Recent strip data | `src/App.jsx` → `Lander` | `runs` list already loaded per tab; slice(0,5). Reuse `sigil()` + `runProgress` stat formatting from `RunsList.jsx`. |
| Unfold choreography | `src/App.jsx` + `styles.css` | Wrap navigate-to-run in `withViewTransition`; Phase 4 adds the dot-morph. |
| Styles | `src/styles.css` | ~120 lines: `.lander`, `.lander-composer`, `.lander-chip`, `.lander-recent`, `.constellation`. All colors from existing derived tokens; **no new hues**. |
| Projectless state (L5) | `src/App.jsx` + `Lander.jsx` | Render `Lander` with `project=null` when no tab is active (replaces today's implicit scratch default). Pass recents list down for the recent-projects strip. |
| `createProject(name)` IPC (new) | `electron/main.js` + preload | Creates `<appData>/projects/<slug>/` with the standard structure, registers it as a tab, returns its id. Slug derivation + dedupe lives main-side so it's atomic with the mkdir. |
| Scratch retirement (L6) | `electron/main.js`, `src/App.jsx`, `src/TabStrip.jsx` | Remove `onOpenScratch` path + unbound-tab special cases; one-time migration of the 'default' scratch runs into an appdata project named `scratch`. |
| Rename project | `src/TabStrip.jsx` + IPC | Tab context-menu rename (folder rename for appdata projects; display-name only for bound folders). |

**Explicit non-changes:** no engine work, no new files under `core/`, no new persisted state beyond one per-tab `lastFlowId` key and the appdata `projects/` directory. `NewTabPage` survives as the "open a project" picker but loses its Scratch button.

### Open questions — resolved during build

- **Q-L1 (Phase 5):** RESOLVED — the rail stays **visible** on the lander. Hiding chrome on the home page would make the other sections feel like a different app.
- **Q-L2 (Phase 2b):** RESOLVED — **purpose-built** picker. No existing dropdown component to reuse; the picker is a compact keyboard-navigable listbox in `Lander.jsx`.
- **Q-L3 (Phase 5):** RESOLVED — greeting stays "What should we build?"; the composer stays **silent** about auto-create. Only the empty projectless recents state hints it ("we'll create a project for you"), so returning users aren't nagged.
- **Q-L4 (Phase 2):** RESOLVED — `core/projectName.js`: lowercase the first line, drop stop words (keep the imperative verb), keep ≤4 words / 40 chars, dedupe with `-2/-3`. Deterministic + instant; covered by `tests/projectName.test.js`.
- **Q-L5 (Phase 2):** RESOLVED — an appdata project's runs bind to `<project>/workspace/` (`entry.workspaceRoot`), created on first run via the same `Workspace` path a bound folder uses.

---

## 7. Implementation phases

Each phase ships alone and leaves the app working. Test after each (`npm test`, plus manual dev-run).

**Phase 1 — Static lander (the skeleton).** `Lander.jsx` with greeting, composer (non-functional chip showing default flow name), Run button wired to the existing `runFlow` path, plain navigation to the run view on submit. Add `home` section + rail entry + default-section change. *Exit: open tab → lander → type → Enter → watching a live run. Everything else in later phases is polish on this working spine.*

**Phase 2 — Projectless lander + auto-create (L5/L6).** `createProject` IPC; projectless `Lander` state with recent-projects strip and "Open folder…" link; submit → create appdata project → open tab → run; slug heuristic (Q-L4); scratch retirement + one-time migration; tab rename. *Exit: fresh install → type → Enter → running, with a named project tab that persists across restarts.*

**Phase 2b — Composer completeness.** Workflow chip popover with real flow list; per-tab last-used persistence; empty/disabled states; keyboard (Enter/Shift+Enter, Esc closes popover, `Ctrl+1` focuses composer); first-launch no-key hint line.

**Phase 3 — Recent strip + constellation (static).** Recent-runs rows with sigils; seeded constellation rendered static (no drift yet). This is where the screen starts looking like *ours*. Verify light/dark + theme flip via view transition.

**Phase 4 — Motion.** Constellation drift (offset-path, staggered); focus wink; the unfold — crossfade version first, then the dot-morph-to-layout upgrade if the crossfade feels flat. Reduced-motion paths for all three. Perf check: idle lander must stay at ~0% CPU when occluded/backgrounded (verify `contain` + compositor-only claims in DevTools performance panel — same discipline as `DESIGN-POLISH-IDEAS.md`).

**Phase 5 — Polish & copy pass.** `design:ux-copy` on greeting/placeholder/empty states; `design:design-critique` on the whole surface; accessibility pass (focus order: composer → chip → run → recents; ARIA on the popover; constellation `aria-hidden`); resolve Q-L1..L3.

**Verification (every phase):** existing test suite green; manual matrix = {light, dark} × {bound tab, appdata project, projectless first launch} × {empty project, project with runs} × reduced-motion on/off. Phase 2 additionally: migration from a pre-L6 install with scratch runs.

---

## 8. Out of scope (recorded so nobody scope-creeps the first impression)

- **Conversational follow-ups** (chatting *during/after* a run from the docked bar) — big feature, own plan. The v1 docked bar is inert during a run.
- AI-suggested workflows / prompt autocomplete, and AI-suggested project renames (heuristic slug only in v1).
- "Move to folder…" adoption of an appdata project into a real repo (specified in §2.1, built as Phase 6).
- Onboarding tours, sample prompts, template galleries.
- Any marketing-site lander — this document is the *in-app* home only.

## 9. Success criteria for "good first impression"

1. A Cursor/Claude Code user opens a tab and needs **zero instruction** to get a run started (familiarity test).
2. Within the first session they've *seen* the canvas do its thing without ever being told it exists (the unfold does the teaching).
3. The empty lander is identifiable as LLM Flow in a screenshot with the logo cropped out (constellation + sigil + Plex Mono voice = flare test).
4. Idle lander: no measurable CPU, no motion complaints under reduced-motion.
