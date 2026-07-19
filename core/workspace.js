// A bound target workspace: the real project folder a run operates on
// (selected at run time, so workflows stay workspace-agnostic — DECISIONS.md
// D15/Q-D5). Per-project configuration lives in <workspace>/.llmflow/ so it is
// version-controllable and travels with the repo, NOT in appdata.
//
// This class owns three things:
//   1. validating that the bound path is a real directory,
//   2. creating/reading the .llmflow/ config folder inside it,
//   3. confining every path the run resolves to the workspace root.
// (3) is the foundation the real file/bash tools build on in V1 task 2 — for
// now it guarantees .llmflow/ itself can never be written outside the root.
import fs from 'node:fs';
import path from 'node:path';

export class Workspace {
  constructor(root) {
    const resolved = path.resolve(String(root ?? ''));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Workspace "${root}" is not an existing directory`);
    }
    this.root = resolved;
  }

  get configDir() { return path.join(this.root, '.llmflow'); }
  get configPath() { return path.join(this.configDir, 'config.json'); }
  // Skills a node template can attach by name (core/skills.js). Not created by
  // ensure(): an empty directory wouldn't survive a commit anyway, and this
  // shouldn't litter every repo it binds to. Projects create it when they have
  // something to say.
  get skillsDir() { return path.join(this.configDir, 'skills'); }

  // Create .llmflow/ (+ a default config.json) on first bind; idempotent, so
  // re-binding an already-configured project leaves its config untouched.
  ensure() {
    fs.mkdirSync(this.configDir, { recursive: true });
    if (!fs.existsSync(this.configPath)) {
      writeJson(this.configPath, {
        comment: 'Per-project LLM Flow configuration (version-controllable). '
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
