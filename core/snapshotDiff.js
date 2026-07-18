// Incremental run-snapshot diffing (V1 task 5): shrink IPC pushes from the full
// run state down to just the changed slice. A run snapshot (RunStore.snapshot)
// has a fixed shape — a handful of whole-value fields plus three maps that grow
// with the run (nodeOutputs, taskOutputs, retrospectives). We diff the
// whole-value fields directly and the maps per entry, so a streaming node's
// 250ms flush pushes one node's markdown instead of re-sending the entire run.
//
// Pure and dependency-free: imported by the main process (to produce patches)
// and the renderer (to apply them), keeping the two sides provably symmetric.

// Whole-value fields: replaced wholesale when they differ. These stay small.
const WHOLE_FIELDS = ['meta', 'prompt', 'plan', 'tasks', 'flow', 'followups'];
// Map fields: diffed per key so only the touched entries travel.
const MAP_FIELDS = ['retrospectives', 'taskOutputs', 'nodeOutputs'];

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function mapDiff(prev, next) {
  const p = prev ?? {};
  const n = next ?? {};
  const set = {};
  const del = [];
  for (const k of Object.keys(n)) if (!eq(p[k], n[k])) set[k] = n[k];
  for (const k of Object.keys(p)) if (!(k in n)) del.push(k);
  return (Object.keys(set).length || del.length) ? { set, del } : null;
}

// Diff two snapshots. Returns a patch containing only the changed slices, or
// null when nothing changed. Callers send the full snapshot when there is no
// prior baseline to diff against.
export function diffSnapshot(prev, next) {
  if (!prev) return null;
  const patch = {};
  for (const f of WHOLE_FIELDS) if (!eq(prev[f], next[f])) patch[f] = next[f];
  for (const f of MAP_FIELDS) {
    const d = mapDiff(prev[f], next[f]);
    if (d) patch[f] = d;
  }
  return Object.keys(patch).length ? patch : null;
}

// Apply a patch (from diffSnapshot) onto a prior snapshot, returning a new
// object so React sees a fresh reference.
//
// A patch encodes "current minus baseline", so it reproduces the current
// snapshot ONLY when applied to the baseline it was diffed against. It does not
// converge from an arbitrary intermediate state: a field that changed and then
// changed back between baseline and current is absent from the patch (the diff
// is even null), so a receiver holding the intermediate value keeps it — see the
// A-B-A test in tests/snapshotDiff.test.js. That is why a rev must name exactly
// one snapshot on both sides, and why run:snapshot mints its content and rev
// together (electron/main.js) rather than pairing fresh content with the last
// pushed rev. Callers that can't guarantee the baseline must resync, not patch.
export function mergeSnapshot(prev, patch) {
  if (!prev || !patch) return prev;
  const next = { ...prev };
  for (const f of WHOLE_FIELDS) if (f in patch) next[f] = patch[f];
  for (const f of MAP_FIELDS) {
    if (!patch[f]) continue;
    const m = { ...(prev[f] ?? {}) };
    for (const [k, v] of Object.entries(patch[f].set ?? {})) m[k] = v;
    for (const k of patch[f].del ?? []) delete m[k];
    next[f] = m;
  }
  return next;
}
