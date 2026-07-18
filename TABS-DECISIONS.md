# Project Tabs — Decisions Needed

**Feature:** A browser-style tab strip at the top of the window, one tab per project.
**Status:** All items `Open` unless marked otherwise. Format follows `DECISIONS.md` (Context → Options → Recommendation).

**Why this is bigger than UI:** today the app has *no project entity*. `flows/`, `runs/`, and `nodes/` are single global directories at the app root (`electron/main.js:37-39`), and a workspace folder is bound *per run* at start time (D15). Tabs "for projects" therefore forces data-model decisions before any UI work.

---

## A — Data model (decide first; everything else depends on these)

### T1 — What *is* a project?
**Context.** Candidates: (a) a bound workspace folder (the repo the agent works on), (b) a new grouping entity (name + workspace + its flows/runs), (c) merely a saved window-state ("this tab was looking at flow X").
**Options.** (a) is closest to D15/DESIGN-SPEC §workspace: project = target folder, `.llmflow/` inside it is its config. (b) adds indirection (projects without folders). (c) is cheap but isn't really "projects".
**Recommendation.** (a): tab = workspace folder. Matches the browser mental model (tab = site, here tab = repo) and the existing `.llmflow/` direction.

### T2 — Which data becomes per-project: flows, runs, templates?
**Context.** All three are global today. The same flow run against two projects behaving differently is an existing, tested design point — so flows *can* stay global.
**Sub-decisions.**
- **Flows:** global (shared across tabs) vs per-project (live in `.llmflow/flows/`, travel with the repo) vs global + per-project override.
- **Runs:** almost certainly per-project (a run is meaningless without its workspace) — but confirm. Where stored: `.llmflow/runs/` inside the repo (pollutes it, needs .gitignore) vs appdata keyed by project path (survives repo deletion oddly)?
- **Node Library templates:** global (reusable expertise, current GOALS.md framing) vs per-project. GOALS.md already splits this: templates name a skill, the project supplies `.llmflow/skills/<name>.md`. Suggests templates stay global.
**Note.** `RunStore` locks per runs/ directory ("one instance per runs/ directory") — per-project runs means one store instance per open tab, which the lock design already supports.

### T3 — Migration of existing data
**Context.** `flows/`, `runs/` (40+ runs), `nodes/` exist at the app root.
**Options.** Fold into an implicit "default project"; migrate into a chosen workspace on first launch; leave global data readable everywhere.
**Also decide:** can a tab exist *unbound* (scratch project, like today's "No workspace" runs), or must every tab have a folder?

### T4 — Per-project settings & config
**Context.** `config.json` (workers, retry, categoryWorkers) is app-global; `settings.json` in userData overrides the executor. `.llmflow/` was already planned as per-project config (D15).
**Decide.** Which settings become per-project (worker/model routing? category workers?) and which stay global (API keys — presumably global). Precedence order: `.llmflow/` > userData settings > config.json?

### T5 — Same folder in two tabs
**Decide.** Allowed (browser allows same URL twice) vs focus-existing-tab (VS Code model). RunStore's directory lock makes two live stores on one runs/ dir a real hazard → recommend focus-existing.

---

## B — Architecture

### T6 — One renderer with swapped state, or one webContents per tab?
**Context.** Browsers use a process per tab. Electron offers `WebContentsView` per tab, or a single React app that re-renders on tab switch.
**Options.** (a) Single renderer, tab switch swaps a per-tab state bundle — cheap, but all per-tab state must be explicitly modeled (see T8). (b) View-per-tab — true isolation, background tabs keep rendering streams, but memory-heavy and complicates the shared Settings modal / theme.
**Recommendation.** (a) — the app is one React tree with file-backed state; true process isolation buys little here.

### T7 — IPC scoping
**Context.** Every IPC handler (`flow:run`, `listFlows`, `getSnapshot`, …) implicitly targets the global stores. Push events (`onRunUpdate`) are broadcast.
**Decide.** Add a `projectId` to every call vs a main-process notion of "active project per window". Run-update pushes must carry the project so a background tab's run doesn't patch the foreground tab's snapshot (the `snapRef` rev-matching logic in App.jsx would need the same guard per tab).

### T8 — What state is per-tab?
**Context.** App.jsx holds: active section (flows/library/runs), activeFlowId, activeRunId, snapshot, selectedNode, undo/redo stacks, run-panel input + workspaceDir, flowViewMode, canvas viewport, newRunOpen.
**Decide.** The full list that swaps on tab switch vs stays global (theme, Settings modal, models list). Also: does the debounced autosave flush on tab switch (it flushes on every section switch today — presumably yes)?

### T9 — Background-tab runs
**Decide.** Runs keep executing when their tab is inactive (surely yes — main process owns execution). Then: do background tabs receive/stream updates live, or resync on activation? Token streams at 250ms per live run × N tabs is the cost of "live".

---

## C — Tab UX

### T10 — Placement & chrome
**Context.** Custom titlebar with brand mark + doc name; native window-controls overlay is themed via `setTitleBarTheme`.
**Decide.** Tabs *in* the titlebar (browser-like; must manage drag regions and overlay clearance) vs a strip below it. What happens to the current `titlebar-doc` name display and the breadcrumb (does the breadcrumb lose its project-ish role)?

### T11 — Tab anatomy
**Decide.** Label = folder name? Editable rename? Icon/color per project? Indicators: unsaved dot (saveState), live-run spinner/badge, awaiting-approval badge on background tabs? Tooltip = full path?

### T12 — Tab operations
**Decide.** New tab (opens what — folder picker? new-tab page with recents?); close (× on hover? middle-click?); reorder by drag; pin; context menu (close others, reveal folder, …); overflow behavior when tabs exceed width (shrink like Chrome vs scroll); max open tabs.

### T13 — Closing a tab with a live run
**Options.** Block with message (matches existing deleteRun refusal), confirm-and-keep-running (run continues headless, tab reopenable), confirm-and-abort.
**Recommendation.** Keep running — engine is main-process; closing a *view* shouldn't kill work. But decide where the user then sees that run.

### T14 — Keyboard shortcuts
**Context.** Ctrl+1/2/3 already switch sections; Ctrl+Z/Y are taken by flow undo.
**Decide.** Ctrl+Tab / Ctrl+Shift+Tab cycle tabs? Ctrl+T new / Ctrl+W close (Ctrl+W also = close window on some platforms)? Do Ctrl+1..9 move to *tabs* (browser convention) and sections get new bindings, or do tabs get Ctrl+Shift+1..9? This is a real conflict — pick one convention.

### T15 — Empty/new-tab state
**Decide.** What a fresh tab shows: folder picker, recent-projects list, "clone/create" actions? Is there a zero-tab state or does the last tab refuse to close?

### T16 — Window title & OS integration
**Decide.** Window/taskbar title format (`project — flow`?); recent projects in OS jump list / dock menu; drag-tab-out-to-new-window (recommend: out of scope for v1 — say so explicitly).

---

## D — Persistence & lifecycle

### T17 — Session restore
**Decide.** Reopen previous tabs + active tab on launch (browser behavior) vs start fresh with recents. Where stored (settings.json). Per-tab restore depth: just the folder, or also last section/flow/run selection (T8 state)? What if a project folder no longer exists at restore?

### T18 — Recents & project identity
**Decide.** Project identity = absolute path (breaks on move/rename) vs an id written into `.llmflow/`? Recents list length, remove-from-recents.

### T19 — Run panel's per-run workspace picker
**Context.** Today each run can bind any folder via "Choose workspace…".
**Decide.** Tab = workspace makes the picker redundant — remove it (runs always target the tab's folder), keep as per-run override, or keep only in unbound/scratch tabs? Removing it is the cleanest read of the tab model.

---

## Suggested resolution order
T1 → T2/T3 (data model) → T6/T7 (architecture) → T5, T8, T9 → then all of C/D, which are cheap once the model is fixed. T14 (shortcut conflict) and T19 (workspace picker) are the two decisions most likely to be forgotten and hurt later.
