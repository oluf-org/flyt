// Stack files and the one-time v1 flow migration (D52/D59/D62).
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_FLOWS_DIR, LEGACY_FLOW_EXTENSION } from './brand.js';
import { parseFlow } from './stacklang/parse.js';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const quote = value => JSON.stringify(String(value));
const useFor = node => {
  const id = node.templateId ?? node.data?.templateId ?? node.type ?? 'work';
  if (['evaluation', 'compare', 'prompt-refiner'].includes(id)) return `flyt-blocks-judgement:${id}`;
  if (['interrogate', 'orient'].includes(id)) return `flyt-blocks-inquiry:${id}`;
  if (id === 'backlog-plan' || id === 'loop') return `flyt-blocks-loop:${id}`;
  return `flyt-blocks-core:${id}`;
};

export class StackStore {
  constructor(rootDir, { legacyRoot = path.join(path.dirname(rootDir), LEGACY_FLOWS_DIR) } = {}) {
    this.rootDir = rootDir;
    this.legacyRoot = legacyRoot;
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
  save(id, source = this.loadSource(id)) {
    const target = this.stackPath(id);
    fs.writeFileSync(target, source.endsWith('\n') ? source : `${source}\n`, 'utf8');
    const legacy = path.join(this.legacyRoot, `${id}${LEGACY_FLOW_EXTENSION}`);
    if (fs.existsSync(legacy)) fs.rmSync(legacy);
    return target;
  }
  #convert(source, fallbackId) {
    const flow = parseFlow(source);
    const nodes = (flow.nodes ?? []).filter(n => !['input', 'output'].includes(n.type));
    const lines = ['version: 2', `id: ${flow.id || fallbackId}`, `name: ${quote(flow.name || flow.id || fallbackId)}`, 'blocks:'];
    for (const node of nodes) {
      lines.push(`  - id: ${node.id}`, `    use: ${useFor(node)}`);
      const config = { ...(node.data ?? {}), ...(node.overrides ?? {}) };
      delete config.title; delete config.templateId;
      if (Object.keys(config).length) lines.push(`    config: ${JSON.stringify(config)}`);
    }
    if (!nodes.length) lines.push('  - id: work', '    use: flyt-blocks-core:work');
    return `${lines.join('\n')}\n`;
  }
}
