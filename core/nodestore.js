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
// PIVOT-PLAN §5.1 / decision 4: THE LIBRARY SHIPS EMPTY. It used to seed itself
// from the FLOW_NODES.md catalog on first launch, so a new user's first act was
// to run something somebody else built. The ten templates are now PRESETS
// (presets/nodes/, core/presets.js) — offered inside *Create node*, never
// installed. Every node in a user's library is one they chose.
//
// Beneath that floor sits the KERNEL (decision 3): two or three `system: true`
// templates under nodes/_system/ that exist only to run the builder flow. They
// are hidden from the palette and the Nodes page, fully visible in run view when
// they execute, and app-owned — restored if deleted, never editable, and never
// counted as part of "your library".
import fs from 'node:fs';
import path from 'node:path';
import { RETIRED_SEED_IDS, normalizeTemplate } from '../src/flowTypes.js';
import { KERNEL_TEMPLATES } from './kernel.js';

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class NodeStore {
  constructor(rootDir) {
    this.rootDir = rootDir; // e.g. <project>/nodes
    fs.mkdirSync(rootDir, { recursive: true });
    this.ensureKernel();
    this.migrateSeeds();
  }

  // --- the kernel (PIVOT-PLAN §5.1, decision 3) ---------------------------------
  systemDir() { return path.join(this.rootDir, '_system'); }

  // Written on every construction, overwriting whatever is there. These are the
  // app's own nodes, not the user's: an edited or deleted kernel node is a
  // broken builder, and the file is a window onto what the builder runs rather
  // than a thing to tune.
  ensureKernel() {
    const dir = this.systemDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const tpl of KERNEL_TEMPLATES) {
      const clean = normalizeTemplate({ ...tpl, system: true });
      fs.writeFileSync(path.join(dir, `${clean.id}.json`), JSON.stringify(clean, null, 2), 'utf8');
    }
    return KERNEL_TEMPLATES.length;
  }

  listSystem() {
    const dir = this.systemDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return normalizeTemplate(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }
        catch { return null; }
      })
      .filter(Boolean);
  }

  // Everything a flow can resolve against: the user's library plus the kernel.
  // The palette and the Nodes page use listFull(); only resolution uses this,
  // which is exactly what makes the kernel invisible without making it magic.
  listResolvable() {
    return [...this.listFull(), ...this.listSystem()];
  }

  // Node rework migration: the per-category work templates and the separate
  // evaluation templates were combined (work / evaluation / combine / split).
  // Retired files are removed; stored flows referencing the old ids are
  // rewritten at load time (LEGACY_TEMPLATE_MAP in core/flowstore.js).
  // User-created templates are never touched. Idempotent.
  //
  // What it no longer does: re-seed the current set. Before the pivot a library
  // that had held the old templates was topped up with the new ones; now the
  // library ships empty and stays exactly as large as the user made it. The
  // replacements are one click away in *Create node → Start from a preset*.
  migrateSeeds() {
    let retired = false;
    for (const id of RETIRED_SEED_IDS) {
      if (fs.existsSync(this.templatePath(id))) {
        fs.rmSync(this.templatePath(id), { force: true });
        retired = true;
      }
    }
    return retired;
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

  // Full definitions of the USER's library. The kernel is deliberately absent:
  // `nodes/_system/` is a directory, so the .json filter already excludes it,
  // and every palette, picker and page that lists templates gets the empty
  // library the pivot promises.
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
  // Falls through to the kernel, so a flow node pointing at a system template
  // resolves the same way any other does — the kernel is hidden from lists, not
  // from execution.
  get(id) {
    try { return this.load(id); }
    catch { return this.listSystem().find(t => t.id === id) ?? null; }
  }

  save(tpl) {
    if (!tpl?.id) throw new Error('Template needs an id');
    const clean = normalizeTemplate(tpl);
    // The kernel is app-owned (decision 3). A save that would shadow one is
    // refused rather than silently creating a second template with the same id
    // that resolution would then pick between.
    if (KERNEL_TEMPLATES.some(k => k.id === clean.id)) {
      throw new Error(`"${clean.id}" is a system node — it belongs to the builder and cannot be overwritten.`);
    }
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
