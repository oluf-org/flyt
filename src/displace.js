// Local displacement (OUTPUT-VIEW-PLAN B3 / D4): when a node grows into its
// expanded reader card, the neighbors it would overlap shift just far enough
// to get clear — along the minimal-translation vector, plus a gutter — and
// anything THEY now overlap shifts in turn, cascading outward. The cascade is
// depth-capped so a dense graph can't shove distant nodes; beyond the cap we
// accept plain overlap (the expanded card floats above on z-order anyway).
//
// On collapse the caller restores every recorded `from` position exactly —
// except nodes the user manually dragged meanwhile (their move wins; the
// caller filters the restore set, this module only records).
//
// Pure math over plain rects ({id, x, y, w, h}) — no React Flow, no DOM —
// so it unit-tests in node directly (tests/displace.test.js).

export const DISPLACE_GUTTER = 24;   // breathing room between the reader and its neighbors
export const MAX_CASCADE_DEPTH = 4;  // beyond this, fall back to plain overlap (risk D-cascades)

// Strict rect overlap (touching edges is NOT overlapping — a gutter-separated
// neighbor is already clear).
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w &&
         a.y < b.y + b.h && b.y < a.y + a.h;
}

// The smallest single-axis translation that separates `rect` from `obstacle`,
// leaving `gutter` px between them. Given an overlap all four directions are
// valid separators; ties resolve toward right/down, the canvas's natural
// growth directions.
export function minTranslation(rect, obstacle, gutter = DISPLACE_GUTTER) {
  const right = obstacle.x + obstacle.w + gutter - rect.x; // push rect right
  const left = rect.x + rect.w - (obstacle.x - gutter);    // push rect left (magnitude)
  const down = obstacle.y + obstacle.h + gutter - rect.y;  // push rect down
  const up = rect.y + rect.h - (obstacle.y - gutter);      // push rect up (magnitude)
  const candidates = [
    { dx: right, dy: 0, mag: Math.max(0, right) },
    { dx: -left, dy: 0, mag: Math.max(0, left) },
    { dx: 0, dy: down, mag: Math.max(0, down) },
    { dx: 0, dy: -up, mag: Math.max(0, up) }
  ];
  candidates.sort((a, b) => a.mag - b.mag);
  return { dx: candidates[0].dx, dy: candidates[0].dy };
}

// Move `rect` clear of every obstacle, iterating: the minimal push against
// one obstacle can land on another, so re-check until clear. The iteration
// cap is the plain-overlap fallback for pathological stacks.
function resolveAgainstAll(rect, obstacles, gutter) {
  let r = { ...rect };
  for (let iter = 0; iter < 8; iter++) {
    const obs = obstacles.find(o => rectsOverlap(o, r));
    if (!obs) return r;
    const t = minTranslation(r, obs, gutter);
    r = { ...r, x: r.x + t.dx, y: r.y + t.dy };
  }
  return r;
}

// computeDisplacement(nodes, target): the moves needed so no node overlaps
// `target` (the expanded card's bbox), cascading to depth `maxDepth`.
//   nodes  — top-level neighbors as {id, x, y, w, h} (exclude the expanding
//            node itself; its rect IS the target)
//   target — {x, y, w, h} of the expanded card
// Returns [{id, from:{x,y}, to:{x,y}}] in move order; `from` is always the
// node's ORIGINAL position, so a collapse can restore exactly.
export function computeDisplacement(nodes, target, { gutter = DISPLACE_GUTTER, maxDepth = MAX_CASCADE_DEPTH } = {}) {
  const moves = [];
  const pos = new Map(nodes.map(n => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }]));
  const moved = new Set();
  // Obstacles a moved node must clear: the target plus every node already
  // displaced (their new rects). Unmoved nodes are NOT obstacles — displacing
  // onto one is what the next cascade round resolves.
  const obstacles = [target];
  let frontier = [target];
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    const nextFrontier = [];
    for (const n of nodes) {
      if (moved.has(n.id)) continue;
      const r = pos.get(n.id);
      if (!frontier.some(f => rectsOverlap(f, r))) continue;
      const to = resolveAgainstAll(r, obstacles, gutter);
      moved.add(n.id);
      moves.push({ id: n.id, from: { x: r.x, y: r.y }, to: { x: to.x, y: to.y } });
      pos.set(n.id, to);
      obstacles.push(to);
      nextFrontier.push(to);
    }
    frontier = nextFrontier;
  }
  return moves;
}
