// Flow definitions: user-editable workflow graphs in flows/, with the Flow
// DSL (*.flow.yaml, see FLOW_LANG.md) as the source of truth for STRUCTURE
// (nodes, template refs, overrides, relations, ports, gates) and a sidecar
// <id>.layout.json for PRESENTATION (canvas positions), written only here.
//
// Format-aware: reads both legacy <id>.json (whole flow incl. positions) and
// <id>.flow.yaml (+ layout sidecar); prefers the DSL when both exist. Writes
// only the DSL + sidecar — saving a legacy flow migrates it and removes the
// old .json (npm run flow -- migrate does the same in bulk).
//
// Two node shapes may appear in a flow (see src/flowTypes.js):
//   template instance: { id, templateId, position, overrides:{...} }
//   structural/legacy: { id, type, kind, position, data:{...} }
// Every runnable workflow starts from a User Input node (type 'input') and
// ends in an Output node (type 'output').
//
// The classic linear pipeline ships as "Default pipeline" — a regular,
// editable flow composed of Node Library templates, seeded on first launch
// (and re-seeded if deleted; it is the app's built-in starting point).
import fs from 'node:fs';
import path from 'node:path';
import { parseFlow } from './flowlang/parse.js';
import { serializeFlow } from './flowlang/serialize.js';
import { layoutPositions } from '../src/flowLayout.js';
import { UNTITLED_FLOW, ensureStructuralNodes, migrateLegacyTemplates } from '../src/flowTypes.js';

export const DEFAULT_PIPELINE_ID = 'default-pipeline';

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class FlowStore {
  constructor(rootDir) {
    this.rootDir = rootDir; // e.g. <project>/flows
    fs.mkdirSync(rootDir, { recursive: true });
  }

  #path(id, ext) {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid flow id "${id}"`);
    return path.join(this.rootDir, `${id}${ext}`);
  }
  flowPath(id) { return this.#path(id, '.flow.yaml'); }
  layoutPath(id) { return this.#path(id, '.layout.json'); }
  legacyPath(id) { return this.#path(id, '.json'); }

  list() {
    const files = fs.readdirSync(this.rootDir);
    const entries = new Map(); // id -> { id, name } (DSL beats legacy)
    for (const f of files.filter(f => f.endsWith('.json') && !f.endsWith('.layout.json'))) {
      try {
        const flow = JSON.parse(fs.readFileSync(path.join(this.rootDir, f), 'utf8'));
        if (flow?.id && flow.name) entries.set(flow.id, { id: flow.id, name: flow.name });
      } catch { /* not a flow — ignore */ }
    }
    for (const f of files.filter(f => f.endsWith('.flow.yaml'))) {
      try {
        const flow = parseFlow(fs.readFileSync(path.join(this.rootDir, f), 'utf8'));
        entries.set(flow.id, { id: flow.id, name: flow.name });
      } catch { /* unparseable — ignore in the catalog */ }
    }
    return [...entries.values()]
      .sort((a, b) =>
        // Keep the shipped default pipeline at the top of the catalog.
        (a.id === DEFAULT_PIPELINE_ID ? -1 : b.id === DEFAULT_PIPELINE_ID ? 1 : a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
  }

  load(id) {
    // Both formats pass through the same normalization: retired template ids
    // are rewritten to their combined replacements, and the pinned structural
    // nodes (input/output) are restored if a legacy file lacks them. The next
    // save persists the migrated shape.
    if (fs.existsSync(this.flowPath(id))) {
      const flow = parseFlow(fs.readFileSync(this.flowPath(id), 'utf8'));
      return this.#withPositions(ensureStructuralNodes(migrateLegacyTemplates(flow)));
    }
    return ensureStructuralNodes(migrateLegacyTemplates(
      JSON.parse(fs.readFileSync(this.legacyPath(id), 'utf8'))));
  }

  // Merge stored canvas positions into a parsed (position-free) flow; any
  // node the sidecar doesn't know (e.g. AI-authored flows with no layout at
  // all) gets placed by the shared auto-layout so it renders sensibly.
  // Stale sidecar entries (deleted nodes) are dropped here and pruned by the
  // next save.
  #withPositions(flow) {
    let layout = {};
    try { layout = JSON.parse(fs.readFileSync(this.layoutPath(flow.id), 'utf8')) ?? {}; }
    catch { /* no sidecar — full auto-layout */ }
    const missing = flow.nodes.some(n => !layout[n.id]);
    const auto = missing ? layoutPositions(flow) : null;
    return {
      ...flow,
      nodes: flow.nodes.map(n => {
        const p = layout[n.id] ?? auto?.get(n.id) ?? { x: 0, y: 0 };
        return { ...n, position: { x: Math.round(p.x), y: Math.round(p.y) } };
      })
    };
  }

  save(flow) {
    if (!flow?.id || !flow.name) throw new Error('Flow needs an id and a name');
    // The structural nodes are pinned: every flow keeps its User Input and
    // Output node. The canvas refuses to delete them; removing them from the
    // YAML lands here and fails the save.
    if (!(flow.nodes ?? []).some(n => n.type === 'input')) {
      throw new Error('A flow must always contain its User Input node — reference "input" in the flow section (e.g. "input -> …") or declare a node of type input.');
    }
    if (!(flow.nodes ?? []).some(n => n.type === 'output')) {
      throw new Error('A flow must always contain its Output node — reference "output" in the flow section (e.g. "… -> output") or declare a node of type output.');
    }
    const clean = {
      id: flow.id,
      name: String(flow.name),
      ...(typeof flow.description === 'string' && flow.description.trim() ? { description: flow.description } : {}),
      nodes: (flow.nodes ?? []).map(n => {
        const position = { x: Math.round(n.position?.x ?? 0), y: Math.round(n.position?.y ?? 0) };
        return n.templateId
          ? { id: n.id, templateId: n.templateId, position, overrides: n.overrides ?? {} }
          : { id: n.id, type: n.type, kind: n.kind, position, data: n.data ?? {} };
      }),
      edges: (flow.edges ?? []).map(e => ({
        id: e.id, source: e.source, target: e.target,
        // Which declared output of the source feeds this edge; absent = primary.
        ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {})
      }))
    };
    // Structure to the DSL (deterministic → minimal diffs), positions to the
    // sidecar (pruned to live nodes by construction), legacy file retired.
    fs.writeFileSync(this.flowPath(flow.id), serializeFlow(clean), 'utf8');
    fs.writeFileSync(this.layoutPath(flow.id), JSON.stringify(
      Object.fromEntries(clean.nodes.map(n => [n.id, n.position])), null, 2), 'utf8');
    fs.rmSync(this.legacyPath(flow.id), { force: true });
    return clean;
  }

  // New flows start as a minimal, already-wired User Input → (template
  // instance, when the library has one) → Output chain so there is something
  // runnable to edit rather than a blank canvas.
  create(defaultTemplateId = null) {
    const id = 'flow-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const nodes = [
      { id: 'input-1', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
      ...(defaultTemplateId
        ? [{ id: 'step-1', templateId: defaultTemplateId, position: { x: 0, y: 130 }, overrides: {} }]
        : []),
      { id: 'output-1', type: 'output', kind: 'user', position: { x: 0, y: defaultTemplateId ? 260 : 130 }, data: {} }
    ];
    const chain = nodes.map(n => n.id);
    const flow = {
      id,
      name: UNTITLED_FLOW,
      nodes,
      edges: chain.slice(1).map((to, i) => ({ id: `e-${chain[i]}-${to}`, source: chain[i], target: to }))
    };
    return this.save(flow);
  }

  remove(id) {
    fs.rmSync(this.flowPath(id), { force: true });
    fs.rmSync(this.layoutPath(id), { force: true });
    fs.rmSync(this.legacyPath(id), { force: true });
  }

  // The classic plan → approve → route → execute → verify pipeline, rebuilt
  // from Node Library templates (GOALS.md migration step 5):
  //   User Input → Plan (plan-start) → [approval gate] Plan evaluation
  //   (plan-eval, materializes the work nodes) → Final evaluation → Output.
  // Seeded when missing; a regular editable flow like any other.
  ensureDefaultPipeline() {
    if (fs.existsSync(this.flowPath(DEFAULT_PIPELINE_ID)) || fs.existsSync(this.legacyPath(DEFAULT_PIPELINE_ID))) return false;
    const pos = i => ({ x: 0, y: i * 130 });
    this.save({
      id: DEFAULT_PIPELINE_ID,
      name: 'Default pipeline',
      nodes: [
        { id: 'user-input', type: 'input', kind: 'user', position: pos(0), data: {} },
        { id: 'plan', templateId: 'plan-start', position: pos(1), overrides: { title: 'Planning' } },
        // The post-planning human gate: pause for approval before routing.
        { id: 'route', templateId: 'evaluation', position: pos(2), overrides: { title: 'Routing', evalType: 'plan', requiresApproval: true } },
        { id: 'verify', templateId: 'evaluation', position: pos(3), overrides: { title: 'Verification', evalType: 'final' } },
        { id: 'result', type: 'output', kind: 'user', position: pos(4), data: {} }
      ],
      edges: [
        { id: 'e-user-input-plan', source: 'user-input', target: 'plan' },
        { id: 'e-plan-route', source: 'plan', target: 'route' },
        { id: 'e-route-verify', source: 'route', target: 'verify' },
        { id: 'e-verify-result', source: 'verify', target: 'result' }
      ]
    });
    return true;
  }
}
