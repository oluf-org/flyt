// Presets (PIVOT-PLAN §5.1, decision 4) — the ten node templates and five
// pipelines that used to be *installed*, demoted to *offered*.
//
// The change is small in code and large in meaning. Before the pivot the app
// shipped a library and a set of flows, and a new user's first act was to run
// something somebody else built. After it the library ships EMPTY: the graph is
// the only way to produce data, and every part of the pipeline is something you
// built. Presets are how that stays survivable — they are a starting point you
// choose, not a starting point you inherit.
//
// Three doors out of an empty library (§5.1): Blank · Start from a preset ·
// Describe it. This module is the second door.
//
// Presets are bundled, immutable data next to the app (D28), read from
// presets/nodes/*.json and presets/flows/*.flow.yaml. Installing one COPIES it
// into the user's library, where it becomes an ordinary, editable file with no
// link back — a preset is a template for a template, not a subscription to one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTemplate } from '../src/flowTypes.js';
import { parseFlow } from './flowlang/parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundled data lives next to the app, never under userData (D28).
export const PRESETS_DIR = path.join(__dirname, '..', 'presets');

// §10.5, answered: yes, presets carry provenance. `origin: 'preset'` and the
// preset's id ride onto the installed copy, mirroring the tool trust tiers in
// TOOLS-PLAN §12.2 — you can always tell what you wrote from what you accepted,
// and the answer survives in the file rather than in someone's memory.
export const PRESET_ORIGIN = 'preset';

function readDir(dir, ext) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith(ext)).sort(); }
  catch { return []; }
}

// --- node presets -----------------------------------------------------------------

export function listNodePresets(dir = path.join(PRESETS_DIR, 'nodes')) {
  const out = [];
  for (const file of readDir(dir, '.json')) {
    try {
      const tpl = normalizeTemplate(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
      out.push({ ...tpl, presetId: tpl.id, file });
    } catch { /* a malformed preset is skipped, never fatal — the others still offer */ }
  }
  return out;
}

// Copy one preset into a NodeStore. `asId` lets the caller resolve a collision
// with something the user already has; without it an existing id is refused
// rather than silently overwritten — a preset must never eat a template
// somebody edited.
export function installNodePreset(store, presetId, { asId = null, dir = path.join(PRESETS_DIR, 'nodes') } = {}) {
  const preset = listNodePresets(dir).find(p => p.presetId === presetId);
  if (!preset) throw new Error(`No node preset "${presetId}".`);
  const id = asId ?? preset.presetId;
  if (store.listFull().some(t => t.id === id)) {
    throw new Error(`A template named "${id}" already exists — rename it or pick a different id.`);
  }
  const { presetId: _p, file: _f, ...tpl } = preset;
  return store.save({ ...tpl, id, origin: PRESET_ORIGIN, fromPreset: preset.presetId });
}

// --- flow presets -------------------------------------------------------------------

export function listFlowPresets(dir = path.join(PRESETS_DIR, 'flows')) {
  const out = [];
  for (const file of readDir(dir, '.flow.yaml')) {
    const id = file.replace(/\.flow\.yaml$/, '');
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      const flow = parseFlow(text);
      // Which templates this preset expects. A flow preset is only installable
      // once its node templates exist, and saying which are missing beats
      // installing a flow whose nodes resolve to nothing.
      const needs = [...new Set((flow.nodes ?? []).map(n => n.templateId).filter(Boolean))];
      out.push({
        presetId: id,
        name: flow.name ?? id,
        description: flow.description ?? '',
        nodeCount: (flow.nodes ?? []).length,
        needs,
        file,
        layoutFile: fs.existsSync(path.join(dir, `${id}.layout.json`)) ? `${id}.layout.json` : null
      });
    } catch { /* skip a preset that no longer parses */ }
  }
  return out;
}

// Install a flow preset, plus any node presets it needs that the library does
// not already have. Returns what was created, so the UI can say "and 3
// templates it needed" rather than quietly changing the library underfoot.
export function installFlowPreset(flowStore, nodeStore, presetId, {
  asId = null, dir = path.join(PRESETS_DIR, 'flows'), nodesDir = path.join(PRESETS_DIR, 'nodes')
} = {}) {
  const preset = listFlowPresets(dir).find(p => p.presetId === presetId);
  if (!preset) throw new Error(`No flow preset "${presetId}".`);
  const id = asId ?? preset.presetId;
  if (flowStore.list().some(f => f.id === id)) {
    throw new Error(`A flow named "${id}" already exists — rename it or pick a different id.`);
  }
  const templates = [];
  if (nodeStore) {
    const have = new Set(nodeStore.listFull().map(t => t.id));
    for (const need of preset.needs) {
      if (have.has(need)) continue;
      try { installNodePreset(nodeStore, need, { dir: nodesDir }); templates.push(need); }
      catch { /* the flow still installs; the missing node shows as unresolved */ }
    }
  }
  const flow = parseFlow(fs.readFileSync(path.join(dir, preset.file), 'utf8'));
  let layout = null;
  if (preset.layoutFile) {
    try { layout = JSON.parse(fs.readFileSync(path.join(dir, preset.layoutFile), 'utf8')); }
    catch { /* positions are cosmetic; the flow installs without them */ }
  }
  flowStore.save({ ...flow, id, origin: PRESET_ORIGIN, fromPreset: preset.presetId }, layout);
  return { flowId: id, templates };
}
