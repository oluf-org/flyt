// Project registry (DECISIONS.md D22): a project IS a workspace folder (T1),
// and a tab is an open project. Runs are per-project; flows and Node Library
// templates stay global for v1 (T2).
//
// Three kinds of project (DECISIONS.md D25):
//   - 'folder'   — a real repo bound to a tab; its absolute path is its id,
//   - 'appdata'  — an app-managed project under <appData>/projects/<slug>/,
//                  auto-created by the projectless lander from the first prompt;
//                  its id is 'appdata:<slug>' and it has its own runs/ and
//                  workspace/. Unbound work lives here instead of a scratch tab,
//   - 'default'  — the legacy app-root runs/ scratch project (T3). Retired as a
//                  destination (L6): never auto-opened, kept only so a one-time
//                  migration can lift its runs into an appdata project.
//
// With scratch retired, closing the last tab (or a fresh launch) leaves NO tab
// active — the projectless state (activeId = null), which the renderer answers
// with the projectless lander. Opening a folder or running from that lander is
// what creates the next tab.
//
// The registry owns one RunStore + StackRunner per open project (created lazily,
// permanent for the process so a closed tab's runner keeps executing, T13),
// where per-project files live (T2a), tab lifecycle, and browser-style session
// persistence into settings.json (T17). Engine wiring is injected via
// `createRunner`, so this module stays testable without a live pipeline.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RunStore } from './state.js';
import { slugFromPrompt, dedupeSlug } from './projectName.js';
import { configDirFor, adoptConfigDir } from './workspace.js';
import { APP_NAME } from './brand.js';
// Per-project theme color (src/lib/projectTheme.js owns the color math). The
// registry persists `colorHex` on the project record and picks one for any
// project that lacks one; the renderer only ever derives from the stored value.
import { pickProjectColorHex, normalizeHexColor } from '../src/lib/projectTheme.js';

export const DEFAULT_PROJECT_ID = 'default';
export const DEFAULT_PROJECT_NAME = 'Scratch';
const APPDATA_PREFIX = 'appdata:';
const MAX_RECENTS = 12;

export function isAppdataId(id) { return typeof id === 'string' && id.startsWith(APPDATA_PREFIX); }
export function appdataSlugOf(id) { return isAppdataId(id) ? id.slice(APPDATA_PREFIX.length) : null; }

// Project identity = absolute path for a bound folder (T18); the unbound legacy
// tab is 'default'; appdata projects carry their own prefixed id.
export function projectIdFor(folder) {
  return folder == null ? DEFAULT_PROJECT_ID : path.resolve(String(folder));
}

export function projectName(folder) {
  return folder == null ? DEFAULT_PROJECT_NAME : (path.basename(folder) || folder);
}

// Where a project's runs live (T2a). The storage mode is read at open time;
// already-open projects keep the store they were opened with.
export function runsDirFor(folder, { storage = 'workspace', appDataDir, defaultRunsDir }) {
  if (folder == null) return defaultRunsDir;
  if (storage === 'appdata') {
    return path.join(appDataDir, 'projects', appDataKey(folder), 'runs');
  }
  // configDirFor, not a literal: a project created before D29 keeps its runs in
  // the legacy directory until a write adopts it (core/workspace.js).
  return path.join(configDirFor(folder), 'runs');
}

// A folder name that survives any path: readable basename + a short hash of the
// full path so two folders with the same name can't collide.
export function appDataKey(folder) {
  const base = path.basename(folder).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'project';
  const h = crypto.createHash('sha1').update(path.resolve(folder)).digest('hex').slice(0, 8);
  return `${base}-${h}`;
}

// In-repo storage must never leak run artifacts into version control (T2a):
// .flyt/config.json stays committable (D15), everything the app generates under
// .flyt/ is ignored. Only written when missing — a hand-edited .gitignore is
// the project's business.
//
// This is also a write path, so it adopts a pre-D29 config directory (D29).
export function ensureConfigGitignore(folder) {
  const dir = adoptConfigDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, '.gitignore');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p,
      `# Written by ${APP_NAME}: run artifacts never belong in version control.\n` +
      '# config.json and skills/ are yours to commit.\n' +
      'runs/\n', 'utf8');
  }
}

export class ProjectRegistry {
  /**
   * @param {object} opts
   * @param {string} opts.defaultRunsDir   app-root runs/ (the legacy scratch project's data, T3)
   * @param {string} opts.appDataDir       Electron userData path
   * @param {() => 'workspace'|'appdata'} opts.getStorage  T2a setting, read per open
   * @param {(store: RunStore, projectId: string) => object} opts.createRunner
   * @param {() => void} [opts.onPersist]  called after any mutation worth saving
   * @param {(used: string[]) => string} [opts.pickColor]  the auto-assignment rule;
   *        default is uniform among template presets the other projects don't use
   */
  constructor({ defaultRunsDir, appDataDir, getStorage, createRunner, onPersist, pickColor, telemetry = null }) {
    this.defaultRunsDir = defaultRunsDir;
    this.appDataDir = appDataDir;
    this.appProjectsDir = path.join(appDataDir, 'projects');
    this.getStorage = getStorage ?? (() => 'workspace');
    this.createRunner = createRunner;
    this.telemetry = telemetry;
    this.onPersist = onPersist ?? (() => {});
    this.entries = new Map();   // id -> { id, kind, folder, appDir, workspaceRoot, name, store, runner }
    this.openIds = [];          // tab order, left to right
    this.activeId = null;       // null = projectless (L6): no tab open
    this.recents = [];          // bound folders only, most recent first
    this.tabState = {};         // id -> slim renderer UI state (T8/T17 restore depth)
    this.names = {};            // id -> custom display name (rename overrides)
    this.colors = {};           // id -> theme color, '#rrggbb' (project record field)
    this.pickColor = pickColor ?? ((used = []) => pickProjectColorHex(used));
  }

  get(id) {
    const entry = this.entries.get(id ?? DEFAULT_PROJECT_ID);
    if (!entry) throw new Error(`Unknown project: "${id}"`);
    return entry;
  }
  has(id) { return this.entries.has(id ?? DEFAULT_PROJECT_ID); }

  #displayName(id, fallback) { return this.names[id] ?? fallback; }

  // Create (or find) the entry for a bound folder (or the legacy default).
  // Entries are permanent for the process lifetime — a closed tab's runner keeps
  // executing (T13), so reopening the folder reuses the same store (T5).
  #entryFor(folder) {
    const id = projectIdFor(folder);
    let entry = this.entries.get(id);
    if (entry) return entry;
    const resolved = folder == null ? null : path.resolve(String(folder));
    if (resolved != null && (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())) {
      throw new Error(`Project folder "${folder}" is not an existing directory`);
    }
    const storage = this.getStorage();
    if (resolved != null && storage !== 'appdata') ensureConfigGitignore(resolved);
    const runsDir = runsDirFor(resolved, {
      storage, appDataDir: this.appDataDir, defaultRunsDir: this.defaultRunsDir
    });
    const store = new RunStore(runsDir, { projectId: id, telemetry: this.telemetry });
    entry = {
      id,
      kind: resolved == null ? 'default' : 'folder',
      folder: resolved,
      appDir: null,
      workspaceRoot: resolved, // a bound tab IS the workspace (T19)
      name: this.#displayName(id, projectName(resolved)),
      store,
      runner: this.createRunner(store, id)
    };
    this.entries.set(id, entry);
    return entry;
  }

  #appDirFor(slug) { return path.join(this.appProjectsDir, slug); }

  // Build (or find) the entry for an appdata project by slug. Assumes the
  // directory already exists (createAppdata makes it; restore checks first).
  #appdataEntryFor(slug) {
    const id = APPDATA_PREFIX + slug;
    let entry = this.entries.get(id);
    if (entry) return entry;
    const appDir = this.#appDirFor(slug);
    const store = new RunStore(path.join(appDir, 'runs'), { projectId: id, telemetry: this.telemetry });
    entry = {
      id,
      kind: 'appdata',
      folder: null,
      appDir,
      workspaceRoot: path.join(appDir, 'workspace'),
      name: this.#displayName(id, slug),
      store,
      runner: this.createRunner(store, id)
    };
    this.entries.set(id, entry);
    return entry;
  }

  // Slugs already taken on disk or by an open entry, so a new one dedupes past
  // both (Q-L4). Reading the projects/ dir keeps names unique across restarts.
  #takenSlugs() {
    const set = new Set();
    try { for (const d of fs.readdirSync(this.appProjectsDir)) set.add(d); } catch { /* none yet */ }
    for (const id of this.entries.keys()) if (isAppdataId(id)) set.add(appdataSlugOf(id));
    return set;
  }

  // Auto-create an appdata project from a prompt/name (L5): derive a unique
  // slug, lay down its runs/ + workspace/ dirs, and open it as the active tab.
  // Deterministic and instant — the slug is a synchronous heuristic. The theme
  // color is assigned here, at creation, from a preset no other project uses.
  createAppdata(promptOrName) {
    const slug = dedupeSlug(slugFromPrompt(promptOrName), this.#takenSlugs());
    const appDir = this.#appDirFor(slug);
    fs.mkdirSync(path.join(appDir, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'workspace'), { recursive: true });
    const entry = this.#appdataEntryFor(slug);
    this.#colorFor(entry);
    if (!this.openIds.includes(entry.id)) this.openIds.push(entry.id);
    this.activeId = entry.id;
    this.onPersist();
    return { project: entry, focused: false };
  }

  // Open a folder as a tab (null = the legacy scratch entry — no longer surfaced
  // in the UI, but kept openable for migration). Same folder twice focuses the
  // existing tab instead of opening a second one (T5).
  /**
   * A project this process can DRIVE but that is not a tab.
   *
   * The benchmark (DESIGN-SPEC.md §8) works a throwaway clone: it needs a store,
   * a runner, a backlog and a ledger for that directory, and every command in
   * `core/api.js` resolves those through this registry. What it must not do is
   * join the user's session — a tab for a directory that will be deleted in
   * twenty minutes, stealing focus and sitting in recents afterwards, is a
   * benchmark run leaking into the thing it was supposed to observe.
   *
   * Nothing is persisted, and nothing becomes active.
   */
  attach(folder) {
    if (folder == null) throw new Error('attach() needs a folder.');
    return this.#entryFor(folder);
  }

  /**
   * Forget an attached project. Refuses an open tab, whose runner is permanent
   * for the process by design (T13) — a closed tab keeps executing.
   */
  detach(id) {
    if (this.openIds.includes(id)) throw new Error(`"${id}" is an open tab; close it instead.`);
    return this.entries.delete(id);
  }

  open(folder = null) {
    const entry = this.#entryFor(folder);
    // "Whenever a project lacks a color" covers pre-color projects and anything
    // else that arrived without one: assigned on first open, never reassigned.
    this.#colorFor(entry);
    const already = this.openIds.includes(entry.id);
    if (!already) this.openIds.push(entry.id);
    this.activeId = entry.id;
    if (entry.folder) this.#touchRecent(entry.folder);
    this.onPersist();
    return { project: entry, focused: already };
  }

  // Rename a project's display name. Appdata projects and bound folders both
  // rename display-only (the appdata directory keeps its creation slug so run
  // paths and the tab id never churn); persisted in the names map (T17).
  rename(id, newName) {
    const entry = this.get(id);
    const name = String(newName ?? '').trim();
    if (!name) return entry;
    this.names[id] = name;
    entry.name = name;
    this.onPersist();
    return entry;
  }

  // --- Per-project theme color ----------------------------------------------
  // The color IS part of the project record: chosen at creation, persisted in
  // settings.json beside names/tabState, editable from the settings page. The
  // renderer derives its theme from this stored value (src/lib/projectTheme.js
  // owns the derivation); nothing else recomputes or guesses it.

  // A project lacking a color gets one now: uniformly among the 9 template
  // presets no OTHER project uses, falling back to the full template when all
  // (or nearly all — the picker's own rule) are taken. Idempotent per project:
  // a set color is never overwritten, so re-opens and renames do not churn it.
  #colorFor(entry) {
    const stored = normalizeHexColor(this.colors[entry.id]);
    if (stored) return stored;
    const used = [];
    for (const [id, color] of Object.entries(this.colors)) {
      if (id === entry.id) continue;
      const hex = normalizeHexColor(color);
      if (hex) used.push(hex);
    }
    const picked = this.pickColor(used);
    this.colors[entry.id] = picked;
    this.onPersist();
    return picked;
  }

  // The settings page's one write path (presets and custom picker colors take
  // the same one): normalize, store on the record, persist. Refuses junk rather
  // than storing a color the theme derivation would have to reject later.
  setColor(id, rawHex) {
    const entry = this.get(id);
    const hex = normalizeHexColor(rawHex);
    if (!hex) throw new Error(`"${rawHex}" is not a hex color like "#dc4a3a".`);
    this.colors[entry.id] = hex;
    this.onPersist();
    return entry;
  }

  // The theme color on the record ('#rrggbb'), or null when the project has
  // none yet. The read half of setColor(); the renderer derives its theme from
  // this value and never recomputes one.
  colorOf(id) {
    return normalizeHexColor(this.colors[this.get(id).id]) ?? null;
  }

  // Adopt an appdata project into a real folder (DECISIONS.md D25):
  // "Move to folder…". The project's files migrate into the repo — its runs to
  // the folder's runs store, its workspace contents into the folder itself — and
  // the tab converts from an appdata project to a bound folder in place (same
  // position, name, and tab state; only its id changes).
  //
  // Safety: refuses while a run is live (files would move under it); never
  // overwrites existing files in the target repo (workspace files that collide
  // are skipped); copies then removes the source, so a failed delete still
  // leaves every file safely in the destination. Returns the id remap so the
  // renderer can re-key its per-tab bundles.
  // Adopt never mutates the theme color: it is part of the record, not of the
  // address, so "Move to folder…" keeps it the way it keeps the name (the id
  // changes, the project is the same one).
  adoptAppdata(id, folder) {
    if (!isAppdataId(id)) throw new Error('Only an app-managed project can be moved to a folder.');
    const old = this.get(id);
    if (old.runner?.live?.size) {
      throw new Error('This project has a run in progress. Wait for it to finish before moving it to a folder.');
    }
    const resolved = path.resolve(String(folder ?? ''));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`"${folder}" is not an existing directory`);
    }
    const newId = projectIdFor(resolved);
    if (this.entries.has(newId)) throw new Error('That folder is already open as a project.');

    const storage = this.getStorage();
    const targetRunsDir = runsDirFor(resolved, {
      storage, appDataDir: this.appDataDir, defaultRunsDir: this.defaultRunsDir
    });

    // 1. Runs → the folder's runs store (ids are unique; no collisions expected).
    const srcRuns = path.join(old.appDir, 'runs');
    if (fs.existsSync(srcRuns)) {
      fs.mkdirSync(targetRunsDir, { recursive: true });
      for (const runId of fs.readdirSync(srcRuns)) {
        fs.cpSync(path.join(srcRuns, runId), path.join(targetRunsDir, runId), { recursive: true });
      }
    }
    // 2. Workspace contents → the repo, never clobbering existing files.
    const srcWs = path.join(old.appDir, 'workspace');
    if (fs.existsSync(srcWs)) {
      fs.cpSync(srcWs, resolved, { recursive: true, force: false, errorOnExist: false });
    }
    if (storage !== 'appdata') ensureConfigGitignore(resolved);
    // 3. The appdata home is fully migrated — remove it.
    fs.rmSync(old.appDir, { recursive: true, force: true });

    // 4. Swap the entry in place, preserving tab position, custom name, state.
    const pos = this.openIds.indexOf(id);
    if (this.names[id]) { this.names[newId] = this.names[id]; delete this.names[id]; }
    if (this.tabState[id]) { this.tabState[newId] = this.tabState[id]; delete this.tabState[id]; }
    if (this.colors[id]) { this.colors[newId] = this.colors[id]; delete this.colors[id]; }
    this.entries.delete(id); // no live runs (guarded) — safe to drop the appdata entry
    const entry = this.#entryFor(resolved); // fresh bound entry over the moved runs
    if (pos !== -1) this.openIds[pos] = newId;
    else if (!this.openIds.includes(newId)) this.openIds.push(newId);
    this.openIds = [...new Set(this.openIds)];
    if (this.activeId === id) this.activeId = newId;
    this.#touchRecent(resolved);
    this.onPersist();
    return { entry, oldId: id, newId };
  }

  // Close a tab. The runner keeps executing (T13) — only the tab goes; the entry
  // (store + runner) stays live in this process. Closing the last tab leaves the
  // projectless state (L6): activeId = null, an empty strip the lander fills.
  close(id) {
    const idx = this.openIds.indexOf(id);
    if (idx === -1) return this.activeId;
    this.openIds.splice(idx, 1);
    if (this.openIds.length === 0) {
      this.activeId = null; // projectless — the lander takes over
    } else if (this.activeId === id) {
      // Chrome's rule: closing the active tab activates its right neighbour,
      // or the new last tab when the closed one was rightmost.
      this.activeId = this.openIds[Math.min(idx, this.openIds.length - 1)];
    }
    this.onPersist();
    return this.activeId;
  }

  activate(id) {
    if (!this.openIds.includes(id)) throw new Error(`Not an open tab: "${id}"`);
    this.activeId = id;
    this.onPersist();
    return this.get(id);
  }

  reorder(ids) {
    // Accept only a permutation of the current tabs — a stale renderer list
    // must not drop or invent tabs.
    const current = new Set(this.openIds);
    if (ids.length !== this.openIds.length || !ids.every(id => current.has(id))) return;
    this.openIds = [...ids];
    this.onPersist();
  }

  setTabState(id, state) {
    if (!this.entries.has(id)) return;
    this.tabState[id] = state ?? {};
    this.onPersist();
  }

  #touchRecent(folder) {
    this.recents = [folder, ...this.recents.filter(f => f !== folder)].slice(0, MAX_RECENTS);
  }
  removeRecent(folder) {
    this.recents = this.recents.filter(f => f !== folder);
    this.onPersist();
  }
  listRecents() {
    return this.recents.map(folder => ({
      folder, name: projectName(folder), exists: fs.existsSync(folder)
    }));
  }

  listOpen() {
    return this.openIds.map(id => {
      const e = this.get(id);
      return {
        id: e.id,
        folder: e.folder,
        name: e.name,
        kind: e.kind,
        colorHex: this.colors[e.id] ?? null, // the project record's theme color
        live: e.runner?.live?.size ?? 0,
        state: this.tabState[id] ?? {}
      };
    });
  }

  // --- persistence (settings.json) ---
  // Each open tab serializes to a descriptor: a folder path (bound), an
  // { appdata } object (appdata project), or null (the legacy default — no
  // longer written, but tolerated on read).
  #descriptor(id) {
    const e = this.get(id);
    if (e.kind === 'appdata') return { appdata: appdataSlugOf(id) };
    if (e.kind === 'default') return null;
    return e.folder;
  }

  serialize() {
    return {
      open: this.openIds.map(id => this.#descriptor(id)),
      active: this.activeId,
      recents: this.recents,
      tabState: this.tabState,
      names: this.names,
      // Per-project record fields: the theme color. Keyed by id so a project
      // keeps its color across launches without being an open tab.
      colors: this.colors
    };
  }

  // Browser-style restore (T17). A folder or appdata dir missing at restore
  // drops its tab — reported so the renderer can say so once — but keeps its
  // recents entry. Legacy scratch descriptors (null) are ignored (L6); a fresh
  // or fully-dropped session restores to the projectless state, not scratch.
  restore(saved = {}) {
    const dropped = [];
    this.names = { ...(saved.names ?? {}) };
    // The theme color is the project record's, not the session's: adopt the map
    // whole, so a project keeps its color even when it is not restored as a tab.
    // Only well-formed values survive — a hand-edited settings.json must not be
    // able to put junk where deriveProjectTheme() reads.
    this.colors = {};
    for (const [id, value] of Object.entries(saved.colors ?? {})) {
      const hex = normalizeHexColor(value);
      if (hex) this.colors[id] = hex;
    }
    for (const desc of saved.open ?? []) {
      try {
        if (desc == null) continue; // legacy scratch — retired (L6)
        if (typeof desc === 'object' && desc.appdata) {
          const slug = String(desc.appdata);
          if (!fs.existsSync(this.#appDirFor(slug))) { dropped.push(slug); continue; }
          this.#appdataEntryFor(slug);
          this.openIds.push(APPDATA_PREFIX + slug);
        } else if (typeof desc === 'string') {
          this.#entryFor(desc);
          this.openIds.push(projectIdFor(desc));
        }
      } catch {
        dropped.push(typeof desc === 'string' ? desc : (desc?.appdata ?? 'unknown'));
      }
    }
    this.openIds = [...new Set(this.openIds)];
    this.recents = (saved.recents ?? []).filter(f => typeof f === 'string').slice(0, MAX_RECENTS);
    // Only keep tab state / names for tabs that made it back.
    this.tabState = {};
    for (const [id, state] of Object.entries(saved.tabState ?? {})) {
      if (this.entries.has(id)) this.tabState[id] = state;
    }
    this.names = Object.fromEntries(
      Object.entries(this.names).filter(([id]) => this.entries.has(id)));
    // A project restored without a color — a pre-color settings.json, mostly —
    // gets one now, from presets no restored project uses. #colorFor skips
    // projects that already have theirs, so this only ever fills gaps.
    for (const entry of this.entries.values()) this.#colorFor(entry);
    // Projectless when nothing survives (L6): no scratch fallback.
    this.activeId = this.openIds.includes(saved.active) ? saved.active : (this.openIds[0] ?? null);
    return { dropped };
  }
}
