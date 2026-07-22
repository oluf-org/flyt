// The living constellation (LANDER-PLAN.md L4/§4) — a sparse node-graph drawn
// faintly behind the empty lander: the canvas "asleep" under the surface.
//
// Node positions are seeded from the project id with the same FNV-1a hash +
// PRNG the sigils use, so every project gets its own stable constellation — the
// sigil system's determinism, promoted to an app-wide identity principle. The
// projectless lander uses a fixed, neutral app seed.
//
// Hard rules (§4): abstract (never a real workflow graph), never above ~0.5
// opacity, one absolutely-positioned SVG that can't intercept pointer events and
// is fully contained so it never triggers layout on the rest of the page.
import { useMemo } from 'react';
import { hash, rng } from './sigil.js';

// A generous viewBox the SVG covers with `slice`, so dots stay circular (never
// stretched) whatever the pane's aspect ratio. Positions live in this space.
const VW = 1200, VH = 800;
const MARGIN = 90;
const MIN_GAP = 130; // rejection-sampled spacing so pairs never sit on top of each other
const APP_SEED = 'llm-flow'; // neutral constellation when there is no project

// Where the composer visually sits over the constellation (~centre, a touch
// above middle). The nearest dot gets tinted on focus — the canvas noticing
// you're about to speak (§4 focus wink).
const FOCUS_X = VW / 2, FOCUS_Y = VH * 0.44;

function build(seed) {
  const r = rng(hash(seed));
  const count = 10 + Math.floor(r() * 5); // 10–14 dots
  const nodes = [];
  for (let i = 0; i < count; i++) {
    // Rejection-sample positions to a minimum spacing: without it two dots can
    // land almost coincident and their connecting line reads as a smudge.
    let x, y, tries = 0;
    do {
      x = MARGIN + r() * (VW - 2 * MARGIN);
      y = MARGIN + r() * (VH - 2 * MARGIN);
      tries++;
    } while (
      tries < 20 &&
      nodes.some(n => (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y) < MIN_GAP * MIN_GAP)
    );
    nodes.push({ x, y, r: 2.4 + r() * 2.6 });
  }

  // The dot nearest the composer anchor — tinted accent on focus-within.
  let near = -1, nearD = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const dx = nodes[i].x - FOCUS_X, dy = nodes[i].y - FOCUS_Y;
    const d = dx * dx + dy * dy;
    if (d < nearD) { nearD = d; near = i; }
  }
  if (near >= 0) nodes[near].near = true;

  // Lines connect each dot to its nearest neighbour (a spanning-ish web, never a
  // real graph). Deduped and capped so the field reads as texture, not a mesh.
  const seen = new Set();
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = j; }
    }
    const key = i < best ? `${i}-${best}` : `${best}-${i}`;
    if (best >= 0 && !seen.has(key)) { seen.add(key); edges.push([i, best]); }
  }
  const kept = edges.slice(0, 12);

  // Group nodes + edges into connected components ("clusters"). Drift animates
  // each cluster as a single group, so a line and both its endpoints always move
  // together — dots never slide off their lines. Different clusters get desynced
  // seeded timings, keeping the field alive without any per-dot divergence.
  const comp = nodes.map((_, i) => i);
  const find = i => (comp[i] === i ? i : (comp[i] = find(comp[i])));
  for (const [a, b] of kept) comp[find(a)] = find(b);
  const clusterOf = new Map(); // root -> cluster index
  const clusters = [];
  for (let i = 0; i < nodes.length; i++) {
    const root = find(i);
    if (!clusterOf.has(root)) {
      clusterOf.set(root, clusters.length);
      // One shared @keyframes, desynced by a varied duration (20–40s) and a
      // random negative delay so no two clusters ever share a phase. Seeded, so
      // the motion is stable per project.
      clusters.push({ nodes: [], edges: [], dur: 20 + r() * 20, delay: -(r() * 40) });
    }
    clusters[clusterOf.get(root)].nodes.push(i);
  }
  for (const e of kept) clusters[clusterOf.get(find(e[0]))].edges.push(e);

  // Entrance stagger (load-in): dots pop in one by one, then each line draws
  // itself between two dots that already exist. Order follows node index, which
  // is seeded — the same constellation always assembles the same way.
  nodes.forEach((n, i) => { n.in = 0.08 * i; });
  kept.forEach(e => { e.in = 0.35 + Math.max(nodes[e[0]].in, nodes[e[1]].in); });

  return { nodes, clusters };
}

export default function Constellation({ seed }) {
  const { nodes, clusters } = useMemo(() => build(seed || APP_SEED), [seed]);
  return (
    <svg
      className="constellation"
      viewBox={`0 0 ${VW} ${VH}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {clusters.map((c, ci) => (
        <g
          key={ci}
          className="constellation-cluster"
          style={{ animationDuration: `${c.dur}s`, animationDelay: `${c.delay}s` }}
        >
          <g className="constellation-lines">
            {c.edges.map((e, i) => (
              <line
                key={i}
                pathLength="1"
                x1={nodes[e[0]].x} y1={nodes[e[0]].y}
                x2={nodes[e[1]].x} y2={nodes[e[1]].y}
                style={{ animationDelay: `${e.in}s` }}
              />
            ))}
          </g>
          <g className="constellation-dots">
            {c.nodes.map(i => (
              <circle
                key={i}
                className={nodes[i].near ? 'near' : undefined}
                cx={nodes[i].x} cy={nodes[i].y} r={nodes[i].r}
                style={{ animationDelay: `${nodes[i].in}s` }}
              />
            ))}
          </g>
        </g>
      ))}
    </svg>
  );
}
