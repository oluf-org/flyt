// Flow definitions: user-editable workflow graphs, one JSON file per flow in
// flows/. Same philosophy as RunStore — plain files are the source of truth,
// so flows are inspectable and portable.
//
//   { id, name, nodes:[{ id, type, kind, position:{x,y}, data:{...} }],
//     edges:[{ id, source, target }] }
//
// Node types (v1): input (user), agentTask (user), aiStep (ai), output (user).
// The classic linear pipeline is exposed as a built-in flow that is generated
// in code — never persisted, never editable, never deletable — so it cannot
// regress.
import fs from 'node:fs';
import path from 'node:path';

export const BUILTIN_FLOW_ID = 'builtin-linear';

export function builtinLinearFlow() {
  const pos = i => ({ x: 0, y: i * 110 });
  const chain = ['brief', 'planner', 'router', 'executor', 'verifier', 'result'];
  return {
    id: BUILTIN_FLOW_ID,
    name: 'Linear pipeline',
    builtin: true,
    nodes: [
      { id: 'brief',    type: 'input',  kind: 'user', position: pos(0), data: { title: 'Brief', text: '' } },
      { id: 'planner',  type: 'aiStep', kind: 'ai',   position: pos(1), data: { title: 'Planning', role: 'plan', system: '', worker: null } },
      { id: 'router',   type: 'aiStep', kind: 'ai',   position: pos(2), data: { title: 'Routing', role: 'custom', system: '', worker: null } },
      { id: 'executor', type: 'aiStep', kind: 'ai',   position: pos(3), data: { title: 'Execution', role: 'execute', system: '', worker: null } },
      { id: 'verifier', type: 'aiStep', kind: 'ai',   position: pos(4), data: { title: 'Verification', role: 'verify', system: '', worker: null } },
      { id: 'result',   type: 'output', kind: 'user', position: pos(5), data: { title: 'Result' } }
    ],
    edges: chain.slice(1).map((id, i) => ({ id: `e-${chain[i]}-${id}`, source: chain[i], target: id }))
  };
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class FlowStore {
  constructor(rootDir) {
    this.rootDir = rootDir; // e.g. <project>/flows
    fs.mkdirSync(rootDir, { recursive: true });
  }

  flowPath(id) {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid flow id "${id}"`);
    return path.join(this.rootDir, `${id}.json`);
  }

  list() {
    const builtin = builtinLinearFlow();
    const own = fs.readdirSync(this.rootDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const flow = JSON.parse(fs.readFileSync(path.join(this.rootDir, f), 'utf8'));
          return { id: flow.id, name: flow.name, builtin: false };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id));
    return [{ id: builtin.id, name: builtin.name, builtin: true }, ...own];
  }

  load(id) {
    if (id === BUILTIN_FLOW_ID) return builtinLinearFlow();
    return JSON.parse(fs.readFileSync(this.flowPath(id), 'utf8'));
  }

  save(flow) {
    if (!flow?.id || !flow.name) throw new Error('Flow needs an id and a name');
    if (flow.id === BUILTIN_FLOW_ID || flow.builtin) throw new Error('The built-in flow cannot be modified');
    const clean = {
      id: flow.id,
      name: String(flow.name),
      nodes: (flow.nodes ?? []).map(n => ({
        id: n.id, type: n.type, kind: n.kind,
        position: { x: Math.round(n.position?.x ?? 0), y: Math.round(n.position?.y ?? 0) },
        data: n.data ?? {}
      })),
      edges: (flow.edges ?? []).map(e => ({ id: e.id, source: e.source, target: e.target }))
    };
    fs.writeFileSync(this.flowPath(flow.id), JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  }

  // New flows start as a minimal, already-wired input → agentTask → output
  // chain so there is something runnable to edit rather than a blank canvas.
  create(defaultWorker = { provider: 'mock', model: 'mock-large' }) {
    const id = 'flow-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const flow = {
      id,
      name: 'Untitled flow',
      nodes: [
        { id: 'input-1', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: { text: '' } },
        { id: 'task-a', type: 'agentTask', kind: 'user', position: { x: 0, y: 130 }, data: { title: 'New task', goal: '', constraints: [], worker: { ...defaultWorker } } },
        { id: 'output-1', type: 'output', kind: 'user', position: { x: 0, y: 260 }, data: {} }
      ],
      edges: [
        { id: 'e-input-1-task-a', source: 'input-1', target: 'task-a' },
        { id: 'e-task-a-output-1', source: 'task-a', target: 'output-1' }
      ]
    };
    return this.save(flow);
  }

  remove(id) {
    if (id === BUILTIN_FLOW_ID) throw new Error('The built-in flow cannot be deleted');
    fs.rmSync(this.flowPath(id), { force: true });
  }
}
