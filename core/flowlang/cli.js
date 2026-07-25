#!/usr/bin/env node
// Flow DSL command line — the AI/CI surface of the DSL (REFACTOR-PLAN §6):
//
//   npm run flow -- lint <file> [--json]     validate a *.flow.yaml (exit 1 on errors)
//   npm run flow -- templates [--json]       Node Library templates + ports + allowed overrides
//   npm run flow -- migrate [--json]         convert legacy flows/*.json → .flow.yaml + .layout.json
//   npm run flow -- adopt [--json]           list flows in the INSTALLED app
//   npm run flow -- adopt <id> [--as <new-id>] [--from <dir>] [--force]
//                                            copy one into flows/ as a shipped default
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
import { installedFlowsDir, listFlows, adoptFlow, willShip } from './adopt.js';
import { ROLE_PORTS, AGENT_TOOLS } from '../../src/flowTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..', '..');

const args = process.argv.slice(2);
const json = args.includes('--json');

// Value flags (--as x, --as=x, --from dir). Consumed values are kept out of the
// positional list so `adopt <id> --as foo` still sees exactly one positional.
const VALUE_FLAGS = new Set(['as', 'from']);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const [name, inline] = a.slice(2).split(/=(.*)/s);
  if (!VALUE_FLAGS.has(name)) continue;            // boolean flag (--json, --rm, --force)
  flags[name] = inline ?? args[++i] ?? '';
}
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

// Promote a flow designed in the installed app into a shipped default (D28).
// With no <id> it lists what's available, because after a session in the app
// you remember the flow's NAME, not its generated id.
function cmdAdopt() {
  const from = flags.from ? path.resolve(flags.from) : installedFlowsDir();
  const repoFlows = path.join(projectRoot, 'flows');

  if (!target) {
    const list = listFlows(from);
    if (json) { out({ dir: from, flows: list.map(({ mtime, ...f }) => f) }); return; }
    console.log(`installed flows: ${from}`);
    if (!list.length) {
      console.log('  (none — is the app installed and has it been run?  override with --from <dir>)');
      return;
    }
    for (const f of list) {
      console.log(`  ${f.id.padEnd(24)} ${f.name}${f.ships ? '  [already a shipping id]' : ''}`);
    }
    console.log('\nadopt one with:  npm run flow -- adopt <id> [--as <new-id>]');
    return;
  }

  const force = args.includes('--force');
  let r;
  try {
    r = adoptFlow({ from, to: repoFlows, id: target, as: flags.as || null, overwrite: force });
  } catch (err) {
    if (json) { out({ ok: false, error: err.message }); process.exitCode = 1; return; }
    fail(err.message);
  }

  // Adopted, but is it actually valid against THIS repo's node library? An id
  // referencing a template that only exists in the installed app would ship broken.
  const lint = lintText(fs.readFileSync(r.file, 'utf8'), { templates: loadTemplates() });

  if (json) {
    out({ ok: lint.ok, ...r, lint: { ok: lint.ok, errors: lint.errors, warnings: lint.warnings } });
  } else {
    console.log(`adopted  ${r.from} → flows/${r.id}.flow.yaml${r.layout ? ' (+ .layout.json)' : ' (no layout sidecar found)'}`);
    console.log(`         "${r.name}"`);
    for (const f of lint.findings) console.log(`  ${f.severity === 'error' ? 'ERROR  ' : 'warning'}  ${f.rule}  ${f.message}`);
    if (!r.ships) {
      console.log(`  WARNING  id "${r.id}" starts with "flow-", which electron-builder excludes from the package.`);
      console.log(`           Re-run with --as <id> to give it a shipping id.`);
    }
    console.log(lint.ok
      ? '  OK — commit it and it ships as a default on the next build.'
      : '  FAILED lint — fix the errors above before shipping it.');
  }
  if (!lint.ok) process.exitCode = 1;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

switch (cmd) {
  case 'lint': cmdLint(); break;
  case 'templates': cmdTemplates(); break;
  case 'migrate': cmdMigrate(); break;
  case 'adopt': cmdAdopt(); break;
  default:
    fail([
      'usage: npm run flow -- <command> [--json]',
      '  lint <file>                                 validate a *.flow.yaml',
      '  templates                                   list Node Library templates',
      '  migrate [dir] [--rm]                        legacy *.json → *.flow.yaml',
      '  adopt                                       list flows in the installed app',
      '  adopt <id> [--as <new-id>] [--from <dir>] [--force]',
      '                                              promote one into flows/ as a default'
    ].join('\n'));
}
