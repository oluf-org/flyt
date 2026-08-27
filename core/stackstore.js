// Stack files and the one-time v1 flow migration (D52/D59/D62).
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_FLOWS_DIR, LEGACY_FLOW_EXTENSION } from './brand.js';
import { parseFlow } from './stacklang/parse.js';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const quote = value => JSON.stringify(String(value));
const useFor = node => {
  const id = node.templateId ?? node.data?.templateId ?? node.type ?? 'work';
  const refs = [node.overrides?.tools, node.overrides?.toolCeiling, node.data?.tools, node.data?.toolCeiling]
    .flat().filter(Boolean);
  if (refs.includes('web')) return 'flyt-blocks-core:research';
  if (id === 'agentTask') return 'flyt-blocks-core:work';
  if (id === 'aiStep') return 'flyt-blocks-core:general-analysis';
  if (['evaluation', 'compare', 'prompt-refiner'].includes(id)) return `flyt-blocks-judgement:${id}`;
  if (['interrogate', 'orient'].includes(id)) return `flyt-blocks-inquiry:${id}`;
  if (id === 'backlog-plan') return 'flyt-blocks-loop:backlog-plan';
  if (id === 'loop') return 'flyt-blocks-loop:loop-handoff';
  if (['fanout', 'orchestrator', 'subflow', 'container', 'inputs', 'runInputs'].includes(id)) {
    throw new Error(`Legacy structural node "${node.id}" (${id}) cannot be represented safely as a canonical block`);
  }
  return `flyt-blocks-core:${id}`;
};

function linearOrder(flow, nodes) {
  if (nodes.some(node => node.parentId)) {
    throw new Error('Legacy parent/child containment cannot be migrated safely without an explicit canonical container');
  }
  if (!nodes.length) throw new Error('A legacy flow with no executable nodes cannot become a runnable stack');
  const ids = new Set(nodes.map(node => node.id));
  const outgoing = new Map(nodes.map(node => [node.id, new Set()]));
  const incoming = new Map(nodes.map(node => [node.id, new Set()]));
  for (const edge of flow.edges ?? []) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    outgoing.get(edge.source).add(edge.target);
    incoming.get(edge.target).add(edge.source);
  }
  const edgeCount = [...outgoing.values()].reduce((count, next) => count + next.size, 0);
  const starts = nodes.filter(node => incoming.get(node.id).size === 0);
  const branching = nodes.filter(node => incoming.get(node.id).size > 1 || outgoing.get(node.id).size > 1);
  if (edgeCount !== nodes.length - 1 || starts.length !== 1 || branching.length) {
    throw new Error('Legacy branching or disconnected graph cannot be flattened safely; author its Sequence/Parallel containment explicitly');
  }
  const ordered = [];
  let current = starts[0];
  while (current) {
    ordered.push(current);
    const nextId = [...outgoing.get(current.id)][0];
    current = nextId ? nodes.find(node => node.id === nextId) : null;
  }
  if (ordered.length !== nodes.length) throw new Error('Legacy graph contains a cycle and cannot be migrated');
  return ordered;
}

function migratedConfig(node, use) {
  const config = { ...(node.data ?? {}), ...(node.overrides ?? {}) };
  delete config.title;
  delete config.templateId;
  if (config.maxToolIterations != null) {
    config.maxSteps = config.maxToolIterations;
    delete config.maxToolIterations;
  }
  if (config.worker?.model && !config.model) config.model = config.worker.model;
  const grants = [config.tools, config.toolCeiling].flat().filter(Boolean);
  const permitted = use === 'flyt-blocks-core:research'
    ? grants.every(ref => ['web', 'read-only'].includes(ref))
    : use === 'flyt-blocks-core:work'
      ? grants.every(ref => ref === 'loop')
      : grants.length === 0;
  if (!permitted) {
    throw new Error(`Legacy tool grant on "${node.id}" cannot be narrowed equivalently by ${use}`);
  }
  delete config.tools;
  delete config.toolCeiling;
  return config;
}

const scalar = value => {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return quote(value);
};

function mapping(lines, indent, key, value) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) { lines.push(`${pad}${key}: []`); return; }
    lines.push(`${pad}${key}:`);
    for (const item of value) arrayItem(lines, indent + 2, item);
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) { lines.push(`${pad}${key}: {}`); return; }
    lines.push(`${pad}${key}:`);
    for (const [childKey, child] of entries) mapping(lines, indent + 2, childKey, child);
    return;
  }
  lines.push(`${pad}${key}: ${scalar(value)}`);
}

function arrayItem(lines, indent, value) {
  const pad = ' '.repeat(indent);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (!entries.length) { lines.push(`${pad}- {}`); return; }
    const [[firstKey, first], ...rest] = entries;
    if (first && typeof first === 'object') {
      lines.push(`${pad}- ${firstKey}:`);
      if (Array.isArray(first)) for (const child of first) arrayItem(lines, indent + 4, child);
      else for (const [key, child] of Object.entries(first)) mapping(lines, indent + 4, key, child);
    } else {
      lines.push(`${pad}- ${firstKey}: ${scalar(first)}`);
    }
    for (const [key, child] of rest) mapping(lines, indent + 2, key, child);
    return;
  }
  if (Array.isArray(value)) {
    lines.push(`${pad}-`);
    for (const child of value) arrayItem(lines, indent + 2, child);
    return;
  }
  lines.push(`${pad}- ${scalar(value)}`);
}

function nodes(lines, children, indent, key) {
  lines.push(`${' '.repeat(indent)}${key}:`);
  for (const node of children) {
    const pad = ' '.repeat(indent + 2);
    lines.push(`${pad}- id: ${node.id}`);
    if (node.kind === 'block') {
      lines.push(`${pad}  use: ${node.use}`);
      if (node.title) lines.push(`${pad}  title: ${quote(node.title)}`);
      if (node.config && Object.keys(node.config).length) mapping(lines, indent + 4, 'config', node.config);
      if (node.outputs && Object.keys(node.outputs).length) mapping(lines, indent + 4, 'outputs', node.outputs);
      continue;
    }
    lines.push(`${pad}  kind: ${node.kind}`);
    if (node.kind === 'parallel' && node.maxParallel != null) lines.push(`${pad}  maxParallel: ${node.maxParallel}`);
    if (node.kind === 'repeat') lines.push(`${pad}  count: ${node.count}`);
    if (node.kind === 'foreach') {
      lines.push(`${pad}  roster: ${node.roster}`, `${pad}  max: ${node.max}`);
    }
    if (node.kind === 'until') {
      mapping(lines, indent + 4, 'condition', node.condition);
      lines.push(`${pad}  max: ${node.max}`);
    }
    if (node.kind === 'if') mapping(lines, indent + 4, 'predicate', node.predicate);
    const childKey = node.kind === 'parallel' ? 'lanes' : node.kind === 'sequence' ? 'blocks' : 'body';
    nodes(lines, node.children, indent + 4, childKey);
    if (node.kind === 'if' && node.else) nodes(lines, node.else, indent + 4, 'else');
  }
}

/** Serialize the parsed containment tree without ever inventing layout state. */
export function serializeStack(stack) {
  const lines = [
    'version: 2',
    `id: ${stack.id}`,
    `name: ${quote(stack.name || stack.id)}`,
  ];
  if (stack.description) lines.push(`description: ${quote(stack.description)}`);
  nodes(lines, stack.root?.children ?? [], 0, 'blocks');
  return `${lines.join('\n')}\n`;
}

export class StackStore {
  constructor(rootDir, {
    legacyRoot = path.join(path.dirname(rootDir), LEGACY_FLOWS_DIR),
    parseStack,
  } = {}) {
    if (typeof parseStack !== 'function') throw new Error('StackStore needs the canonical stack parser');
    this.rootDir = rootDir;
    this.legacyRoot = legacyRoot;
    this.parseStack = parseStack;
    fs.mkdirSync(rootDir, { recursive: true });
  }
  stackPath(id) {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid stack id "${id}"`);
    return path.join(this.rootDir, `${id}.stack.yaml`);
  }
  list() {
    const current = fs.readdirSync(this.rootDir).filter(f => f.endsWith('.stack.yaml'))
      .map(f => ({ id: f.slice(0, -11), legacy: false }));
    if (!fs.existsSync(this.legacyRoot)) return current;
    const seen = new Set(current.map(x => x.id));
    for (const f of fs.readdirSync(this.legacyRoot).filter(f => f.endsWith(LEGACY_FLOW_EXTENSION))) {
      const id = f.slice(0, -LEGACY_FLOW_EXTENSION.length);
      if (!seen.has(id)) current.push({ id, legacy: true });
    }
    return current;
  }
  loadSource(id) {
    const current = this.stackPath(id);
    if (fs.existsSync(current)) return fs.readFileSync(current, 'utf8');
    const legacy = path.join(this.legacyRoot, `${id}${LEGACY_FLOW_EXTENSION}`);
    if (!fs.existsSync(legacy)) throw new Error(`Stack "${id}" does not exist`);
    return this.#convert(fs.readFileSync(legacy, 'utf8'), id);
  }
  load(id) {
    return this.parseStack(this.loadSource(id), id);
  }
  save(id, source = this.loadSource(id)) {
    const parsed = this.parseStack(source, id);
    if (parsed.id !== id) throw new Error(`Stack id "${parsed.id}" does not match file id "${id}"`);
    const target = this.stackPath(id);
    fs.writeFileSync(target, source.endsWith('\n') ? source : `${source}\n`, 'utf8');
    const legacy = path.join(this.legacyRoot, `${id}${LEGACY_FLOW_EXTENSION}`);
    if (fs.existsSync(legacy)) fs.rmSync(legacy);
    return target;
  }
  saveStack(stack) {
    const source = serializeStack(stack);
    this.parseStack(source, stack.id);
    return this.save(stack.id, source);
  }
  #convert(source, fallbackId) {
    const flow = parseFlow(source);
    const executable = (flow.nodes ?? []).filter(n => !['input', 'output'].includes(n.type));
    const ordered = linearOrder(flow, executable);
    const lines = ['version: 2', `id: ${flow.id || fallbackId}`, `name: ${quote(flow.name || flow.id || fallbackId)}`, 'blocks:'];
    for (const node of ordered) {
      const use = useFor(node);
      lines.push(`  - id: ${node.id}`, `    use: ${use}`);
      const title = node.overrides?.title ?? node.data?.title;
      if (title) lines.push(`    title: ${quote(title)}`);
      const config = migratedConfig(node, use);
      if (Object.keys(config).length) mapping(lines, 4, 'config', config);
    }
    const converted = `${lines.join('\n')}\n`;
    this.parseStack(converted, flow.id || fallbackId);
    return converted;
  }
}
