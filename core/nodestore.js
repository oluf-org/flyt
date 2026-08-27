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
import { SEED_NODE_TEMPLATES, RETIRED_SEED_IDS, normalizeTemplate } from '../src/flowTypes.js';

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class NodeStore {
  constructor(rootDir) {
    this.rootDir = rootDir; // e.g. <project>/nodes
    fs.mkdirSync(rootDir, { recursive: true });
    this.seedIfEmpty();
    this.migrateSeeds();
  }

  seedIfEmpty() {
    if (fs.readdirSync(this.rootDir).some(f => f.endsWith('.json'))) return false;
    for (const tpl of SEED_NODE_TEMPLATES) this.save(tpl);
    return true;
  }

  // Node rework migration: the per-category work templates and the separate
  // evaluation templates were combined (work / evaluation / combine / split).
  // Retired seed files are removed; stored flows referencing the old ids are
  // rewritten at load time (LEGACY_TEMPLATE_MAP in core/flowstore.js).
  // User-created templates (ids outside the seed sets) are never touched.
  // Idempotent.
  //
  // A NEW seed then has to reach a library that has already migrated, without
  // resurrecting one the user deliberately deleted — and "is the file absent?"
  // cannot tell those apart. So the library records which seed ids it has ever
  // installed. Absent from that record means new: write it. Present but
  // missing on disk means deleted: leave it alone. The record is seeded from
  // whatever is on disk the first time it is written, so an existing library
  // adopts its current shape as the baseline rather than being handed the
  // whole catalog again.
  //
  // Before this, a seed added after the rework shipped in code and appeared in
  // no existing library at all: `migrateSeeds` only wrote missing seeds when it
  // had just retired something, which by definition never happens twice.
  migrateSeeds() {
    for (const id of RETIRED_SEED_IDS) {
      if (fs.existsSync(this.templatePath(id))) fs.rmSync(this.templatePath(id), { force: true });
    }
    const installed = this.readInstalledSeeds();
    let added = false;
    for (const tpl of SEED_NODE_TEMPLATES) {
      if (installed.has(tpl.id)) continue;
      installed.add(tpl.id);
      if (!fs.existsSync(this.templatePath(tpl.id))) { this.save(tpl); added = true; }
    }
    this.writeInstalledSeeds(installed);
    return added;
  }

  // The seed ids this library has already been offered. First call adopts the
  // ids currently on disk, so nothing pre-existing is treated as new.
  readInstalledSeeds() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.installedSeedsPath(), 'utf8'));
      if (Array.isArray(raw?.ids)) return new Set(raw.ids.filter(id => typeof id === 'string'));
    } catch { /* absent or unreadable: fall through to the on-disk baseline */ }
    return new Set(fs.readdirSync(this.rootDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5)));
  }

  writeInstalledSeeds(ids) {
    const dir = path.dirname(this.installedSeedsPath());
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.installedSeedsPath(),
        JSON.stringify({ ids: [...ids].sort() }, null, 2));
    } catch { /* a library we cannot write to still works; it just re-offers seeds */ }
  }

  installedSeedsPath() {
    return path.join(this.rootDir, '_system', 'seeded.json');
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
