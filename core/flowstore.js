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

// The tiered default pipelines (MODES-COMPARE T7): each is a refiner-first
// flow, shipped with two example worker modes so the mode picker and the
// comparison view have something to run day one.
export const SEED_PIPELINE_IDS = ['pipeline-low', 'pipeline-medium', 'pipeline-high', 'pipeline-ultra'];

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

// A mode id slugged from a human name ("GPT-5 · strict" -> "gpt-5-strict");
// null when nothing usable remains.
function slugModeId(name) {
  if (typeof name !== 'string') return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

// The enriched planner brief the "High" and "Ultra" tiers run at high effort —
// carried as node DATA (a `system` override) so the tier is pure content, not a
// code fork (T8). It still opens with `ROLE: plan-start` so role detection and
// the run's logging stay identical to the default planner.
const HIGH_PLANNER_SYSTEM = [
  'ROLE: plan-start',
  'You are the Start node of an advanced planning flowchart, running at HIGH effort.',
  'Given the user brief, produce ONLY a structured tasks.md.',
  'Decompose the work into the smallest independently-verifiable tasks that still',
  'carry real meaning. Prefer breadth: surface tasks that can run IN PARALLEL and',
  'say so, and state dependencies explicitly so the orchestrator can widen each wave.',
  'For every task include a "Context files:" section naming each file and, per file,',
  'exactly which part is needed — the smallest sufficient context, never the whole repo.',
  'Assign a Category from: Code general, Code design, documentation, Test-creation, and',
  'suggest the "work" template. Call out risks, unknowns, and acceptance criteria per task.',
  'Be exhaustive about structure and ruthless about context size.'
].join('\n');

// Two example worker bundles — the same graph on a Fable brain vs a GPT brain —
// applied to the given "brain" node ids. Picked at launch; layered as launch
// overrides at run start (T1).
function workerModes(brainIds) {
  const bundle = worker => Object.fromEntries(brainIds.map(id => [id, { worker }]));
  return {
    fable: { name: 'Fable', overrides: bundle({ provider: 'anthropic', model: 'claude-fable-5' }) },
    gpt: { name: 'GPT', overrides: bundle({ provider: 'openai', model: 'gpt-5' }) }
  };
}

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
        // A modes summary rides in the catalog (MODES-COMPARE T4) so the launch
        // picker can expand a flow into its named configurations without
        // re-reading the file. P1 (CONFIGS-COMPARE) adds the pass-through
        // scalars so pickers/cards can show description + lineage.
        const modes = flow.modes && Object.keys(flow.modes).length
          ? Object.entries(flow.modes).map(([id, m]) => ({
              id, name: m?.name || id,
              ...(typeof m?.description === 'string' && m.description.trim() ? { description: m.description } : {}),
              ...(typeof m?.derivedFrom === 'string' && m.derivedFrom.trim() ? { derivedFrom: m.derivedFrom } : {})
            }))
          : null;
        entries.set(flow.id, { id: flow.id, name: flow.name, ...(modes ? { modes } : {}) });
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
      // modes: named launch-override bundles (MODES-COMPARE T2). Structure to
      // the DSL like everything else; validated by the linter, not here.
      ...(flow.modes && Object.keys(flow.modes).length ? { modes: flow.modes } : {}),
      nodes: (flow.nodes ?? []).map(n => {
        const position = { x: Math.round(n.position?.x ?? 0), y: Math.round(n.position?.y ?? 0) };
        // parentId marks containment: the node lives inside an orchestrator's
        // box (position is then relative to it) and runs in its sub-walk.
        const parent = n.parentId ? { parentId: n.parentId } : {};
        // expose (MODES-COMPARE T9): which node fields become composer run
        // inputs. A first-class field like parentId, not an override. Read from
        // the node itself or (for a resolved node) its data.
        const exposeList = Array.isArray(n.expose) ? n.expose : (Array.isArray(n.data?.expose) ? n.data.expose : null);
        const exp = exposeList?.length ? { expose: exposeList } : {};
        return n.templateId
          ? { id: n.id, templateId: n.templateId, position, overrides: n.overrides ?? {}, ...parent, ...exp }
          : { id: n.id, type: n.type, kind: n.kind, position, data: n.data ?? {}, ...parent, ...exp };
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

  // --- Configs (CONFIGS-COMPARE P1): modes as first-class, editable bundles ---
  //
  // A config IS a mode in the flow's `modes:` block — these helpers load the
  // flow, upsert one mode, and save through the normal path (DSL stays the
  // source of truth; lint validates the result). `derivedFrom` is lineage
  // metadata only: duplicating copies the FULL override map and records the
  // parent; nothing is merged or inherited at run time.

  // Create or update one config on a flow. Fields left undefined keep their
  // previous value (patch semantics); `overrides` replaces wholesale when
  // given. Returns the stored mode.
  saveConfig(flowId, modeId, config = {}) {
    if (!SAFE_ID.test(modeId)) throw new Error(`Invalid mode id "${modeId}"`);
    const flow = this.load(flowId);
    const prev = flow.modes?.[modeId] ?? null;
    const text = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const scalar = (key) => {
      const v = config[key];
      if (v === undefined) return prev?.[key] ?? null; // untouched: keep
      return text(v); // given: set, or clear on blank
    };
    const mode = {
      ...(scalar('name') ? { name: scalar('name') } : {}),
      ...(scalar('description') ? { description: scalar('description') } : {}),
      ...(scalar('derivedFrom') ? { derivedFrom: scalar('derivedFrom') } : {}),
      overrides: config.overrides !== undefined
        ? (config.overrides ?? {})
        : (prev?.overrides ?? {})
    };
    const modes = { ...(flow.modes ?? {}), [modeId]: mode };
    this.save({ ...flow, modes });
    return mode;
  }

  // Copy a config's full override map under a new id, recording the source as
  // `derivedFrom` (lineage only). Refuses to overwrite an existing config.
  duplicateConfig(flowId, sourceId, newId, { name = null } = {}) {
    if (!SAFE_ID.test(newId)) throw new Error(`Invalid mode id "${newId}"`);
    const flow = this.load(flowId);
    const src = flow.modes?.[sourceId];
    if (!src) throw new Error(`Flow "${flowId}" has no config "${sourceId}".`);
    if (flow.modes?.[newId]) throw new Error(`Flow "${flowId}" already has a config "${newId}".`);
    const mode = this.saveConfig(flowId, newId, {
      name: name?.trim() || `${src.name ?? sourceId} (copy)`,
      description: src.description,
      derivedFrom: sourceId,
      overrides: structuredClone(src.overrides ?? {})
    });
    return mode;
  }

  // Promote a finished run's launch configuration to a named config on its
  // flow (P1: tweak at launch → run → it works → one click makes it a named,
  // comparable config). `meta` is the run's meta.json: its launchOverrides
  // become the override map, its modeId (if any) becomes derivedFrom. The new
  // id is slugged from the given name (or the source mode) and deduped.
  promoteRunConfig(flowId, meta, { name = null } = {}) {
    const overrides = meta?.launchOverrides;
    if (!overrides || typeof overrides !== 'object' || !Object.keys(overrides).length) {
      throw new Error('This run used the default configuration — nothing to save as a config.');
    }
    const base = slugModeId(name) ?? slugModeId(meta?.modeId) ?? 'run-config';
    const flow = this.load(flowId);
    let id = base;
    for (let n = 2; flow.modes?.[id]; n++) id = `${base}-${n}`;
    const mode = this.saveConfig(flowId, id, {
      name: name?.trim() || `Saved from run`,
      derivedFrom: meta?.modeId,
      overrides: structuredClone(overrides)
    });
    return { modeId: id, mode };
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

  #seedMissing(id) {
    return !fs.existsSync(this.flowPath(id)) && !fs.existsSync(this.legacyPath(id));
  }

  // The tiered default pipelines (MODES-COMPARE T7). Each is seeded only when
  // absent, so user edits (and deletions) are never overwritten. Returns the
  // ids actually created.
  ensureSeedPipelines() {
    const builders = {
      'pipeline-low': () => this.#lowPipeline(),
      'pipeline-medium': () => this.#mediumPipeline(),
      'pipeline-high': () => this.#highPipeline(),
      'pipeline-ultra': () => this.#ultraPipeline()
    };
    const created = [];
    for (const id of SEED_PIPELINE_IDS) {
      if (this.#seedMissing(id)) { this.save(builders[id]()); created.push(id); }
    }
    return created;
  }

  // Low — refine → single work node. The quickest path for a well-scoped task.
  #lowPipeline() {
    const pos = i => ({ x: 0, y: i * 130 });
    return {
      id: 'pipeline-low', name: 'Low',
      description: 'Refine the request, then one work node. The quickest path for a well-scoped task.',
      nodes: [
        { id: 'input', type: 'input', kind: 'user', position: pos(0), data: {} },
        { id: 'refine', templateId: 'prompt-refiner', position: pos(1), overrides: {} },
        { id: 'work', templateId: 'work', position: pos(2), overrides: { category: 'Code general', effort: 'medium' }, expose: ['worker', 'effort'] },
        { id: 'output', type: 'output', kind: 'user', position: pos(3), data: {} }
      ],
      edges: [
        { id: 'e-input-refine', source: 'input', target: 'refine' },
        { id: 'e-refine-work', source: 'refine', target: 'work' },
        { id: 'e-work-output', source: 'work', target: 'output' }
      ],
      modes: workerModes(['refine', 'work'])
    };
  }

  // Medium — refine → plan → orchestrator (1–5). Planning with a bounded swarm.
  #mediumPipeline() {
    const pos = i => ({ x: 0, y: i * 130 });
    return {
      id: 'pipeline-medium', name: 'Medium',
      description: 'Refine, plan, then an orchestrator that fans the plan out to a small swarm (1–5 nodes).',
      nodes: [
        { id: 'input', type: 'input', kind: 'user', position: pos(0), data: {} },
        { id: 'refine', templateId: 'prompt-refiner', position: pos(1), overrides: {} },
        { id: 'plan', templateId: 'plan-start', position: pos(2), overrides: { title: 'Plan', effort: 'medium' } },
        { id: 'orchestrate', type: 'orchestrator', kind: 'ai', position: pos(3), data: { title: 'Orchestrate', minNodes: 1, maxNodes: 5 } },
        { id: 'output', type: 'output', kind: 'user', position: pos(4), data: {} }
      ],
      edges: [
        { id: 'e-input-refine', source: 'input', target: 'refine' },
        { id: 'e-refine-plan', source: 'refine', target: 'plan' },
        { id: 'e-plan-orchestrate', source: 'plan', target: 'orchestrate' },
        { id: 'e-orchestrate-output', source: 'orchestrate', target: 'output' }
      ],
      modes: workerModes(['refine', 'plan', 'orchestrate'])
    };
  }

  // High — Medium's graph at high effort: an enriched planner and a wider
  // orchestrator budget (2–10), with that budget exposed as a run input.
  #highPipeline() {
    const pos = i => ({ x: 0, y: i * 130 });
    return {
      id: 'pipeline-high', name: 'High',
      description: 'Refine, plan deeply, then a wider orchestrated swarm (2–10 nodes). For substantial, decomposable work.',
      nodes: [
        { id: 'input', type: 'input', kind: 'user', position: pos(0), data: {} },
        { id: 'refine', templateId: 'prompt-refiner', position: pos(1), overrides: {} },
        { id: 'plan', templateId: 'plan-start', position: pos(2), overrides: { title: 'Plan', effort: 'high', system: HIGH_PLANNER_SYSTEM } },
        { id: 'orchestrate', type: 'orchestrator', kind: 'ai', position: pos(3), data: { title: 'Orchestrate', minNodes: 2, maxNodes: 10 }, expose: ['minNodes', 'maxNodes'] },
        { id: 'output', type: 'output', kind: 'user', position: pos(4), data: {} }
      ],
      edges: [
        { id: 'e-input-refine', source: 'input', target: 'refine' },
        { id: 'e-refine-plan', source: 'refine', target: 'plan' },
        { id: 'e-plan-orchestrate', source: 'plan', target: 'orchestrate' },
        { id: 'e-orchestrate-output', source: 'orchestrate', target: 'output' }
      ],
      modes: workerModes(['refine', 'plan', 'orchestrate'])
    };
  }

  // Ultra — High plus a final evaluation between the orchestrator and the
  // output, wired back to the orchestrator by a feedback edge for one bounded
  // retry when the work falls short of the plan.
  #ultraPipeline() {
    const pos = i => ({ x: 0, y: i * 130 });
    return {
      id: 'pipeline-ultra', name: 'Ultra',
      description: 'High plus a final evaluation that can send the swarm back once for a bounded retry.',
      nodes: [
        { id: 'input', type: 'input', kind: 'user', position: pos(0), data: {} },
        { id: 'refine', templateId: 'prompt-refiner', position: pos(1), overrides: {} },
        { id: 'plan', templateId: 'plan-start', position: pos(2), overrides: { title: 'Plan', effort: 'high', system: HIGH_PLANNER_SYSTEM } },
        { id: 'orchestrate', type: 'orchestrator', kind: 'ai', position: pos(3), data: { title: 'Orchestrate', minNodes: 2, maxNodes: 10 }, expose: ['minNodes', 'maxNodes'] },
        { id: 'evaluate', templateId: 'evaluation', position: pos(4), overrides: { title: 'Final evaluation', evalType: 'final' } },
        { id: 'output', type: 'output', kind: 'user', position: pos(5), data: {} }
      ],
      edges: [
        { id: 'e-input-refine', source: 'input', target: 'refine' },
        { id: 'e-refine-plan', source: 'refine', target: 'plan' },
        { id: 'e-plan-orchestrate', source: 'plan', target: 'orchestrate' },
        { id: 'e-orchestrate-evaluate', source: 'orchestrate', target: 'evaluate' },
        { id: 'e-evaluate-output', source: 'evaluate', target: 'output' },
        // Feedback channel: the final evaluation judges the swarm's aggregate
        // and may send it back once (bounded retry) via a pass/retry verdict.
        { id: 'e-evaluate-orchestrate-fb', source: 'evaluate', target: 'orchestrate', sourceHandle: 'feedback' }
      ],
      modes: workerModes(['refine', 'plan', 'orchestrate', 'evaluate'])
    };
  }
}
