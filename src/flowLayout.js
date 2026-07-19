// Graph helpers shared by the flow editor (App/FlowCanvas) and the runner:
// a layered auto-layout and edge validation. Plain JS, no React/DOM, so the
// main process can import it too (like flowTypes.js).

// True when adding source -> target would close a cycle (i.e. target already
// reaches source), or when the edge is a self-loop.
export function wouldCreateCycle(edges, source, target) {
  if (source === target) return true;
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source).push(e.target);
  }
  const seen = new Set();
  const stack = [target];
  while (stack.length) {
    const id = stack.pop();
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adj.get(id) ?? []) stack.push(next);
  }
  return false;
}

// Layered auto-layout: depth = longest dependency chain from a root, one row
// per depth, rows centered on the widest row. Within a row, nodes keep their
// relative left-to-right order (stable under repeated application). Returns
// a Map<nodeId, {x, y}> so callers decide how to apply it (immutably in the
// editor, in place on the runner's flow copy).
export function layoutPositions(flow, { xGap = 260, yGap = 130, x0 = 40, y0 = 40 } = {}) {
  // Container children (parentId) hold positions RELATIVE to their parent —
  // leave them out of the top-level layout entirely.
  const nodes = flow.nodes.filter(n => !n.parentId);
  const ids = new Set(nodes.map(n => n.id));
  const parents = new Map(nodes.map(n => [n.id, []]));
  for (const e of flow.edges) {
    if (ids.has(e.source) && ids.has(e.target)) parents.get(e.target).push(e.source);
  }

  // Longest path from a root; a visiting guard keeps stray cycles (possible
  // in a hand-edited file) from recursing forever — members get depth 0.
  const depth = new Map();
  const visiting = new Set();
  const depthOf = id => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(0, ...parents.get(id).map(p => depthOf(p) + 1));
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  nodes.forEach(n => depthOf(n.id));

  const rows = new Map();
  for (const n of nodes) {
    const d = depth.get(n.id);
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d).push(n);
  }
  const widest = Math.max(...[...rows.values()].map(r => r.length));
  const centerX = x0 + ((widest - 1) * xGap) / 2;

  const positions = new Map();
  for (const [d, row] of rows) {
    row.sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0));
    const rowX0 = centerX - ((row.length - 1) * xGap) / 2;
    row.forEach((n, i) => positions.set(n.id, { x: rowX0 + i * xGap, y: y0 + d * yGap }));
  }
  return positions;
}

// Grid layout for the CHILDREN of an orchestrator container: dependency
// waves become rows inside the box, positions are relative to the parent.
// Returns { positions: Map<id,{x,y}>, box: {w,h} } — the box is sized to fit.
export function containerLayout(children, edges, {
  xGap = 250, yGap = 96, padX = 22, padTop = 58, padBottom = 46, cardW = 230
} = {}) {
  const ids = new Set(children.map(n => n.id));
  const parents = new Map(children.map(n => [n.id, []]));
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) parents.get(e.target).push(e.source);
  }
  const depth = new Map();
  const visiting = new Set();
  const depthOf = id => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(0, ...parents.get(id).map(p => depthOf(p) + 1));
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  children.forEach(n => depthOf(n.id));

  const rows = new Map();
  for (const n of children) {
    const d = depth.get(n.id);
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d).push(n);
  }
  const widest = Math.max(1, ...[...rows.values()].map(r => r.length));
  const innerW = (widest - 1) * xGap + cardW;
  const centerX = padX + innerW / 2;

  const positions = new Map();
  for (const [d, row] of rows) {
    const rowX0 = centerX - ((row.length - 1) * xGap + cardW) / 2;
    row.forEach((n, i) => positions.set(n.id, { x: rowX0 + i * xGap, y: padTop + d * yGap }));
  }
  return {
    positions,
    box: {
      w: padX * 2 + innerW,
      h: padTop + (rows.size - 1) * yGap + 72 + padBottom
    }
  };
}
