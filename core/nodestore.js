// Node Library: reusable AI node templates, one JSON file per template in
// nodes/. Same philosophy as FlowStore — plain files are the source of
// truth, so templates are inspectable and portable (GOALS.md principle 1).
//
//   { id, name, description, category, icon, baseType, role,
//     worker: {provider,model}|null, instructions, tools: string[]|null,
//     skills: string[], requiresApproval }
//
// Templates do NOT contain hand-written prompts: the model generates its own
// prompt from the task + upstream context; the template constrains HOW
// (model, tools, instructions, skills). See GOALS.md "Core Concepts".
//
// The library seeds itself from the FLOW_NODES.md catalog
// (src/flowTypes.js SEED_NODE_TEMPLATES) when the directory is empty; after
// that the files are the single source of truth.
import fs from 'node:fs';
import path from 'node:path';
import { SEED_NODE_TEMPLATES, normalizeTemplate } from '../src/flowTypes.js';

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class NodeStore {
  constructor(rootDir) {
    this.rootDir = rootDir; // e.g. <project>/nodes
    fs.mkdirSync(rootDir, { recursive: true });
    this.seedIfEmpty();
  }

  seedIfEmpty() {
    if (fs.readdirSync(this.rootDir).some(f => f.endsWith('.json'))) return false;
    for (const tpl of SEED_NODE_TEMPLATES) this.save(tpl);
    return true;
  }

  templatePath(id) {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid template id "${id}"`);
    return path.join(this.rootDir, `${id}.json`);
  }

  // Summaries for pickers/palette: everything except the long fields.
  list() {
    return this.listFull().map(({ id, name, category, icon, baseType, role, worker, description }) =>
      ({ id, name, category, icon, baseType, role, worker, description }));
  }

  // Full definitions, e.g. for flow resolution before a run.
  listFull() {
    return fs.readdirSync(this.rootDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return normalizeTemplate(JSON.parse(fs.readFileSync(path.join(this.rootDir, f), 'utf8'))); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  load(id) {
    return normalizeTemplate(JSON.parse(fs.readFileSync(this.templatePath(id), 'utf8')));
  }

  // Like load(), but null (never a throw) when the template doesn't exist.
  get(id) {
    try { return this.load(id); } catch { return null; }
  }

  save(tpl) {
    if (!tpl?.id) throw new Error('Template needs an id');
    const clean = normalizeTemplate(tpl);
    fs.writeFileSync(this.templatePath(clean.id), JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  }

  create() {
    const id = 'node-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    return this.save({ id, name: 'Untitled node', description: '', baseType: 'aiStep', role: 'custom' });
  }

  remove(id) {
    fs.rmSync(this.templatePath(id), { force: true });
  }
}
