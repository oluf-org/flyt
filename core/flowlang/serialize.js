// Flow DSL serializer: canonical flow object → *.flow.yaml text.
//
// Round-trip stable by construction: fixed top-level key order, fixed node
// field order, one flow line per edge in stored order, deterministic scalar
// quoting (core/flowlang/yaml.js). parseFlow(serializeFlow(x)) reproduces x
// (minus positions, which belong to <id>.layout.json), and
// serializeFlow(parseFlow(y)) is byte-identical for serializer-produced y —
// so canvas edits and AI edits generate minimal diffs.
import { formatScalar, formatInline } from './yaml.js';
import { DSL_VERSION } from './parse.js';

// Field order inside a node entry: use/type first, then the human-salient
// fields, then anything else alphabetically. Purely cosmetic but FIXED.
const FIELD_ORDER = [
  'title', 'role', 'category', 'system', 'instructions', 'goal', 'contextSpec',
  'text', 'worker', 'tools', 'skills', 'constraints', 'outputs', 'requiresApproval', 'approveToolCalls'
];
const fieldRank = k => {
  const i = FIELD_ORDER.indexOf(k);
  return i === -1 ? FIELD_ORDER.length : i;
};

const KIND_OF = { input: 'user', agentTask: 'user', output: 'user', aiStep: 'ai', orchestrator: 'ai' };

function emitValue(lines, key, v, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    // arrays of objects read better as block lists; scalar arrays inline
    if (v.length && v.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      lines.push(`${pad}${key}:`);
      for (const item of v) lines.push(`${pad}  - ${formatInline(item)}`);
      return;
    }
    lines.push(`${pad}${key}: ${formatInline(v)}`);
    return;
  }
  if (typeof v === 'string' && v.includes('\n')) {
    // Multiline strings as literal blocks when they round-trip exactly
    // through our parser subset, else JSON-quoted (always exact).
    const chomped = !v.endsWith('\n');
    const body = chomped ? v : v.slice(0, -1);
    const ls = body.split('\n');
    const ok = ls[0] && !ls[0].startsWith(' ')            // first line anchors the block indent
      && ls[ls.length - 1].trim() !== ''                  // parser chomps trailing blank lines
      && ls.every(l => l === '' || l.trim() !== '');      // whitespace-only lines don't survive
    if (ok) {
      lines.push(`${pad}${key}: ${chomped ? '|-' : '|'}`);
      for (const l of ls) lines.push(l === '' ? '' : `${pad}  ${l}`);
      return;
    }
  }
  lines.push(`${pad}${key}: ${formatInline(v)}`);
}

function emitNode(lines, node) {
  const fields = node.templateId
    ? { use: node.templateId, ...(node.overrides ?? {}) }
    : {
        type: node.type,
        // kind is derivable from type; only persist a deviation
        ...(node.kind && node.kind !== KIND_OF[node.type] ? { kind: node.kind } : {}),
        ...(node.data ?? {})
      };
  lines.push(`  ${formatScalar(node.id)}:`);
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
  const head = keys.filter(k => k === 'use' || k === 'type' || k === 'kind');
  const rest = keys.filter(k => !head.includes(k))
    .sort((a, b) => fieldRank(a) - fieldRank(b) || a.localeCompare(b));
  for (const k of [...head, ...rest]) emitValue(lines, k, fields[k], 4);
}

// True for the implicit built-in nodes the parser re-creates from `flow`
// references alone — they carry no information, so they are not written out.
function isImplicit(node) {
  const empty = !node.data || Object.keys(node.data).length === 0;
  return empty
    && ((node.id === 'input' && node.type === 'input') || (node.id === 'output' && node.type === 'output'))
    && (node.kind ?? KIND_OF[node.type]) === KIND_OF[node.type];
}

export function serializeFlow(flow) {
  if (!flow?.id || !flow.name) throw new Error('Flow needs an id and a name');
  const lines = [];
  lines.push(`version: ${DSL_VERSION}`);
  lines.push(`id: ${formatScalar(flow.id)}`);
  lines.push(`name: ${formatScalar(flow.name)}`);
  if (typeof flow.description === 'string' && flow.description.trim()) {
    emitValue(lines, 'description', flow.description, 0);
  }
  lines.push('');
  const declared = (flow.nodes ?? []).filter(n => !isImplicit(n));
  if (declared.length) {
    lines.push('nodes:');
    for (const n of declared) emitNode(lines, n);
    lines.push('');
  }
  lines.push('flow:');
  for (const e of flow.edges ?? []) {
    const port = e.sourceHandle ? `.${e.sourceHandle}` : '';
    lines.push(`  - ${e.source}${port} -> ${e.target}`);
  }
  return lines.join('\n') + '\n';
}
