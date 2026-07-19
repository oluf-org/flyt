// Project registry (DECISIONS.md D22): a project IS a workspace folder (T1),
// and a tab is an open project. Runs are per-project; flows and Node Library
// templates stay global for v1 (T2). The app-root runs/ directory that predates
// projects is the implicit "default project" — the unbound scratch tab (T3).
//
// The registry owns:
//   - one RunStore + FlowRunner per open project (created lazily, keyed by
//     absolute folder path; 'default' for the unbound tab),
//   - where per-project files live (T2a): a Settings choice read at open time —
//     'workspace' (default) puts them in <folder>/.llmflow/ with an auto-written
//     .gitignore so artifacts never enter version control; 'appdata' keys them
//     under userData so the repo stays untouched,
//   - tab lifecycle: same folder twice focuses the existing tab (T5); closing a
//     tab keeps its runner executing (T13) — the entry survives, only the tab
//     goes; reopening the folder finds the same store,
//   - persistence: open tabs + active + recents + per-tab UI state serialize
//     into settings.json and restore browser-style (T17), dropping tabs whose
//     folder disappeared (their recents entry stays).
//
// Engine wiring (FlowRunner construction, push plumbing) is injected via
// `createRunner`, so this module stays testable without a live pipeline.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RunStore } from './state.js';

export const DEFAULT_PROJECT_ID = 'default';
export const DEFAULT_PROJECT_NAME = 'Scratch';
const MAX_RECENTS = 12;

// Project identity = absolute path for v1 (T18); the unbound tab is 'default'.
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
  return path.join(folder, '.llmflow', 'runs');
}

// A folder name that survives any path: readable basename + a short hash of the
// full path so two folders with the same name can't collide.
export function appDataKey(folder) {
  const base = path.basename(folder).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'project';
  const h = crypto.createHash('sha1').update(path.resolve(folder)).digest('hex').slice(0, 8);
  return `${base}-${h}`;
}

// In-repo storage must never leak run artifacts into version control (T2a):
// .llmflow/config.json stays committable (D15), everything the app generates
// under .llmflow/ is ignored. Only written when missing — a hand-edited
// .gitignore is the project's business.
export function ensureLlmflowGitignore(folder) {
  const dir = path.join(folder, '.llmflow');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, '.gitignore');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p,
      '# Written by LLM Flow: run artifacts never belong in version control.\n' +
      '# config.json and skills/ are yours to commit.\n' +
      'runs/\n', 'utf8');
  }
}

export class ProjectRegistry {
  /**
   * @param {object} opts
   * @param {string} opts.defaultRunsDir   app-root runs/ (the default project's data, T3)
   * @param {string} opts.appDataDir       Electron userData path
   * @param {() => 'workspace'|'appdata'} opts.getStorage  T2a setting, read per open
   * @param {(store: RunStore, projectId: string) => object} opts.createRunner
   * @param {() => void} [opts.onPersist]  called after any mutation worth saving
   */
  constructor({ defaultRunsDir, appDataDir, getStorage, createRunner, onPersist }) {
    this.defaultRunsDir = defaultRunsDir;
    this.appDataDir = appDataDir;
    this.getStorage = getStorage ?? (() => 'workspace');
    this.createRunner = createRunner;
    this.onPersist = onPersist ?? (() => {});
    this.entries = new Map();   // id -> { id, folder, name, store, runner }
    this.openIds = [];          // tab order, left to right
    this.activeId = null;
    this.recents = [];          // bound folders only, most recent first
    this.tabState = {};         // id -> slim renderer UI state (T8/T17 restore depth)
  }

  get(id) {
    const entry = this.entries.get(id ?? DEFAULT_PROJECT_ID);
    if (!entry) throw new Error(`Unknown project: "${id}"`);
    return entry;
  }
  has(id) { return this.entries.has(id ?? DEFAULT_PROJECT_ID); }

  // Create (or find) the entry for a folder. Entries are permanent for the
  // process lifetime — a closed tab's runner keeps executing (T13), so its
  // store must keep existing; reopening reuses it (also what makes T5's
  // "one live store per runs/ dir" hold inside this process).
  #entryFor(folder) {
    const id = projectIdFor(folder);
    let entry = this.entries.get(id);
    if (entry) return entry;
    const resolved = folder == null ? null : path.resolve(String(folder));
    if (resolved != null && (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())) {
      throw new Error(`Project folder "${folder}" is not an existing directory`);
    }
    const storage = this.getStorage();
    if (resolved != null && storage !== 'appdata') ensureLlmflowGitignore(resolved);
    const runsDir = runsDirFor(resolved, {
      storage, appDataDir: this.appDataDir, defaultRunsDir: this.defaultRunsDir
    });
    const store = new RunStore(runsDir);
    entry = {
      id,
      folder: resolved,
      name: projectName(resolved),
      store,
      runner: this.createRunner(store, id)
    };
    this.entries.set(id, entry);
    return entry;
  }

  // Open a folder as a tab (null = the unbound scratch tab). Same folder twice
  // focuses the existing tab instead of opening a second one (T5).
  open(folder = null) {
    const entry = this.#entryFor(folder);
    const already = this.openIds.includes(entry.id);
    if (!already) this.openIds.push(entry.id);
    this.activeId = entry.id;
    if (entry.folder) this.#touchRecent(entry.folder);
    this.onPersist();
    return { project: entry, focused: already };
  }

  // Close a tab. The runner keeps executing (T13) — only the tab goes; the
  // entry (store + runner) stays live in this process. The last tab never
  // leaves the strip empty: closing it falls back to the scratch tab.
  close(id) {
    const idx = this.openIds.indexOf(id);
    if (idx === -1) return this.activeId;
    this.openIds.splice(idx, 1);
    if (this.openIds.length === 0) {
      if (id === DEFAULT_PROJECT_ID) { this.openIds = [id]; return this.activeId; } // refuse: nothing to fall back to
      this.open(null);
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
        live: e.runner?.live?.size ?? 0,
        state: this.tabState[id] ?? {}
      };
    });
  }

  // --- persistence (settings.json) ---
  serialize() {
    return {
      // null marks the unbound scratch tab; everything else is its folder.
      open: this.openIds.map(id => this.get(id).folder),
      active: this.activeId,
      recents: this.recents,
      tabState: this.tabState
    };
  }

  // Browser-style restore (T17). A folder missing at restore drops its tab —
  // reported so the renderer can say so once — but keeps its recents entry.
  restore(saved = {}) {
    const dropped = [];
    for (const folder of saved.open ?? []) {
      try { this.#entryFor(folder); this.openIds.push(projectIdFor(folder)); }
      catch { dropped.push(folder); }
    }
    this.openIds = [...new Set(this.openIds)];
    this.recents = (saved.recents ?? []).filter(f => typeof f === 'string').slice(0, MAX_RECENTS);
    // Only keep state for tabs that made it back.
    this.tabState = {};
    for (const [id, state] of Object.entries(saved.tabState ?? {})) {
      if (this.entries.has(id)) this.tabState[id] = state;
    }
    if (this.openIds.length === 0) this.openIds = [this.#entryFor(null).id];
    this.activeId = this.openIds.includes(saved.active) ? saved.active : this.openIds[0];
    return { dropped };
  }
}
