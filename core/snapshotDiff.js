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
const WHOLE_FIELDS = ['meta', 'prompt', 'plan', 'tasks', 'flow'];
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
// object so React sees a fresh reference. Because each patch encodes
// "current minus baseline", applying it to any state at/after that baseline
// converges to the current snapshot — which is what makes coalesced pushes and
// mid-run view switches safe.
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
