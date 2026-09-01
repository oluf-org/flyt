# Project color theming — audit and plan

Per-project color: each project gets a color (auto-assigned or user-chosen) applied
throughout the UI — accent, three derived darker shades on accents, and a subtle tint
of the project color on the page background — so the user can instantly tell which
project they are in.

## Phase 1 (landed): audit of the partial implementation, palette + derivation core

### What the partial work was

Commit `61e69b9` ("feat: add project palette color foundations") added a single file,
`src/theme/palette.ts`, and nothing else:

- 9 template **hues** (`BASE_HUES`, degrees) — not colors; no names, no hex.
- `generateShades(hue)` → three fixed-lightness `hsl()` strings (45/35/25%, fixed
  saturation 70). Lightness was **clamped per tier**, so a dark base (e.g. a custom
  picker color under lightness ~30) collapses tiers onto identical or inverted steps.
- `ThemeConfig` (baseHue/autoHue/isCustom/updatedAt) — **persistence designed but the
  store never existed**.
- `CSS_VAR_CONTRACT` mapping `--theme-accent`, `--theme-accent-light`,
  `--theme-accent-dark` — but no background tint, and no `ThemeProvider` was ever
  written to set them.

### Audit findings

- **Zero consumers.** No file outside `src/theme/palette.ts` references
  `themeStore`, `ThemeProvider`, `generateShades`, `BASE_HUES`, `ThemeConfig`, or any
  `--theme-accent*` variable. `src/styles.css` and every component were untouched by
  the partial work; the feature never rendered anywhere.
- **Its docstring promised modules that do not exist** (`themeStore`,
  `ThemeProvider`), so the file overstates what shipped. Trust nothing in it; verify
  against the code.
- **Hue-only modeling cannot serve custom colors.** A color picker yields a full
  color; reconstructing it from hue alone discards the user's saturation and
  lightness. The template therefore had to move from hues to colors.
- **Why it was replaced, not extended:** the fixed-clamped lightness ladder, the
  hue-only base, the missing background tint, the missing auto-assignment, and the
  wrong accent-only variable contract are each core to this task's acceptance
  criteria. Nothing was salvageable except the (sound) idea of one pure module that
  owns the math and that downstream layers never touch.
- `src/theme/palette.ts` is now **dead code pending deletion**; Phase 2 must delete it
  when the provider and settings UI land (it is unimported and inert today).

### What Phase 1 shipped

`src/lib/projectTheme.js` (+ `tests/projectTheme.test.js`, 13 tests) — pure, no I/O,
no DOM, no dependencies (the repo ships no color utility; helpers are local):

- `PRESET_PROJECT_COLORS` — the canonical 9 template colors, named, hex, frozen,
  spanning the hue wheel at mid lightness (red, orange, amber, green, teal, blue,
  indigo, purple, pink).
- `deriveProjectTheme(baseColorHex)` — presets and custom picker colors take the
  **identical path**. Parses hex → HSL once; shades are the same hue/saturation with
  lightness stepped by `SHADE_LIGHTNESS_RATIO` (0.8) per tier — geometric, so the
  ladder stays strictly decreasing and visibly distinct for ANY base, including
  near-black customs (no clamping). `bgTint` is a translucent veil
  (`hsl(H S% L% / 0.08)`) of the project color.
- `projectThemeCssVars(theme)` — maps a theme onto the CSS custom property contract:
  `--project-color`, `--project-color-shade-1..3`, `--project-bg-tint`.
- `pickProjectColorHex(usedHexes, rng)` — auto-assignment: draws uniformly from
  presets not in use; falls back to the full template when all 9 are taken; injectable
  `rng` for deterministic tests.
- `normalizeHexColor` / `isPresetColor` — picker-format tolerance (`#rgb`, `#rrggbb`,
  any case, optional `#`) and preset membership.
- WCAG AA of the tint is proven in tests by compositing the veil over the real
  surfaces (`--canvas` #f8faf9 / #0e1310) and measuring normal text (`--tx`
  #1e2623 / #e3ebe6) contrast: all presets plus customs pass ≥ 4.5 on both themes.

### Deliberate deviations from the task's nominal write scope

| Nominal | Actual | Why |
| --- | --- | --- |
| `src/lib/projectTheme.ts` | `src/lib/projectTheme.js` | The test gate runs `node --test` with no flags; Node 22.12 without `--experimental-strip-types` refuses `.ts` imports, and electron/ and the app's `src/` logic modules are plain ESM `.js` (only `kernel/` is TS, built separately). A `.ts` module here would break the gate's own import path. |
| `src/lib/projectTheme.test.ts` | `tests/projectTheme.test.js` | The gate glob is `tests/**/*.test.js`; a `.test.ts` beside the module would never run. All 97 existing test files follow the `tests/*.test.js` convention. |

## Phase 2 (next tasks): persistence, settings UI, and application

Downstream layers import from `src/lib/projectTheme.js` and never reimplement the math:

1. **Project record** — persist the color on the project (suggested field `colorHex`,
   the normalized `#rrggbb` value; `null` = not yet assigned). When creating a project
   (or finding one without a color), call
   `pickProjectColorHex(otherProjects.map(p => p.colorHex))` and persist the result.
2. **Settings UI** — on the project settings screen: render
   `PRESET_PROJECT_COLORS` as a 9-swatch row for one-click selection, plus a
   `<input type="color">` picker for custom colors. Feed the picker's value through
   `normalizeHexColor()` (reject/keep-last on null) and persist immediately on change.
3. **Theme application** — a provider (or effect) at the app root calls
   `deriveProjectTheme(project.colorHex)` and
   `projectThemeCssVars(theme)`, writing each entry onto
   `document.documentElement.style` when that project is active. Colors take effect
   without reload because every styled surface reads the variables live.
4. **`src/styles.css`** — define fallbacks under `:root`
   (e.g. `--project-color: var(--accent)`) and consume the variables on the project
   chrome: top bar accent, sidebar active marker, primary button, links, and the page
   background via `color-mix(in srgb, var(--project-bg-tint), var(--canvas))`.
5. **Delete `src/theme/palette.ts`** once nothing references it (it is already
   unimported; removing it in the same change as step 3 is safe).
6. **Tests to add then:** persistence round-trip of `colorHex`; auto-assignment
   uniqueness across a live project list; a settings-UI test asserting the 9 swatches
   render and a custom color update persists.

## Phase 2 (landed): persistence, service/API surface, auto-assignment

`tests/projectColor.test.js` (16 tests) proves the four acceptance points:
avoidance whenever unused presets remain, the full-template fallback when all 9
are taken, survival across a reload (serialize/restore, settings.json on disk,
and a second engine over the same profile), and unchanged CRUD for every
existing project behavior.

Where the persistence actually landed — the nominal write scope (`src/db/*`,
`src/services/projectService.ts`) does not exist in this repo:

| Nominal | Actual | Why |
| --- | --- | --- |
| `src/db/schema.ts` + migration | `core/projects.js` — a `colors` map (id → `#rrggbb`) on the registry, serialized inside `settings.projects` (`settings.json`) | The repo's data layer is settings.json + the ProjectRegistry (DECISIONS.md D22). A project IS a registry entry; there is no SQL schema to migrate. The equivalent of a migration is the one-time backfill below plus the restore-time gap fill. |
| `src/services/projectService.ts` | `core/projects.js` (record + `setColor`/`colorOf`) → `core/engine.js` (persist hook, backfill) → `core/api.js` `project:color` → `electron/main.js` IPC + `preload.cjs` → `src/devMock.js` | The service layer here IS the registry surfaced through the engine's command map, so the settings page (next task) and any headless caller share one flow. |

- **Record field:** `colorHex` rides `registry.listOpen()` (the renderer's only
  view of projects) and persists as `settings.projects.colors`, keyed by id like
  `names`/`tabState`. Restore adopts the map whole (well-formed values only) so
  a closed project keeps its color; a malformed value from a hand-edited
  settings.json is dropped rather than stored.
- **Auto-assignment:** `#colorFor()` runs at `createAppdata`, at `open` (covers
  folders and the legacy default entry), and once per restored entry — i.e.
  exactly "on creation, or whenever a project lacks a color". It never
  overwrites a stored value. The rule is injected (`pickColor`, defaulting to
  `pickProjectColorHex(used)`), so the engine owns the policy and tests can
  substitute it. `attach()` (the benchmark's throwaway clone) deliberately does
  NOT assign — a benchmark project must not persist anything into the session,
  and it never renders a themed surface.
- **Interpretation note:** the brief's "if all or **nearly all** are taken, fall
  back to uniform random over all 9" conflicts with its own acceptance
  criterion ("avoids in-use presets **whenever unused ones remain**"). The
  acceptance criterion wins, as in Phase 1's `pickProjectColorHex`: the fallback
  to the full template triggers only when zero presets remain unused (8 of 9
  taken still avoids the 8).
- **Backfill:** `core/engine.js` assigns distinct presets to the projects of a
  pre-color settings.json once (only when `projects.colors` is missing), so an
  upgraded profile never renders unthemed; `restore()` fills any remaining gaps
  and is idempotent for everyone else.
- **Adopt** ("Move to folder…") migrates the color to the new id in the same
  step that moves the name — the project keeps its color; no stale key remains.
- **Next task (settings UI):** render `PRESET_PROJECT_COLORS` as swatches + an
  `<input type="color">` calling `flyt.projectColor(id, hex)`, and get the updated
  record back into renderer state — `project:color`'s return payload (or a
  follow-up `listProjects()`) merged into `DailyRoot`'s `projects` state rethemes
  live, because the application layer is already listening.

## Phase 3 (landed): theme application — variables onto the document root

`src/lib/applyProjectTheme.js` (+ `src/styles/project-theme.css`,
`tests/projectThemeApply.test.js`, 9 tests; gate green at 2254 with Phases 2–3 in
the tree together):

- **The applier** — `applyProjectTheme(project, doc?)` resolves the active record's
  color and writes `projectThemeCssVars(theme)` onto `document.documentElement.style`,
  setting `data-project-theme` while a project is active; `clearProjectTheme()` is the
  projectless state (variables + attribute removed, every rule in the sheet inert).
  `resolveProjectTheme` is pure and testable without a DOM. Color fields:
  `colorHex` (canonical — the field Phase 2 persists and ships on `listOpen()`)
  with `color` accepted for any earlier record shape; anything that fails
  `normalizeHexColor` reads as "no color yet" and falls back to
  `DEFAULT_PROJECT_COLOR_HEX` (Blue) so the layer works before persistence lands.
- **The on-fill pairing** — `readableOnFillColor()` computes `--project-on-accent`
  (ink `#0b140f` vs white, argmax by WCAG ratio). Not a fixed choice: Indigo is deep
  enough that white beats ink; the winner always clears 3:1 because the two ratio
  curves cross above 4.
- **The sheet** — everything is gated on `:root[data-project-theme]`, so closed-
  project/modals/legacy surfaces keep the stock palette by construction. The page
  background tints by re-deriving `--canvas` (`color-mix(in srgb,
  var(--project-bg-tint), base)`) inside the scope — every surface that already
  paints the token follows, with no second background color introduced. `--app` and
  `--rail` take a 9%/6% whisper; active tab, primary buttons, rail pill/badge,
  `.md-body` links, and the trace chip consume the project family. Status color
  (`--err` badge) stays status. Loaded from `src/main.jsx` after `styles.css`.
- **The host** — `Shell.jsx` (the app's shell) owns the effect: re-applies whenever
  the active tab id or its color changes, so a recolor lands without a reload, and
  clears when the last project closes. `DailyRoot` passes the `projects` state.
- Deleted `src/theme/palette.ts` — still unimported; done in this change, per the
  Phase 1 plan (Phase 2's "pending deletion" note is now resolved).

**Integration seam:** `listOpen()`/`devMock` ship `colorHex` on each tab payload —
exactly the field `activeProjectColorHex` reads; `projectColor` (settings task)
writes the same field. Whatever puts an updated record into renderer state rethemes
live through the Shell effect.

## Phase 4 (landed): settings UI — the Color section (presets + custom picker)

`src/components/settings/ProjectColorSettings.tsx` (+ `projectColorSettings.css`,
`tests/projectColorSettings.test.js`, 7 tests; gate green at 2261 with all four
phases in the tree together; `vite build` resolves the section — 104 → 106 modules):

- **The section** — renders `PRESET_PROJECT_COLORS` (the canonical template) as a
  9-swatch radiogroup: one click calls `flyt.projectColor(id, hex)` and that is the
  whole interaction — no save step, exactly the one write path the engine/IPC/mock
  layers already shared. A `<input type="color">` covers custom colors, wired
  through the repo's first `.tsx` (see the deviations below; vite's react plugin
  transpiles `.tsx` like its `.jsx`, and no gate typechecks `src/` — the Node
  runner never imports the file, only vite does). Live picker `input` events move
  only local state; the commit gestures (the native dialog's accept via a native
  `change` listener — React does not surface `change` on color inputs — plus blur
  and Enter) pass `committedHex()`, the one gate that normalizes, refuses junk, and
  no-ops on the already-stored color. A `datalist` exposes the presets inside the
  native dialog where a browser supports it.
- **Selection and auto state** — the selected swatch is the record's own stored
  value (`colorHex`, `color` tolerated), so selection state is never local state.
  A record with no color shows the auto-assigned state: no swatch selected, an
  `auto-assigned` pill, and one non-writing `projectColor(id)` read-back that pulls
  the registry-assigned value onto the record (and from there into the theme).
  Projectless, the section renders its muted state with every control disabled.
- **The host** — `Settings.jsx` gains a `Project` tab hosting the section
  (`projects`/`onColorChange` props; the existing tabs are untouched);
  `DailyRoot` passes its live `projects` payload and, on change, re-reads
  `listProjects()` through `acceptProjects` — the same merge every tab lifecycle
  goes through, and the one the Shell's theme effect watches, which is the
  no-reload retheme. The legacy host's `<Settings />` mount keeps its defaults and
  renders the Project tab in its projectless state rather than guessing a record.
- **Tests** — the section loads through vite (the same transpile the app runs;
  Node's runner parses neither JSX nor TS): 9 named swatches in template order,
  the stored color selected, picker/hex mirroring the record, the auto-assigned
  state, the projectless disabled state, `committedHex`
  normalize/dedupe/refuse, the record readers, and the click → merge → derive
  chain with no second path.

| Nominal | Actual | Why |
| --- | --- | --- |
| `src/pages/ProjectSettingsPage.tsx` | The `Project` tab of `src/Settings.jsx` — the repo's one settings screen, already the host of every settings surface | The repository has no per-project settings page; a second settings screen would fork the tab rail, the section markup, and the data flow this feature is specified to build on. `Settings.jsx` already receives its props from the daily host, which also owns the project payload the section needs. |
| `src/components/settings/…` | Same path, created literally, as `.tsx` | The nominal directory existed nowhere; the repo's renderer modules are `.jsx`. The suffix costs nothing: the only tool that loads this file is vite, which transpiles `.tsx` out of the box. |

## Phase 5 (landed): end-to-end acceptance verification and regression pass

The integration was verified against the five acceptance criteria rather than
assumed from the phase summaries, with every threshold measured before it was
asserted. Where verification found defects, they were fixed directly; nothing
larger surfaced.

### What was verified (criterion by criterion)

1. **Two projects are distinguishable at a glance.** All 36 preset pairs were
   measured: the worst accent separation is Orange/Amber at 43/255 per channel
   (a just-noticeable difference is ~2.5/255), and the worst pair's *tinted
   page backgrounds* still separate by 3.4/255 on the dark canvas — weaker than
   the accent but above perception. The criterion holds for every pair, not
   just the canonical Red/Blue example.
2. **Auto-assignment rarely collides while unused presets remain.** 300
   independent seeded four-project sessions: zero collisions, 300/300 fully
   distinct draws, ≥ 5 of 9 presets unused afterward. The rule is uniform over
   the unused pool (proven exhaustively: `rng → 0.999` pins the last pool
   entry for every pool size), with the full-template fallback only at zero
   unused.
3. **Any preset or arbitrary custom color yields a coherent theme.** Verified
   for all 9 presets plus 9 adversarial customs (`#22d3ee`, `#f97316`,
   `#7c3aed`, `#eab308`, `#2a2a2a`, `#123456`, `#f0abfc`, `#ff0000`,
   `#00ff00`), each through the real applier into the DOM-stub root: three
   strictly darker shades (geometric ×0.8, never clamping — a near-black
   custom still descends), hue/saturation preserved, background-tint drift
   ≤ 17/255 (limit 30), body text ≥ 4.5:1 (worst 12.74) over the tinted
   canvas on both themes, on-fill ink/white ≥ 3:1 (worst 3.06), text accent
   ≥ 3:1 against the tinted canvas per theme half.
4. **A color change persists and applies immediately.** Driven through the
   real `api.invoke` chain: `project:color` writes normalized values to
   settings.json synchronously with the response; a fresh engine over the same
   profile reads the value back; the record `project:list` ships, run through
   the real applier, produces the new theme with no reload — and `bad_color`
   junk changes nothing. The click→merge→retheme seam (Settings `project` tab
   → `onColorChange` → `acceptProjects(listProjects())` → Shell effect) is
   held in the source.
5. **No regressions.** `listOpen()` and `serialize()` are supersets of their
   pre-color shapes (every legacy key present); the theme layer is fully
   inert projectless (variables + attribute removed on clear); the error
   badge keeps `--err` under any project color; and the full gate stayed
   green at every step — **2280/2280** (2261 pre-existing + 19 new), plus a
   `vite build` smoke run (106 modules, no warnings).

### Defects found and fixed in this pass

Both are in `src/styles/project-theme.css` (the application layer); neither
was visible from any single phase's own tests:

- **The light-theme soft wash mixed toward the dark app base.**
  `--project-accent-soft` was `color-mix(13% color, --pt-app-base)` with no
  `light-dark()`, so light-theme chip/indicator washes came out dark (the
  Red wash is ~L 30) where the stock palette's washes are near-white
  (`--accent-soft` light is `#e6efe9`). Fixed per theme half: 13% over the
  light card base / over the dark app base.
- **The text accent could fall below the stock design's own contrast floor.**
  `--project-accent` (78% color + 22% app base) measured 3.01:1 worst on
  light (Amber; stock sage is 3.70) and 2.47:1 on dark (Indigo) — worse than
  the raw color there (3.33), because darkening toward a dark base cannot
  help on a dark canvas. A static mix cannot fix this: `#22d3ee` on light
  needs a darker family member (2.32 raw) while `#2a2a2a` on dark needs the
  base itself (all shades are worse), and which one wins flips with the OS
  theme. So the choice moved into the applier, next to its existing
  `readableOnFillColor`: `readableProjectAccent(theme)` picks, per theme
  half, the lightest member of the base+shades family that clears 3:1
  against the tinted canvas (else the family maximum — the best that can be
  done while still wearing the color), written as
  `--project-accent-light`/`-dark` and consumed through `light-dark()`.
  After the fix the worst text-accent contrast over presets + customs is
  3.06:1 (light, `#00ff00`) and ≥ 3.33:1 on dark for every preset.

### Deviations from this task's nominal write scope

| Nominal | Actual | Why |
| --- | --- | --- |
| `e2e/project-theme.spec.ts` only | + a driver, `tests/projectThemeE2e.test.js` | The gate glob is `tests/**/*.test.js` and Node 22.12's `node --test` parses neither `.ts` nor JSX; an e2e spec no gate command runs would verify nothing. The driver loads both TS specs through the same vite the app ships (`ssrLoadModule`, the pattern the `.tsx` settings tests already use) and runs every check as a gate-visible subtest. |
| `src/lib/projectTheme.test.ts` (colocated, TS) | `tests/projectTheme.test.js` (Node, pre-existing) + the colocated `.test.ts` | The repo's colocated `.test.ts` would never execute under the gate (same Node 22.12 constraint Phase 1 recorded). The phase's 13-test suite therefore stays the module's Node suite; the new `.test.ts` complements it with invariants it does not hold (HSL round-trip, geometric ratio identity, whole-gamut totality), executed through the driver. Tests registered during a module load are not collected by this runner, so the specs export named `check*` functions rather than top-level `test()` calls. |
| `src/lib/projectTheme.ts` (nominal unit under test) | unchanged `.js` | Recorded in Phase 1; changing the module's suffix would break every import the four landed phases share. |

### One small completeness fix outside the nominal scope, recorded

`src/devMock.js` shipped its two preview tabs without the `colorHex` field,
while its own `projectColor` mock and the Phase 3 plan note ("devMock ships
colorHex on each tab payload — exactly the field the applier reads") said it
does — so the browser preview (`npm run dev` without a backend) rendered two
unthemed tabs where the running app shows two distinguishable ones. The mock
tabs now carry Red/Blue like the criterion describes. One line each; the gate
was re-run and stayed green.
