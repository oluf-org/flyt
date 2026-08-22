#!/usr/bin/env node
// Flow DSL command line — the AI/CI surface of the DSL (FLOW_LANG.md):
//
//   npm run flow -- lint [<file>] [--json]   validate a *.flow.yaml — or, with no
//                                            file, every flow this repo ships (exit 1 on errors)
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
import { ToolStore } from '../toolstore.js';
import { installedFlowsDir, listFlows, adoptFlow, willShip } from './adopt.js';
import { ROLE_PORTS, setKnownTools } from '../../src/flowTypes.js';

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

// The tool library is data (tools/<id>.json), so `availableTools` — what an AI
// authoring a flow is told it may grant — is read from the library rather than
// from a constant. Installed first: template grants are filtered against it.
const toolLibrary = new ToolStore(path.join(projectRoot, 'tools'));
const availableTools = toolLibrary.ids();
const readOnlyTools = toolLibrary.listFull()
  .filter(t => t.enabled && (t.effects ?? []).every(e => e === 'read'))
  .map(t => t.id);
setKnownTools(availableTools);

function loadTemplates() {
  return new NodeStore(path.join(projectRoot, 'nodes')).listFull();
}

const COMMON_OVERRIDES = ['title', 'worker', 'instructions', 'requiresApproval', 'approveToolCalls', 'goal', 'category', 'contextSpec', 'skills', 'toolCeiling', 'tools', 'effect', 'effectScope'];

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
    allowedOverrides: COMMON_OVERRIDES,
    // What may be granted here. An aiStep may hold read-effect tools only
    // (DESIGN-SPEC.md §5), so it is told a narrower list than an agentTask —
    // and both are told the toolsets a ceiling can be written in.
    availableTools: t.baseType === 'agentTask' ? availableTools : readOnlyTools,
    toolsets: toolLibrary.listSets().map(s => ({ id: s.id, description: s.description }))
  };
}

// Every *.flow.yaml sitting beside the file being linted. The sub-flow rules
// resolve `flow:` references against the whole directory — a cycle or a
// missing brick is only visible from the outside (D36 P3.4).
function siblingFlows(file) {
  const dir = path.dirname(path.resolve(file));
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.flow.yaml')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(parseFlow(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch { /* its own lint reports it */ }
  }
  return out;
}

// Every flow this repository ships, for the no-argument form below.
function shippedFlows() {
  const dir = path.join(projectRoot, 'flows');
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.flow.yaml')).sort()
      .map(f => path.join(dir, f));
  } catch { return []; }
}

/**
 * Lint one flow, or — with no argument — every flow this repository ships.
 *
 * The bare form exists because it is the form the contributor guide documents:
 * "Run `npm run flow -- lint` after changing shipped flows, the DSL, template
 * resolution, or tool-grant linting." It did not run. It printed a usage line
 * and exited 2, so everybody who followed the instruction got an error, and a
 * task that put the documented command in its `gates` was unlandable by
 * construction — no diff could ever make it pass, and the failure said nothing
 * about the flows.
 *
 * A gate is checked for whether its INTERPRETER exists (`gateProblem`), which
 * `npm` does; nothing checks whether the command is well-formed, and nothing
 * can in general. Making the documented command mean something is the fix that
 * closes it at the source.
 */
function cmdLint() {
  const targets = target ? [target] : shippedFlows();
  if (!targets.length) {
    fail(target ? 'usage: flow lint <file.flow.yaml> [--json]' : 'no flows/*.flow.yaml to lint');
  }

  const results = targets.map(file => ({
    file,
    ...lintText(fs.readFileSync(file, 'utf8'), {
      templates: loadTemplates(), library: toolLibrary.catalog(), flows: siblingFlows(file)
    })
  }));
  const ok = results.every(r => r.ok);

  // One file keeps exactly the shape it always had: this is a CI surface and
  // something is reading it.
  if (json) {
    out(target
      ? { ok, errors: results[0].errors, warnings: results[0].warnings }
      : { ok, files: results.map(r => ({ file: path.relative(projectRoot, r.file), ok: r.ok, errors: r.errors, warnings: r.warnings })) });
  } else if (target) {
    for (const f of results[0].findings) {
      console.log(`${f.severity === 'error' ? 'ERROR  ' : 'warning'}  ${f.rule}  ${f.message}`);
    }
    console.log(results[0].ok
      ? `OK — ${path.basename(target)} (${results[0].warnings.length} warning${results[0].warnings.length === 1 ? '' : 's'})`
      : `FAILED — ${results[0].errors.length} error${results[0].errors.length === 1 ? '' : 's'}, ${results[0].warnings.length} warning(s)`);
  } else {
    for (const r of results) {
      for (const f of r.findings) {
        console.log(`${f.severity === 'error' ? 'ERROR  ' : 'warning'}  ${path.basename(r.file)}  ${f.rule}  ${f.message}`);
      }
    }
    const bad = results.filter(r => !r.ok).length;
    const warnings = results.reduce((n, r) => n + r.warnings.length, 0);
    console.log(ok
      ? `OK — ${results.length} flow${results.length === 1 ? '' : 's'} (${warnings} warning${warnings === 1 ? '' : 's'})`
      : `FAILED — ${bad} of ${results.length} flow(s) have errors`);
  }
  process.exitCode = ok ? 0 : 1;
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
  const lint = lintText(fs.readFileSync(r.file, 'utf8'), { templates: loadTemplates(), library: toolLibrary.catalog() });

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
