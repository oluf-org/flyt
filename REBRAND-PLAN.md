# REBRAND-PLAN.md — LLM Flow → Flyt

Active plan. Retire to git history when done and fold the outcome into
`DECISIONS.md` as D29 (draft in §7).

## 0. Scope decision — read this first

The word **flow** plays two roles in this repo and only one of them is being
retired:

| Role | Example | Verdict |
| --- | --- | --- |
| **Brand** | `LLM Flow`, `com.olaaxe.llmflow`, `window.llmflow`, `llmflow-theme` | **Renamed to Flyt.** |
| **Domain noun** | a flow, `flow.nodes`, `.flow.yaml`, `flowlang`, `FlowRunner`, `FLOW_NODES.md` | **Kept as-is.** |

Flyt is the app; a *flow* is still the thing you build in it. This is the same
split as Figma/frame or Linear/issue, and it buys a diff measured in dozens of
lines instead of ~3,800 hits across 120 files. Nothing on disk moves, no
`.flow.yaml` migration, no test churn, and English UI copy stays grammatical
("a flyt", "three flyts" does not).

**Consequence to accept knowingly:** `grep -i flow` will keep returning
thousands of hits forever. That is intended, not unfinished work. §6 lists the
exact set of strings that must come back empty so the boundary is testable
rather than a matter of taste.

---

## 1. Phase 1 — Identity constants (no behaviour change)

Introduce one source of truth so a future rename is a one-line edit, then point
everything at it.

**New file `core/brand.js`:**

```js
export const APP_NAME = 'Flyt';                 // display
export const APP_ID   = 'com.olaaxe.flyt';      // electron appId / bundle
export const APP_SLUG = 'flyt';                 // npm name, storage prefix, tmp dirs
```

`core/flowlang/adopt.js:17` already has `export const PRODUCT_NAME = 'LLM Flow'`
— re-export it from `brand.js` rather than keeping a second literal.

| File | Change |
| --- | --- |
| `package.json` | `"name": "llm-flow"` → `"flyt"`; description drops "flowchart canvas over a…" phrasing only where it says the product name |
| `electron-builder.yml` | `appId: com.olaaxe.llmflow` → `com.olaaxe.flyt`; `productName: LLM Flow` → `Flyt` |
| `index.html` | `<title>LLM Flow</title>` → `Flyt`; theme bootstrap key (§3) |
| `core/flowlang/adopt.js:17` | `PRODUCT_NAME` re-exported from `brand.js` |
| `core/flowlang/schema.json:3` | `$id: https://llm-flow.dev/flow.schema.json` → `https://flyt.dev/flow.schema.json` |
| `core/adapters/openrouter.js:15-16` | `HTTP-Referer` → `https://github.com/olaaxe/flyt`; `X-Title: LLM Flow` → `Flyt` |

`publish.repo` in `electron-builder.yml` and the git remote already point at
`olaaxe/flyt` — no change needed, which is also why the updater keeps working.

---

## 2. Phase 2 — Electron shell and the userData trap

**This is the only step that can lose user data.** Electron derives the
userData path from `productName`. Changing `LLM Flow` → `Flyt` silently moves
`%APPDATA%/LLM Flow` → `%APPDATA%/Flyt`, and every packaged install loses its
`settings.json`, projects registry, and seeded `flows/` (`electron/main.js:34,
107, 421, 825`).

Do this before anything else in `main.js`, guarded so it runs at most once:

```js
// One-shot: LLM Flow → Flyt (D29). Electron derives userData from productName,
// so the rename orphans the old directory. Move it before any read touches it.
const legacy = path.join(app.getPath('appData'), 'LLM Flow');
const current = app.getPath('userData');
if (fs.existsSync(legacy) && !fs.existsSync(current)) fs.renameSync(legacy, current);
```

It must execute at module top level, above `dataRoot` (line 34) and
`settingsPath` (line 107) — both capture the path eagerly.

Remaining `main.js` targets — all plain string swaps:

- `:476, :480` window title (`'LLM Flow'`, `` `${entry.name} — LLM Flow` ``) → `Flyt`
- `:487` `BrowserWindow({ title: 'LLM Flow' })` → `Flyt`
- `:574` `'Approval needed — LLM Flow'` → `— Flyt`
- `:1096` updater dialog `'A new version of LLM Flow has been downloaded.'` → `Flyt`
- `:65, :430, :463, :469` log prefixes `[llm-flow]` → `[flyt]`

Same-shape swaps in the renderer: `src/ChatRun.jsx:155,162`,
`src/CompareRun.jsx:146` (notification titles).

**Verify:** package a build, install over an existing one, confirm settings and
projects survive; then install clean and confirm no legacy directory is created.

---

## 3. Phase 3 — The IPC bridge and browser storage

Two renames that touch many call sites but are purely mechanical.

**`window.llmflow` → `window.flyt`** — declared once at
`electron/preload.cjs:5`, consumed ~100× (mostly `src/App.jsx`). Ship it as one
commit with a temporary alias so a missed call site fails loudly in dev rather
than silently at runtime:

```js
contextBridge.exposeInMainWorld('flyt', api);
// Remove once the codemod is verified — see D29.
contextBridge.exposeInMainWorld('llmflow', new Proxy(api, {
  get(t, k) { console.warn(`[flyt] window.llmflow.${String(k)} is renamed to window.flyt`); return t[k]; }
}));
```

Run the app, exercise every panel, confirm zero warnings, then delete the alias
in a follow-up commit. `sed -i 's/window\.llmflow/window.flyt/g'` over `src/`
does the bulk.

**localStorage keys** — four keys, all in `src/App.jsx`:

| Old | New | Line |
| --- | --- | --- |
| `llmflow-theme` | `flyt-theme` | `App.jsx:34`, `index.html` bootstrap |
| `llmflow.col.left` | `flyt.col.left` | `App.jsx:241` |
| `llmflow.col.right` | `flyt.col.right` | `App.jsx:242` |
| `llmflow.tip.nodeMenu` | `flyt.tip.nodeMenu` | `App.jsx:1734,1739` |

The theme key is the only one worth migrating (a wrong-theme flash on first
launch is ugly); read the old key as a fallback once, write the new one, delete
the old. Column widths and the tip flag can reset — the cost is one resize and
one tooltip.

**Do not miss** the `index.html` inline bootstrap script: it reads the theme key
before first paint and is the one place a stale key is visible as a flash.

---

## 4. Phase 4 — Copy, docs, and the `.llmflow/` question

**UI copy** — small and hand-edited, not codemodded:

- `src/App.jsx:1772` `<span className="brand-name">LLM Flow</span>` → the new
  wordmark lockup (§5)
- `src/App.jsx:2437` `<h3>LLM Flow</h3>` (about panel) → `Flyt`
- `src/Lander.jsx:223` `<span className="section-label">LLM Flow</span>` → `Flyt`
- `src/Settings.jsx:23,25,34,330` — four provider blurbs say "llm-flow never
  sees a token". These are trust-critical sentences; reword to "Flyt never sees
  a token" and re-read them in context rather than sed-ing.
- `src/Constellation.jsx:20` `APP_SEED = 'llm-flow'` → `'flyt'`. **Changes the
  no-project constellation layout** (the seed drives the PRNG). Harmless, but
  expect a visual diff in any screenshot test.
- `src/styles.css:2` header comment → `Flyt — Slate & Sage design system`

**Internal comments** in `core/adapters/{claudeCode,cliDelegate,codexCli,index}.js`
say "llm-flow" ~8×. Swap for consistency; zero risk.

**`core/adapters/cliDelegate.js:117` and `codexCli.js:114`** build a temp dir
named `llm-flow-cli` under `os.tmpdir()`. Renaming to `flyt-cli` is safe (it is
scratch, recreated on demand) but is a *behavioural* change on a path the
sandboxed CLI adapters depend on — cover it with the existing adapter tests.

**Docs:** `README.md` H1, `CLAUDE.md`, `GOALS.md`, `PRODUCT-SPEC.md`,
`DESIGN-SPEC.md` headers. Leave `FLOW_LANG.md` and `FLOW_NODES.md` filenames
alone — per §0 they document the DSL and the node catalog, both domain, not
brand. Say so explicitly in `CLAUDE.md` so the next reader doesn't "finish" the
rename.

**`.llmflow/` — the open question.** It is the most visible brand leak (it
appears in the user's own project folder, next to `.git`) *and* the only
remaining item that would need a data migration. Three options, in order of
preference:

1. **Rename to `.flyt/` with a read-both fallback.** `core/workspace.js:24`
   (`configDir`) and `core/projects.js:56,72` are the only three call sites.
   Resolve `.flyt/` first, fall back to `.llmflow/` if it exists, and rename on
   first write. ~20 lines, covered by `tests/workspace.test.js` and
   `tests/projects.test.js`.
2. **Rename with no fallback**, documented as a breaking change while the user
   base is one person.
3. **Leave it.** Cheapest; leaves the old brand in every project directory
   permanently.

Also update the two generated-file comments that name the product:
`core/projects.js:77` (`# Written by LLM Flow:`) and `core/workspace.js:38`
(`Per-project LLM Flow configuration`). Those are written *into user files*, so
they outlive the rename if missed.

**CI:** `.github/workflows/release.yml` — 4 hits, artifact names follow
`${productName}` and change automatically.

---

## 5. Phase 5 — The mark

Direction: **extend the sigil language**, not a new visual vocabulary. `src/sigil.js`
already defines the house geometry — evenly spaced rays at varying radii from a
solid centre, `currentColor` only, dot-tipped at intervals, plus `miniTopo()`'s
nodes-and-edges. The logo should be the *canonical, non-random* member of that
family: the sigils are noise, the logo is the same alphabet saying something on
purpose.

Four concepts were rendered for selection — **Wave** (sine-modulated ray
lengths, two lobes), **Current** (rays over a 300° arc with ramping lengths),
**Compass** (two rings at half-step offset, the only one holding shape at 16px),
and **Topology** (three long rays terminating in linked nodes, marrying
`sigil()` and `miniTopo()`). Pick one before starting this phase.

**Type:** `Figtree 700` at −4% tracking, already loaded in `index.html` — no new
font dependency, and the wordmark inherits the app's existing voice. If a more
distinctive wordmark is wanted later, letter a custom `y` descender from the
Figtree outline rather than switching families.

**Implementation:**

- `src/logo.js` — export `logoMark(size)` returning the static SVG, alongside
  `sigil()`. Same `currentColor`-only rule, so it themes for free and needs no
  light/dark variant.
- Replace the `brand-name` text node (`App.jsx:1772`) with the horizontal
  lockup; use the stacked lockup in the about panel (`App.jsx:2437`) and on the
  Lander.
- **App icons are the one place `currentColor` cannot apply.** Export
  `build/icon.png` (1024²), `icon.ico`, `icon.icns` in sage `#5b8c6e` on
  transparent, and add `icon:` entries under `win`/`mac`/`linux` in
  `electron-builder.yml` — it currently declares none, so packaged builds ship
  the default Electron icon.
- `index.html` favicon — currently absent; add the 16px-safe variant inline as a
  data URI to avoid a network round-trip.

**Anti-ideas check (D26):** the mark is flat, single-colour, geometric, and
carries no gradient beyond the one `sigil()` already uses. Do not add a
gradient, a shadow, or an animated variant.

---

## 6. Verification — make the boundary testable

Add `tests/brand.test.js`. It is the artifact that stops this from being
relitigated:

```js
// The brand is Flyt; the domain noun is still "flow" (D29). This test pins the
// boundary — it fails on brand leakage, and passes on every legitimate use of
// the word "flow".
const FORBIDDEN = [/LLM Flow/, /llm-flow/, /llmflow/i];
// scanned: src/**, core/**, electron/**, index.html, package.json,
//          electron-builder.yml, .github/**  — excluding this file
```

Manual checks that no test covers:

1. Install a packaged build over an existing `LLM Flow` install → settings,
   projects, and flows survive (§2).
2. Clean install → window title, taskbar name, About panel, installer, and DMG
   volume all read `Flyt`; the app icon is the new mark, not Electron's default.
3. Toggle theme, restart → no light/dark flash (§3 theme key).
4. Open a project folder → `.flyt/` created (or `.llmflow/` respected, per the
   §4 decision), and the generated `.gitignore` comment names Flyt.
5. `npm test` green — the suite should be untouched by this work. **If a test
   under `tests/flow*.test.js` needs editing, the scope in §0 has been
   violated.**

---

## 7. Draft decision entry

> ### D29 — Flyt is the brand; "flow" stays the domain noun
>
> The app is renamed **LLM Flow → Flyt** (Norwegian for *flow*). The rename
> covers brand surfaces only: app name, `appId`, npm package, window titles,
> notification titles, the `window.flyt` IPC bridge, `flyt.*` storage keys, log
> prefixes, docs headers, and the mark. It deliberately does **not** touch the
> domain vocabulary — a *flow* is still what you build, so `flow.nodes`,
> `.flow.yaml`, `flowlang`, `FlowRunner`, and `FLOW_NODES.md` keep their names.
> "Flyt" pluralises badly in English UI copy and renaming the DSL would have
> meant a migration for every existing project for no user-visible gain.
>
> `grep -i flow` returning thousands of hits is therefore the intended end
> state, not unfinished work; `tests/brand.test.js` pins the boundary by
> forbidding only the brand strings. Electron derives userData from
> `productName`, so `main.js` carries a one-shot `%APPDATA%/LLM Flow` →
> `Flyt` directory migration. The logo extends the existing `sigil.js`
> geometry — the canonical, unseeded member of the same family — in Figtree
> 700, `currentColor` only.

## 8. Order and effort

| Phase | Depends on | Risk | Rough size |
| --- | --- | --- | --- |
| 1 — identity constants | — | none | ~15 lines |
| 2 — Electron shell + userData migration | 1 | **high** (data loss) | ~30 lines |
| 3 — IPC bridge + storage keys | 1 | medium (many call sites, all mechanical) | ~120 call sites |
| 4 — copy, docs, `.llmflow/` | 1 | low, except the `.llmflow/` sub-decision | ~60 lines |
| 5 — the mark | logo concept picked | low | new `src/logo.js` + 3 icon exports |
| 6 — `tests/brand.test.js` | 1–5 | none | ~40 lines |

Phases 3, 4, and 5 are independent of each other and can land in any order.
Phase 2 should go first regardless, because it is the only one that can lose
data and the only one whose failure mode is silent.
