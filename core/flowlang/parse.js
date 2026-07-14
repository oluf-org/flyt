// Flow DSL parser: *.flow.yaml text → the canonical flow object the rest of
// the app already consumes ({ id, name, description?, nodes[], edges[] }) —
// minus positions, which are presentation and live in <id>.layout.json
// (see core/flowstore.js). Deterministic, no side effects. See FLOW_LANG.md.
import { parseYaml, YamlError } from './yaml.js';

export const DSL_VERSION = 1;

// One `flow:` entry: `source[.port] -> target [-> target2 ...]`
// Each element is an id with an optional named output port. A port on the
// final element is meaningless (nothing consumes it) and is rejected.
const REF_RE = /^([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?$/;

// baseType → kind, mirroring src/flowTypes.js TYPE_META.
const KIND_OF = { input: 'user', agentTask: 'user', output: 'user', aiStep: 'ai', orchestrator: 'ai' };
export const STRUCTURAL_TYPES = Object.keys(KIND_OF);

export class FlowParseError extends Error {
  constructor(message) { super(message); this.name = 'FlowParseError'; }
}

export function parseEdgeExpr(expr) {
  const parts = String(expr).split('->').map(s => s.trim());
  if (parts.length < 2 || parts.some(p => !p)) {
    throw new FlowParseError(`bad flow entry "${expr}" — expected "source[.port] -> target [-> ...]"`);
  }
  const refs = parts.map(p => {
    const m = REF_RE.exec(p);
    if (!m) throw new FlowParseError(`bad node reference "${p}" in flow entry "${expr}"`);
    return { id: m[1], port: m[2] ?? null };
  });
  if (refs[refs.length - 1].port) {
    throw new FlowParseError(`flow entry "${expr}" ends in a port — ports select a source output, so they are meaningless on the final target`);
  }
  const edges = [];
  for (let i = 0; i < refs.length - 1; i++) {
    edges.push({
      source: refs[i].id,
      target: refs[i + 1].id,
      ...(refs[i].port ? { sourceHandle: refs[i].port } : {})
    });
  }
  return edges;
}

function parseNodeEntry(id, entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new FlowParseError(`node "${id}" must be a map of fields`);
  }
  const { use, type, kind, ...rest } = entry;
  if (use && type) throw new FlowParseError(`node "${id}" has both "use" and "type" — pick one`);
  if (use) {
    return { id, templateId: String(use), overrides: rest };
  }
  if (type) {
    if (!(type in KIND_OF)) throw new FlowParseError(`node "${id}" has unknown type "${type}"`);
    return { id, type, kind: kind ?? KIND_OF[type], data: rest };
  }
  throw new FlowParseError(`node "${id}" needs either "use: <templateId>" or "type: <baseType>"`);
}

// text → canonical flow object (no positions). Throws FlowParseError/YamlError
// on malformed input; semantic problems are the linter's job (core/flowlang/lint.js).
export function parseFlow(text) {
  let doc;
  try { doc = parseYaml(text); }
  catch (err) {
    if (err instanceof YamlError) throw new FlowParseError(`YAML: ${err.message}`);
    throw err;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new FlowParseError('flow file must be a YAML map');
  }
  if (doc.version !== DSL_VERSION) {
    throw new FlowParseError(`unsupported or missing "version" (expected ${DSL_VERSION}, got ${JSON.stringify(doc.version ?? null)})`);
  }
  if (!doc.id || typeof doc.id !== 'string') throw new FlowParseError('missing "id"');
  if (!doc.name || typeof doc.name !== 'string') throw new FlowParseError('missing "name"');

  if (doc.nodes != null && (typeof doc.nodes !== 'object' || Array.isArray(doc.nodes))) {
    throw new FlowParseError('"nodes" must be a map of node id -> definition');
  }
  if (doc.flow != null && !Array.isArray(doc.flow)) {
    throw new FlowParseError('"flow" must be a list of "source[.port] -> target" entries');
  }

  const nodes = [];
  const declared = new Set();
  for (const [id, entry] of Object.entries(doc.nodes ?? {})) {
    if (!REF_RE.exec(id) || id.includes('.')) throw new FlowParseError(`invalid node id "${id}"`);
    nodes.push(parseNodeEntry(id, entry));
    declared.add(id);
  }

  const edges = [];
  const seen = new Set();
  const referenced = new Set();
  for (const expr of doc.flow ?? []) {
    if (typeof expr !== 'string') throw new FlowParseError(`flow entries must be strings, got ${JSON.stringify(expr)}`);
    for (const e of parseEdgeExpr(expr)) {
      const id = `e-${e.source}-${e.target}`;
      if (!seen.has(id + (e.sourceHandle ?? ''))) {
        seen.add(id + (e.sourceHandle ?? ''));
        edges.push({ id, ...e });
      }
      referenced.add(e.source);
      referenced.add(e.target);
    }
  }

  // `input` / `output` are implicit built-in structural nodes: referencing
  // them in `flow` without declaring them creates them. Declared ones
  // (any id, incl. legacy names like input-1) pass through as declared.
  if (referenced.has('input') && !declared.has('input')) {
    nodes.unshift({ id: 'input', type: 'input', kind: 'user', data: {} });
  }
  if (referenced.has('output') && !declared.has('output')) {
    nodes.push({ id: 'output', type: 'output', kind: 'user', data: {} });
  }

  return {
    id: doc.id,
    name: doc.name,
    ...(typeof doc.description === 'string' && doc.description.trim() ? { description: doc.description } : {}),
    nodes,
    edges
  };
}
