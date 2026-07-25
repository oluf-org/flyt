// A bound target workspace: the real project folder a run operates on
// (selected at run time, so workflows stay workspace-agnostic — DECISIONS.md
// D15/Q-D5). Per-project configuration lives in <workspace>/.flyt/ so it is
// version-controllable and travels with the repo, NOT in appdata.
//
// This class owns three things:
//   1. validating that the bound path is a real directory,
//   2. creating/reading the .flyt/ config folder inside it,
//   3. confining every path the run resolves to the workspace root.
// (3) is the foundation the real file/bash tools build on in V1 task 2 — for
// now it guarantees .flyt/ itself can never be written outside the root.
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, CONFIG_DIR, LEGACY_CONFIG_DIR } from './brand.js';

// --- The config directory, across the D29 rename -------------------------
// The pre-D29 directory (LEGACY_CONFIG_DIR in core/brand.js) became `.flyt/`.
// Reads resolve to whichever directory a project
// actually has (new name wins); the first WRITE adopts the legacy one by
// renaming it, so a project converts exactly once and nothing is copied twice.
//
// Both live in this module because the project registry needs the same rules —
// a project's runs/ sits inside this directory too.

// Read-only resolution: no side effects, safe on a folder that doesn't exist.
export function configDirName(root) {
  try {
    if (fs.existsSync(path.join(root, CONFIG_DIR))) return CONFIG_DIR;
    if (fs.existsSync(path.join(root, LEGACY_CONFIG_DIR))) return LEGACY_CONFIG_DIR;
  } catch { /* unreadable root: fall through to the current name */ }
  return CONFIG_DIR;
}

export function configDirFor(root) { return path.join(root, configDirName(root)); }

// Write path: adopt a pre-rename directory, then return the path to use. If the
// rename fails (locked, read-only, permissions) we keep using the legacy
// directory in place rather than splitting the project's config across two —
// a failed migration must never look like an empty one.
export function adoptConfigDir(root) {
  const target = path.join(root, CONFIG_DIR);
  const legacy = path.join(root, LEGACY_CONFIG_DIR);
  if (!fs.existsSync(target) && fs.existsSync(legacy)) {
    try { fs.renameSync(legacy, target); }
    catch { return legacy; }
  }
  return target;
}

export class Workspace {
  constructor(root) {
    const resolved = path.resolve(String(root ?? ''));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Workspace "${root}" is not an existing directory`);
    }
    this.root = resolved;
  }

  get configDir() { return configDirFor(this.root); }
  get configPath() { return path.join(this.configDir, 'config.json'); }
  // Just the directory name ('.flyt', or the legacy one on a project that has
  // not been adopted yet) — skills.js builds workspace-relative paths from it.
  get configDirName() { return configDirName(this.root); }
  // Skills a node template can attach by name (core/skills.js). Not created by
  // ensure(): an empty directory wouldn't survive a commit anyway, and this
  // shouldn't litter every repo it binds to. Projects create it when they have
  // something to say.
  get skillsDir() { return path.join(this.configDir, 'skills'); }

  // Create .flyt/ (+ a default config.json) on first bind; idempotent, so
  // re-binding an already-configured project leaves its config untouched.
  // This is the "first write" that adopts a pre-D29 config directory.
  ensure() {
    const dir = adoptConfigDir(this.root);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.configPath)) {
      writeJson(this.configPath, {
        comment: `Per-project ${APP_NAME} configuration (version-controllable). `
          + 'Created on first bind; safe to commit and hand-edit.',
        version: 1
      });
    }
    return this;
  }

  readConfig() {
    try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')); }
    catch { return {}; }
  }
  writeConfig(cfg) {
    fs.mkdirSync(this.configDir, { recursive: true });
    writeJson(this.configPath, cfg);
  }

  // Read a confined file from the bound project, or null when it isn't there.
  // Mirrors RunStore.readWorkspaceFile, but against the REAL project rather
  // than the run's sandbox — which is what a contextSpec naming "src/types.ts"
  // has always meant (V1 task 12). Throws only when the path escapes the root.
  readFile(relPath) {
    const p = this.resolve(relPath);
    return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  }

  // Confined path resolution against the workspace root: rejects traversal
  // (..), absolute paths, drive-letter escapes, null bytes, AND symlink escapes
  // (a link planted inside the workspace that points outside it). Every
  // workspace read/write the file tools perform goes through here (task 2/4).
  resolve(relPath) {
    const rel = String(relPath ?? '');
    if (rel.includes('\0')) throw new Error(`Path "${relPath}" contains a null byte`);

    // 1. Lexical confinement: after normalization the target must sit under root.
    const resolved = path.resolve(this.root, rel);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`Path "${relPath}" escapes the workspace root`);
    }

    // 2. Symlink confinement: the nearest EXISTING ancestor of the target must
    // still realpath to inside the (realpath'd) root, so a symlink inside the
    // workspace can't be used to read/write outside it.
    const realRoot = fs.realpathSync(this.root);
    let probe = resolved;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break; // reached the filesystem root
      probe = parent;
    }
    const realProbe = fs.realpathSync(probe);
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
      throw new Error(`Path "${relPath}" resolves outside the workspace root (symlink escape)`);
    }
    return resolved;
  }
}

function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); }
