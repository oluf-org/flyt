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
const KIND_OF = { input: 'user', agentTask: 'user', output: 'user', aiStep: 'ai', orchestrator: 'ai', fanout: 'ai' };
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
  // `parent: <orchestratorId>` declares containment: the node lives inside
  // that orchestrator's box on the canvas and runs in its inline sub-walk.
  // `expose: [worker, effort]` (MODES-COMPARE T9) declares which of the node's
  // fields the flow author surfaces as ad-hoc run inputs in the composer — a
  // first-class node field, not an override value.
  const { use, type, kind, parent, expose, ...rest } = entry;
  const parentId = parent == null ? null : String(parent);
  if (expose != null && (!Array.isArray(expose) || expose.some(f => typeof f !== 'string'))) {
    throw new FlowParseError(`node "${id}" expose must be a list of field names`);
  }
  const exposeField = Array.isArray(expose) ? { expose: expose.map(String) } : {};
  if (use && type) throw new FlowParseError(`node "${id}" has both "use" and "type" — pick one`);
  if (use) {
    return { id, templateId: String(use), overrides: rest, ...(parentId ? { parentId } : {}), ...exposeField };
  }
  if (type) {
    if (!(type in KIND_OF)) throw new FlowParseError(`node "${id}" has unknown type "${type}"`);
    return { id, type, kind: kind ?? KIND_OF[type], data: rest, ...(parentId ? { parentId } : {}), ...exposeField };
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
  if (doc.modes != null && (typeof doc.modes !== 'object' || Array.isArray(doc.modes))) {
    throw new FlowParseError('"modes" must be a map of mode id -> definition');
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

  // modes: named, saved launch-override bundles (MODES-COMPARE T2). One graph,
  // N configurations picked at run start. Structure is checked here; whether a
  // mode's overrides reference real nodes / legal fields is the linter's job.
  const modes = parseModes(doc.modes);

  return {
    id: doc.id,
    name: doc.name,
    ...(typeof doc.description === 'string' && doc.description.trim() ? { description: doc.description } : {}),
    nodes,
    edges,
    ...(modes && Object.keys(modes).length ? { modes } : {})
  };
}

// doc.modes -> { [modeId]: { name?, description?, derivedFrom?, overrides:
// { [nodeId]: {...fields} } } }. Only structural shape is enforced (map of
// maps); the linter validates the override fields against the actual nodes.
// `description` and `derivedFrom` (CONFIGS-COMPARE P1) are pass-through
// scalars: description is picker/card copy; derivedFrom is lineage metadata
// only — it records which mode a duplicate/promote came from and carries NO
// merge or inheritance semantics at run time.
function parseModes(raw) {
  if (raw == null) return null;
  const modes = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!REF_RE.exec(id) || id.includes('.')) throw new FlowParseError(`invalid mode id "${id}"`);
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new FlowParseError(`mode "${id}" must be a map of fields`);
    }
    const { name, description, derivedFrom, overrides, ...rest } = entry;
    const extra = Object.keys(rest);
    if (extra.length) throw new FlowParseError(`mode "${id}" has unknown field(s): ${extra.join(', ')}`);
    if (name != null && typeof name !== 'string') throw new FlowParseError(`mode "${id}" name must be a string`);
    if (description != null && typeof description !== 'string') throw new FlowParseError(`mode "${id}" description must be a string`);
    if (derivedFrom != null && (typeof derivedFrom !== 'string' || !REF_RE.exec(derivedFrom) || derivedFrom.includes('.'))) {
      throw new FlowParseError(`mode "${id}" derivedFrom must be a mode id`);
    }
    if (overrides != null && (typeof overrides !== 'object' || Array.isArray(overrides))) {
      throw new FlowParseError(`mode "${id}" overrides must be a map of nodeId -> fields`);
    }
    const ov = {};
    for (const [nodeId, fields] of Object.entries(overrides ?? {})) {
      if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new FlowParseError(`mode "${id}" override for "${nodeId}" must be a map of fields`);
      }
      ov[nodeId] = fields;
    }
    modes[id] = {
      ...(typeof name === 'string' && name.trim() ? { name } : {}),
      ...(typeof description === 'string' && description.trim() ? { description } : {}),
      ...(typeof derivedFrom === 'string' && derivedFrom.trim() ? { derivedFrom } : {}),
      overrides: ov
    };
  }
  return modes;
}
