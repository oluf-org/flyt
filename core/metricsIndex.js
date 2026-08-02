// The derived metrics index (PIVOT-PLAN §4.5) — what makes the ledger
// queryable across runs.
//
//   runs/_index/calls.jsonl   one line per call, append-only
//   runs/_index/meta.json     schema version, scanned runs, build timestamp
//
// DERIVED AND DISPOSABLE, and that is the whole contract. `npm run metrics --
// rebuild` regenerates it from runs/*/calls/*.json; the app rebuilds it
// silently on launch when it is missing, corrupt, or a schema version behind.
// Nothing reads it as truth. Verification item 7 is the test that keeps this
// honest: delete runs/_index/, relaunch, and every Investigator number must be
// identical.
//
// The narrowed non-goal it lives under (§3): no non-file store may ever be the
// source of truth. This is a file, and it is not the source of truth either.
import fs from 'node:fs';
import path from 'node:path';

// Bump when the LINE shape changes. A version drift triggers a silent rebuild,
// so a bump costs one directory walk and never a migration.
export const INDEX_VERSION = 2;

// One call, flattened for querying. Deliberately narrow — no wire pointers, no
// raw usage, no error text: this file is scanned end to end for every chart, so
// every field it carries is a field every chart pays for. Anything else is one
// readCalls() away in the run itself.
export function indexLine(runId, meta, call) {
  const u = call.usage ?? null;
  return {
    runId,
    seq: call.seq,
    at: call.startedAt ?? meta?.createdAt ?? null,
    flowId: meta?.flowId ?? null,
    flowName: meta?.flowName ?? null,
    modeId: meta?.modeId ?? null,
    nodeId: call.nodeId ?? null,
    taskId: call.taskId ?? null,
    role: call.role ?? null,
    provider: call.provider ?? null,
    model: call.model ?? null,
    ok: call.ok !== false,
    attempt: call.attempt ?? 0,
    durationMs: num(call.durationMs),
    ttftMs: num(call.ttftMs),
    tps: num(call.outputTokensPerSec),
    inTok: u ? u.inputTokens : null,
    cachedTok: u ? u.cachedInputTokens : null,
    outTok: u ? u.outputTokens : null,
    totalTok: u ? u.totalTokens : null,
    cost: num(call.cost?.total),
    costKind: call.cost?.costKind ?? null,
    estimated: Boolean(call.cost?.estimated)
  };
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// --- reading and writing --------------------------------------------------------

export function readIndexMeta(store) {
  try { return JSON.parse(fs.readFileSync(path.join(store.indexDir(), 'meta.json'), 'utf8')); }
  catch { return null; }
}

export function readIndex(store) {
  const p = path.join(store.indexDir(), 'calls.jsonl');
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    // A torn last line (a crash mid-append) costs that one call, not the file.
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

// Walk every run and regenerate the index from scratch. Returns a summary the
// CLI prints and the app logs.
export function rebuildIndex(store) {
  const started = Date.now();
  const dir = store.indexDir();
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  const runs = [];
  let preMetrics = 0;
  for (const runId of store.listRuns()) {
    let meta = null;
    try { meta = store.readMeta(runId); } catch { /* unreadable meta still indexes its calls */ }
    const calls = store.readCalls(runId);
    if (!calls.length) {
      // A run with no ledger is a pre-metrics run (decision 15) and is EXCLUDED
      // from aggregates rather than contributing zeros.
      preMetrics += 1;
      continue;
    }
    runs.push(runId);
    for (const c of calls) lines.push(JSON.stringify(indexLine(runId, meta, c)));
  }
  // Write to a temp file and rename: a rebuild interrupted halfway must not
  // leave a half-index that looks complete.
  const tmp = path.join(dir, 'calls.jsonl.tmp');
  fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  fs.renameSync(tmp, path.join(dir, 'calls.jsonl'));
  const meta = {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    runs,
    calls: lines.length,
    preMetricsRuns: preMetrics,
    buildMs: Date.now() - started
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

// Is the index usable as-is? Missing, corrupt, a version behind, or unaware of
// a run that now has calls all mean no.
export function indexIsStale(store) {
  const meta = readIndexMeta(store);
  if (!meta || meta.version !== INDEX_VERSION) return true;
  if (!fs.existsSync(path.join(store.indexDir(), 'calls.jsonl'))) return true;
  const known = new Set(meta.runs ?? []);
  for (const runId of store.listRuns()) {
    if (known.has(runId)) continue;
    // A run the index has never seen only matters if it actually recorded calls.
    if (fs.existsSync(path.join(store.callsDir(runId)))) return true;
  }
  return false;
}

// Rebuild if stale. Called on launch — silently, per §4.5 — and after any run
// that appended calls. Never throws: a broken index degrades the Investigator
// page, it does not break the app.
export function ensureIndex(store) {
  try { return indexIsStale(store) ? rebuildIndex(store) : readIndexMeta(store); }
  catch { return null; }
}

// Append one finished run's calls without a full rebuild. The index is
// append-only by design, so the common case (a run just ended) costs one write.
export function appendRun(store, runId) {
  try {
    const meta = readIndexMeta(store);
    // No index yet, or one that predates this schema: a rebuild is both correct
    // and cheap, and it is the only path that can produce a consistent file.
    if (!meta || meta.version !== INDEX_VERSION) return rebuildIndex(store);
    if ((meta.runs ?? []).includes(runId)) return rebuildIndex(store); // re-run/branch: redo it properly
    let runMeta = null;
    try { runMeta = store.readMeta(runId); } catch { /* still index the calls */ }
    const calls = store.readCalls(runId);
    if (!calls.length) return meta;
    const lines = calls.map(c => JSON.stringify(indexLine(runId, runMeta, c))).join('\n') + '\n';
    fs.appendFileSync(path.join(store.indexDir(), 'calls.jsonl'), lines, 'utf8');
    const next = {
      ...meta,
      builtAt: new Date().toISOString(),
      runs: [...(meta.runs ?? []), runId],
      calls: (meta.calls ?? 0) + calls.length
    };
    fs.writeFileSync(path.join(store.indexDir(), 'meta.json'), JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch { return null; }
}

// Drop the index. Used by the CLI's `clear`, and by anything that would rather
// force a rebuild than reason about staleness.
export function clearIndex(store) {
  try { fs.rmSync(store.indexDir(), { recursive: true, force: true }); return true; }
  catch { return false; }
}
