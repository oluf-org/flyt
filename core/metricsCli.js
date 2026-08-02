#!/usr/bin/env node
// The metrics index command line (PIVOT-PLAN §4.5), mirroring the shape of
// `npm run flow -- lint|migrate`:
//
//   npm run metrics -- rebuild [--runs <dir>] [--json]   regenerate from runs/*/calls/
//   npm run metrics -- status  [--runs <dir>] [--json]   is the index current?
//   npm run metrics -- clear   [--runs <dir>]            delete it
//   npm run metrics -- top     [--runs <dir>] [--by model|provider|role] [--json]
//
// The index exists to be deleted. `rebuild` is the proof: verification item 7
// is "delete runs/_index/, relaunch, and every number is identical", and this
// command is how you check that by hand.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { RunStore } from './state.js';
import { rebuildIndex, readIndex, readIndexMeta, indexIsStale, clearIndex, INDEX_VERSION } from './metricsIndex.js';
import { rank, overview } from './investigate.js';
import { formatCost } from './callCost.js';
import { formatMs, formatTokens } from './runMetrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const args = process.argv.slice(2);
const json = args.includes('--json');
const VALUE_FLAGS = new Set(['runs', 'by']);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const [name, inline] = a.slice(2).split(/=(.*)/s);
  if (!VALUE_FLAGS.has(name)) continue;
  flags[name] = inline ?? args[++i] ?? '';
}
const [cmd] = positional;

const runsDir = flags.runs ? path.resolve(flags.runs) : path.join(projectRoot, 'runs');
const out = obj => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
const say = s => process.stdout.write(s + '\n');

const store = new RunStore(runsDir);

if (cmd === 'rebuild') {
  const meta = rebuildIndex(store);
  if (json) out({ ok: true, ...meta });
  else {
    say(`Rebuilt ${path.join(runsDir, '_index')} in ${meta.buildMs}ms`);
    say(`  ${meta.calls} call(s) across ${meta.runs.length} run(s)`);
    if (meta.preMetricsRuns) say(`  ${meta.preMetricsRuns} pre-metrics run(s) excluded — they never recorded calls`);
  }
} else if (cmd === 'status') {
  const meta = readIndexMeta(store);
  const stale = indexIsStale(store);
  if (json) out({ ok: true, stale, version: INDEX_VERSION, index: meta });
  else if (!meta) say('No index. Run `npm run metrics -- rebuild`. (The app also rebuilds it silently on launch.)');
  else {
    say(`Index v${meta.version}${meta.version === INDEX_VERSION ? '' : ` (app expects v${INDEX_VERSION})`}`);
    say(`  built ${meta.builtAt} · ${meta.calls} call(s) · ${meta.runs.length} run(s)`);
    say(stale ? '  STALE — it will be rebuilt on next launch.' : '  Current.');
  }
} else if (cmd === 'clear') {
  const ok = clearIndex(store);
  if (json) out({ ok });
  else say(ok ? 'Index deleted. Nothing was lost — it is derived from runs/*/calls/.' : 'Could not delete the index.');
} else if (cmd === 'top') {
  const rows = readIndex(store);
  const by = ['model', 'provider', 'role', 'flowId', 'nodeId'].includes(flags.by) ? flags.by : 'model';
  const table = rank(rows, { by });
  if (json) { out({ ok: true, by, overview: overview(rows), rows: table }); }
  else {
    const o = overview(rows);
    say(`${o.calls} call(s) across ${o.runs} run(s) · ${o.estimated ? '~' : ''}${formatCost(o.cost)} · ${formatTokens(o.tokens)} tokens`);
    say('');
    say(pad(by, 34) + pad('calls', 8) + pad('cost', 12) + pad('p50', 9) + pad('p95', 9) + pad('tok/s', 8) + 'sample');
    for (const r of table) {
      say(
        pad(String(r.key), 34)
        + pad(String(r.calls), 8)
        + pad(r.planCalls === r.calls ? 'plan' : `${r.estimated ? '~' : ''}${formatCost(r.cost)}`, 12)
        + pad(formatMs(r.latency?.p50), 9)
        + pad(formatMs(r.latency?.p95), 9)
        + pad(r.throughput?.p50 == null ? '—' : String(r.throughput.p50), 8)
        // §10.4: organic history is not a ranking. A row that has not been seen
        // across enough distinct nodes says so rather than being quietly
        // presented as if it had.
        + (r.comparable ? 'broad' : 'narrow — few distinct tasks')
      );
    }
    say('');
    say('Organic run history compares different prompts at different moments. These are');
    say('distributions, not a ranking — use a sweep for a controlled comparison.');
  }
} else {
  say('Usage:');
  say('  npm run metrics -- rebuild [--runs <dir>] [--json]');
  say('  npm run metrics -- status  [--runs <dir>] [--json]');
  say('  npm run metrics -- clear   [--runs <dir>]');
  say('  npm run metrics -- top     [--runs <dir>] [--by model|provider|role|flowId|nodeId] [--json]');
  process.exitCode = 1;
}

function pad(s, n) { const v = String(s ?? ''); return v.length >= n ? v.slice(0, n - 1) + ' ' : v + ' '.repeat(n - v.length); }
