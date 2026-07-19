// The living constellation (LANDER-PLAN.md L4/§4) — a sparse node-graph drawn
// faintly behind the empty lander: the canvas "asleep" under the surface.
//
// Phase 3 renders it STATIC (drift + the focus wink land in Phase 4). Node
// positions are seeded from the project id with the same FNV-1a hash + PRNG the
// sigils use, so every project gets its own stable constellation — the sigil
// system's determinism, promoted to an app-wide identity principle. The
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
    nodes.push({
      x: MARGIN + r() * (VW - 2 * MARGIN),
      y: MARGIN + r() * (VH - 2 * MARGIN),
      r: 2.4 + r() * 2.6,
      // Per-dot drift timing (Phase 4): one shared @keyframes, desynced by a
      // varied duration (20–40s) and a random negative delay so no two dots
      // ever share a phase. Seeded, so the motion is stable per project.
      dur: 20 + r() * 20,
      delay: -(r() * 40)
    });
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
  return { nodes, edges: edges.slice(0, 12) };
}

export default function Constellation({ seed }) {
  const { nodes, edges } = useMemo(() => build(seed || APP_SEED), [seed]);
  return (
    <svg
      className="constellation"
      viewBox={`0 0 ${VW} ${VH}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g className="constellation-lines">
        {edges.map(([a, b], i) => (
          <line key={i} x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y} />
        ))}
      </g>
      <g className="constellation-dots">
        {nodes.map((n, i) => (
          <circle
            key={i}
            className={n.near ? 'near' : undefined}
            cx={n.x} cy={n.y} r={n.r}
            style={{ animationDuration: `${n.dur}s`, animationDelay: `${n.delay}s` }}
          />
        ))}
      </g>
    </svg>
  );
}
