// Tool Library: one JSON file per tool in tools/, app-level, peer to
// nodes/<id>.json. Same philosophy as NodeStore and FlowStore — plain files
// are the source of truth, so a tool is inspectable, diffable and portable
// (GOALS.md principle 1, TOOLS-PLAN §4.1).
//
// Deliberate asymmetry, stated so it isn't read as an oversight: skills are
// per-project because EXPERTISE is project-specific (D15); tools are app-level
// because CAPABILITY is not. "Run the tests" means something different in
// every repo; "make an HTTP request" does not.
//
// The library seeds itself from the built-in modules (core/tools/builtins.js).
// A built-in's run() lives in source, so its file is refreshed from the module
// whenever a release changes the shipped definition — with the user's own
// fields (enabled, keywords, examples) preserved.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeTool, toolSummary, TOOL_ID } from '../src/toolTypes.js';
import { builtinDefinitions } from './tools/builtins.js';
import { normalizeToolset, SEED_TOOLSETS, SET_ID } from './toolsets.js';
import { normalizeCategory, sortCategories, SEED_CATEGORIES, CATEGORY_ID } from './toolCategories.js';

// Fields a user may own on a built-in. Everything else — schema, description,
// effects, risk — comes from the module, because that is what actually runs.
// `categoryId` is here because filing a tool on the board is the user's
// answer, not the module's: a release that re-seeds a built-in must not drag
// its card back to the column the shipped definition happened to imply.
const USER_OWNED = ['enabled', 'keywords', 'examples', 'categoryId'];

export class ToolStore {
  constructor(rootDir) {
    this.rootDir = rootDir; // e.g. <userData>/tools
    fs.mkdirSync(rootDir, { recursive: true });
    this.problems = [];     // files that could not be read, for the Tools page
    this.seedBuiltins();
    this.seedToolsets();
    this.seedCategories();
  }

  // --- categories (tools/categories/<id>.json) -------------------------------
  // A subdirectory, like sets/, so listFull()'s `*.json` sweep of tools/ never
  // reads a category as a malformed tool.
  categoriesDir() { return path.join(this.rootDir, 'categories'); }

  // Seeded once, then the user's — pure data, like a toolset, so an edited or
  // deleted category is simply the answer and is never written back.
  seedCategories() {
    fs.mkdirSync(this.categoriesDir(), { recursive: true });
    // Any file at all means the user has a board; re-seeding a category they
    // deleted would make deletion impossible.
    if (fs.readdirSync(this.categoriesDir()).some(n => n.endsWith('.json'))) return [];
    const written = [];
    for (const def of SEED_CATEGORIES) {
      fs.writeFileSync(
        path.join(this.categoriesDir(), `${def.id}.json`),
        JSON.stringify(normalizeCategory(def), null, 2), 'utf8'
      );
      written.push(def.id);
    }
    return written;
  }

  categoryPath(id) {
    if (!CATEGORY_ID.test(String(id ?? ''))) throw new Error(`Invalid category id "${id}"`);
    return path.join(this.categoriesDir(), `${id}.json`);
  }

  listCategories() {
    if (!fs.existsSync(this.categoriesDir())) return [];
    const out = [];
    for (const f of fs.readdirSync(this.categoriesDir()).filter(n => n.endsWith('.json'))) {
      try { out.push(normalizeCategory(JSON.parse(fs.readFileSync(path.join(this.categoriesDir(), f), 'utf8')))); }
      catch (err) { this.problems.push({ file: `categories/${f}`, error: String(err?.message ?? err) }); }
    }
    return sortCategories(out);
  }

  saveCategory(def) {
    const clean = normalizeCategory(def);
    fs.mkdirSync(this.categoriesDir(), { recursive: true });
    fs.writeFileSync(this.categoryPath(clean.id), JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  }

  // Deleting a column does not delete its tools: each one falls back to its
  // derived placement (categoryOf) on the next paint. Clearing the now-dangling
  // `categoryId` keeps the files honest rather than leaving them pointing at a
  // column that no longer exists.
  removeCategory(id) {
    fs.rmSync(this.categoryPath(id), { force: true });
    for (const tool of this.listFull()) {
      if (tool.categoryId === id) this.write(normalizeTool({ ...tool, categoryId: null }));
    }
  }

  // The board's column order, persisted as the `order` field so a hand-edited
  // file and a dragged column mean the same thing.
  reorderCategories(ids) {
    const byId = new Map(this.listCategories().map(c => [c.id, c]));
    const ordered = (Array.isArray(ids) ? ids : []).filter(id => byId.has(id));
    for (const id of byId.keys()) if (!ordered.includes(id)) ordered.push(id);
    return ordered.map((id, order) => this.saveCategory({ ...byId.get(id), order }));
  }

  // Filing one tool. Separate from save() because it is the one write the
  // board makes constantly (drag, and the wizard's destination chip) and it
  // must never round-trip an entire definition the renderer may hold a stale
  // copy of — a built-in's schema lives in its module, not in the card.
  setCategory(id, categoryId) {
    const tool = this.load(id);
    return this.write(normalizeTool({ ...tool, categoryId: categoryId || null }));
  }

  // --- toolsets (tools/sets/<id>.json) ---------------------------------------
  setsDir() { return path.join(this.rootDir, 'sets'); }

  // Seeded once, then the user's. Unlike a built-in tool — whose run() lives in
  // source and whose file must therefore stay truthful — a set is pure data, so
  // an edited set is simply the user's answer and is never overwritten.
  seedToolsets() {
    fs.mkdirSync(this.setsDir(), { recursive: true });
    const written = [];
    for (const def of SEED_TOOLSETS) {
      const p = path.join(this.setsDir(), `${def.id}.json`);
      if (fs.existsSync(p)) continue;
      fs.writeFileSync(p, JSON.stringify(normalizeToolset(def), null, 2), 'utf8');
      written.push(def.id);
    }
    return written;
  }

  setPath(id) {
    if (!SET_ID.test(String(id ?? ''))) throw new Error(`Invalid toolset id "${id}"`);
    return path.join(this.setsDir(), `${id}.json`);
  }

  listSets() {
    if (!fs.existsSync(this.setsDir())) return [];
    const out = [];
    for (const f of fs.readdirSync(this.setsDir()).filter(n => n.endsWith('.json'))) {
      try { out.push(normalizeToolset(JSON.parse(fs.readFileSync(path.join(this.setsDir(), f), 'utf8')))); }
      catch (err) { this.problems.push({ file: `sets/${f}`, error: String(err?.message ?? err) }); }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  getSet(id) {
    try { return normalizeToolset(JSON.parse(fs.readFileSync(this.setPath(id), 'utf8'))); }
    catch { return null; }
  }

  saveSet(def) {
    const clean = normalizeToolset(def);
    fs.mkdirSync(this.setsDir(), { recursive: true });
    fs.writeFileSync(this.setPath(clean.id), JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  }

  // The whole library in the shape the linter and the grant resolver take:
  // `{ tools, sets }`. One name for the pair so a caller cannot hand half of
  // it over and get a silently empty library back.
  catalog() {
    return { tools: this.listFull(), sets: this.listSets() };
  }

  // Idempotent: writes a built-in's file when it is missing or when the
  // shipped definition has changed, and leaves everything else alone.
  seedBuiltins() {
    const written = [];
    for (const def of builtinDefinitions()) {
      const existing = this.get(def.id);
      const merged = { ...def };
      if (existing) {
        for (const key of USER_OWNED) {
          if (existing[key] !== undefined) merged[key] = existing[key];
        }
      }
      const next = normalizeTool(merged);
      if (existing && JSON.stringify(existing) === JSON.stringify(next)) continue;
      this.write(next);
      written.push(def.id);
    }
    return written;
  }

  toolPath(id) {
    if (!TOOL_ID.test(String(id ?? ''))) throw new Error(`Invalid tool id "${id}"`);
    return path.join(this.rootDir, `${id}.json`);
  }

  // Summaries for pickers and the (planned) Tools page.
  list() {
    return this.listFull().map(toolSummary);
  }

  // Full definitions, e.g. to build the runtime registry before a run. A file
  // that can't be parsed is skipped and recorded — one bad definition must not
  // cost you the other fifty.
  listFull() {
    this.problems = [];
    const out = [];
    for (const f of fs.readdirSync(this.rootDir).filter(n => n.endsWith('.json'))) {
      try {
        out.push(normalizeTool(JSON.parse(fs.readFileSync(path.join(this.rootDir, f), 'utf8'))));
      } catch (err) {
        this.problems.push({ file: f, error: String(err?.message ?? err) });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  // Just the ids of tools that can actually be granted — what AGENT_TOOLS
  // becomes once the library is data rather than a literal array.
  ids() {
    return this.listFull().filter(t => t.enabled).map(t => t.id);
  }

  load(id) {
    return normalizeTool(JSON.parse(fs.readFileSync(this.toolPath(id), 'utf8')));
  }

  // Like load(), but null (never a throw) when the tool doesn't exist.
  get(id) {
    try { return this.load(id); } catch { return null; }
  }

  save(def) {
    return this.write(normalizeTool(def));
  }

  write(tool) {
    fs.writeFileSync(this.toolPath(tool.id), JSON.stringify(tool, null, 2), 'utf8');
    return tool;
  }

  remove(id) {
    fs.rmSync(this.toolPath(id), { force: true });
  }

  // A built-in is defined by its module, so deleting the file only makes the
  // store rewrite it. Disabling is the honest way to switch one off.
  setEnabled(id, enabled) {
    const tool = this.load(id);
    return this.write(normalizeTool({ ...tool, enabled: enabled !== false }));
  }
}
