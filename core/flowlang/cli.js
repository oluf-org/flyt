#!/usr/bin/env node
// Flow DSL command line — the AI/CI surface of the DSL (REFACTOR-PLAN §6):
//
//   npm run flow -- lint <file> [--json]     validate a *.flow.yaml (exit 1 on errors)
//   npm run flow -- templates [--json]       Node Library templates + ports + allowed overrides
//   npm run flow -- migrate [--json]         convert legacy flows/*.json → .flow.yaml + .layout.json
//
// --json output is machine-readable so an AI can act on it programmatically.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { lintText } from './lint.js';
import { serializeFlow } from './serialize.js';
import { parseFlow } from './parse.js';
import { NodeStore } from '../nodestore.js';
import { ROLE_PORTS, AGENT_TOOLS } from '../../src/flowTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..', '..');

const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter(a => !a.startsWith('--'));
const [cmd, target] = positional;

const out = obj => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

function loadTemplates() {
  return new NodeStore(path.join(projectRoot, 'nodes')).listFull();
}

const COMMON_OVERRIDES = ['title', 'worker', 'instructions', 'requiresApproval', 'approveToolCalls', 'goal', 'category', 'contextSpec', 'skills'];

function templateInfo(t) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    baseType: t.baseType,
    role: t.role,
    category: t.category,
    requiresApproval: t.requiresApproval,
    outputs: (t.outputs?.length ? t.outputs : ROLE_PORTS[t.role] ?? ROLE_PORTS.custom)
      .map(p => ({ id: p.id, label: p.label ?? p.id, ...(p.description ? { description: p.description } : {}) })),
    allowedOverrides: [...COMMON_OVERRIDES, ...(t.baseType === 'agentTask' ? ['tools'] : [])],
    ...(t.baseType === 'agentTask' ? { availableTools: AGENT_TOOLS } : {})
  };
}

function cmdLint() {
  if (!target) fail('usage: flow lint <file.flow.yaml> [--json]');
  const text = fs.readFileSync(target, 'utf8');
  const r = lintText(text, { templates: loadTemplates() });
  if (json) {
    out({ ok: r.ok, errors: r.errors, warnings: r.warnings });
  } else {
    for (const f of r.findings) {
      console.log(`${f.severity === 'error' ? 'ERROR  ' : 'warning'}  ${f.rule}  ${f.message}`);
    }
    console.log(r.ok
      ? `OK — ${path.basename(target)} (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})`
      : `FAILED — ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}, ${r.warnings.length} warning(s)`);
  }
  process.exitCode = r.ok ? 0 : 1;
}

function cmdTemplates() {
  const list = loadTemplates().map(templateInfo);
  if (json) out({ templates: list, edgeGrammar: 'source[.port] -> target [-> target2 ...]', implicitNodes: ['input', 'output'] });
  else {
    for (const t of list) {
      console.log(`${t.id}  [${t.baseType}${t.category ? ` · ${t.category}` : ''}]  ports: ${t.outputs.map(o => o.id).join(', ') || '—'}`);
      console.log(`    ${t.description}`);
    }
  }
}

// Legacy flows/<id>.json → <id>.flow.yaml + <id>.layout.json. The legacy
// file is kept (read path still supports it) unless --rm is passed; the
// store prefers .flow.yaml when both exist.
function cmdMigrate() {
  const dir = target ? path.resolve(target) : path.join(projectRoot, 'flows');
  const rm = args.includes('--rm');
  const results = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.layout.json'))) {
    const file = path.join(dir, f);
    try {
      const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!legacy?.id || !Array.isArray(legacy.nodes)) throw new Error('not a flow definition');
      const yaml = serializeFlow(legacy);
      parseFlow(yaml); // sanity: must round-trip before we call it migrated
      const layout = Object.fromEntries(legacy.nodes
        .filter(n => n.position)
        .map(n => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]));
      fs.writeFileSync(path.join(dir, `${legacy.id}.flow.yaml`), yaml, 'utf8');
      fs.writeFileSync(path.join(dir, `${legacy.id}.layout.json`), JSON.stringify(layout, null, 2), 'utf8');
      if (rm) fs.rmSync(file);
      results.push({ file: f, ok: true, to: `${legacy.id}.flow.yaml` });
    } catch (err) {
      results.push({ file: f, ok: false, error: err.message });
    }
  }
  if (json) out({ migrated: results });
  else for (const r of results) console.log(r.ok ? `migrated  ${r.file} → ${r.to}` : `SKIPPED   ${r.file}: ${r.error}`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

switch (cmd) {
  case 'lint': cmdLint(); break;
  case 'templates': cmdTemplates(); break;
  case 'migrate': cmdMigrate(); break;
  default:
    fail('usage: npm run flow -- <lint <file> | templates | migrate [dir] [--rm]> [--json]');
}
