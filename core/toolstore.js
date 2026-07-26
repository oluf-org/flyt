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

// Fields a user may own on a built-in. Everything else — schema, description,
// effects, risk — comes from the module, because that is what actually runs.
const USER_OWNED = ['enabled', 'keywords', 'examples'];

export class ToolStore {
  constructor(rootDir) {
    this.rootDir = rootDir; // e.g. <userData>/tools
    fs.mkdirSync(rootDir, { recursive: true });
    this.problems = [];     // files that could not be read, for the Tools page
    this.seedBuiltins();
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
