# Constellation background that spells "Flyt"

A brief you can hand to a website builder (or an AI coding assistant) to reproduce
the Flyt app's lander background on a marketing site — but with the dots arranged
so the constellation reads as the word **FLYT**.

---

## 1. What the effect is

A single absolutely-positioned SVG sitting behind the page content:

- **Dots** — small circles, `fill` a very faint foreground colour.
- **Lines** — hairlines connecting dots, `stroke` an even fainter divider colour.
- **Whole thing at low opacity** (0.35 light / 0.5 dark). It's texture, not art.
- **Never interactive**: `pointer-events: none`, `aria-hidden="true"`, `contain: strict`
  so it can never trigger layout on the rest of the page.

Three animations, all cheap:

| Animation | What it does | Timing |
|---|---|---|
| **Dot load-in** | each dot fades + scales up from 0.4 | 0.5s, staggered ~0.08s apart |
| **Line draw-in** | each line draws itself between two dots that already exist | 0.9s, starts after both its endpoints |
| **Drift** | each connected *cluster* loops a tiny elliptical path via `transform` | 20–40s, infinite, desynced |

The one non-obvious rule: **drift animates the group, not individual dots.** A line
and both of its endpoints move together, so dots never slide off their lines.

Optional: a **focus wink** — when the page's main input (or hero CTA) is focused,
the whole field brightens slightly and one nominated dot tints to the accent colour.

---

## 2. What changes for the wordmark

In the app, dot positions are random (seeded from a project id) and lines connect
each dot to its *nearest neighbour*. For "FLYT" you replace both:

1. **Positions** come from sampling points evenly along letterform strokes.
2. **Lines** connect *consecutive points within a stroke* — not nearest neighbours.
   Nearest-neighbour would jump between letters and smear the word.

Each stroke becomes one connected cluster, so drift moves a stroke as a unit and
the letters stay legible while gently breathing.

Keep the dots sparse — roughly 40–60 total for four letters. Denser and it stops
looking like a constellation and starts looking like a dot-matrix printer.

---

## 3. Reference implementation (React + SVG)

Drop-in component. No dependencies.

```jsx
// FlytConstellation.jsx
import { useMemo } from 'react';

// Letterforms as stroke polylines on a 0–5 × 0–10 per-letter grid.
// Add a letter by adding an entry; `w` is its advance width.
const GLYPHS = {
  F: { w: 5, strokes: [[[0,0],[0,10]], [[0,0],[4.6,0]], [[0,4.8],[3.4,4.8]]] },
  L: { w: 5, strokes: [[[0,0],[0,10]], [[0,10],[4.6,10]]] },
  Y: { w: 5, strokes: [[[0,0],[2.5,5]], [[5,0],[2.5,5]], [[2.5,5],[2.5,10]]] },
  T: { w: 5, strokes: [[[0,0],[5,0]], [[2.5,0],[2.5,10]]] },
};

const WORD = 'FLYT';
const LETTER_GAP = 2.2;   // grid units between letters
const STEP = 2.0;         // target grid distance between dots along a stroke
const SCALE = 34;         // grid units -> SVG units
const PAD = 40;

function build(word) {
  // 1. Lay the glyphs out left to right.
  const strokes = [];
  let cursor = 0;
  for (const ch of word.toUpperCase()) {
    const g = GLYPHS[ch];
    if (!g) { cursor += 3; continue; }
    for (const s of g.strokes) strokes.push(s.map(([x, y]) => [x + cursor, y]));
    cursor += g.w + LETTER_GAP;
  }

  // 2. Sample dots evenly along each stroke; each stroke is one cluster.
  const nodes = [];
  const clusters = [];
  for (const [[x1, y1], [x2, y2]] of strokes) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(2, Math.round(len / STEP) + 1);
    const cluster = { nodes: [], edges: [] };
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const idx = nodes.length;
      nodes.push({
        x: PAD + (x1 + (x2 - x1) * t) * SCALE,
        y: PAD + (y1 + (y2 - y1) * t) * SCALE,
        r: 2.6 + ((idx * 37) % 7) / 4,     // deterministic size jitter, 2.6–4.1
      });
      cluster.nodes.push(idx);
      if (i > 0) cluster.edges.push([idx - 1, idx]);
    }
    clusters.push(cluster);
  }

  // 3. Merge dots that landed on top of each other (stroke junctions), so
  //    corners read as one star rather than a blob.
  const MERGE = (STEP * SCALE) * 0.45;
  const alias = nodes.map((_, i) => i);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < i; j++) {
      if (alias[j] !== j) continue;
      if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) < MERGE) {
        alias[i] = j; break;
      }
    }
  }
  for (const c of clusters) {
    c.nodes = [...new Set(c.nodes.map(i => alias[i]))];
    c.edges = c.edges.map(([a, b]) => [alias[a], alias[b]]).filter(([a, b]) => a !== b);
  }

  // 4. Stagger: dots pop in left to right, lines follow their endpoints.
  const order = [...nodes.keys()].sort((a, b) => nodes[a].x - nodes[b].x);
  order.forEach((idx, k) => { nodes[idx].in = 0.045 * k; });
  clusters.forEach((c, ci) => {
    c.dur = 22 + ((ci * 7) % 16);        // 22–37s, desynced per stroke
    c.delay = -((ci * 11) % 40);
    c.edges.forEach(e => { e.in = 0.35 + Math.max(nodes[e[0]].in, nodes[e[1]].in); });
  });

  const width = PAD * 2 + (cursor - LETTER_GAP) * SCALE;
  const height = PAD * 2 + 10 * SCALE;
  return { nodes, clusters, width, height };
}

export default function FlytConstellation({ word = WORD }) {
  const { nodes, clusters, width, height } = useMemo(() => build(word), [word]);
  return (
    <svg
      className="constellation"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
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
```

> **`preserveAspectRatio` note.** The app uses `slice` (fill the pane, crop the
> overflow) because the field is abstract texture. For a wordmark use `meet` so the
> whole word always fits. If you'd rather it bleed edge to edge, keep `slice` and
> accept that the outer letters can crop on narrow viewports.

---

## 4. The CSS

```css
.constellation {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
  contain: strict;
  opacity: 0.35;
}
[data-theme="dark"] .constellation { opacity: 0.5; }

/* Drift: one elliptical loop per stroke, desynced by inline duration/delay.
   Compositor-only (transform), so an idle page costs ~0% CPU. */
.constellation-cluster {
  animation-name: constellation-drift;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  will-change: transform;
}

.constellation-lines line {
  stroke: var(--divider, rgba(0,0,0,.18));
  stroke-width: 1;
  stroke-dasharray: 1;              /* with pathLength="1": one dash = whole line */
  animation: constellation-line-in .9s ease-out backwards;
}

.constellation-dots circle {
  fill: var(--faint, rgba(0,0,0,.42));
  transform-box: fill-box;
  transform-origin: center;
  animation: constellation-dot-in .5s ease-out backwards;
}

/* Optional focus wink: field brightens when the hero input is focused. */
.hero:focus-within .constellation {
  opacity: 0.44;
  transition: opacity .5s ease;
}

@keyframes constellation-drift {
  0%   { transform: translate(0, 0); }
  25%  { transform: translate(7px, 4px); }
  50%  { transform: translate(2px, 9px); }
  75%  { transform: translate(-6px, 4px); }
  100% { transform: translate(0, 0); }
}
@keyframes constellation-dot-in {
  from { opacity: 0; transform: scale(.4); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes constellation-line-in {
  from { stroke-dashoffset: 1; }
  to   { stroke-dashoffset: 0; }
}

/* Reduced motion: the wordmark still does its job, dead still. */
@media (prefers-reduced-motion: reduce) {
  .constellation-cluster,
  .constellation-dots circle,
  .constellation-lines line { animation: none; }
}
```

Parent must be `position: relative`, and page content needs `position: relative; z-index: 1`
so it sits above the field.

```jsx
<section className="hero" style={{ position: 'relative' }}>
  <FlytConstellation />
  <div style={{ position: 'relative', zIndex: 1 }}>
    <h1>Flyt</h1>
    …
  </div>
</section>
```

---

## 5. Tuning knobs

| Knob | Effect |
|---|---|
| `STEP` | dot density along strokes. Lower = denser, more literal wordmark. 1.6–2.6 is the useful range. |
| `SCALE` | overall size in SVG units. Doesn't change appearance — `viewBox` scales it. |
| `LETTER_GAP` | letter spacing. Raise it and the word reads as four separate constellations. |
| `.constellation { opacity }` | the single biggest lever on how "present" it feels. Below 0.3 it's subliminal; above 0.5 it competes with your copy. |
| drift `dur` range | 22–37s is a slow breathe. Under ~12s it starts to read as motion rather than life. |
| stroke-width / dot `r` | keep the line noticeably lighter than the dots — the dots are the word, the lines are the connective tissue. |

---

## 6. Rules to keep

These are the constraints that make the original feel calm rather than gimmicky —
worth passing on verbatim:

1. **Never above ~0.5 opacity.** It's behind the content, always.
2. **Zero interaction.** `pointer-events: none` and `aria-hidden="true"`, no exceptions.
3. **Transform-only animation.** No animating `top`/`left`/`width` — an idle page
   should cost nothing.
4. **`contain: strict`** on the SVG so it can never cause layout work elsewhere.
5. **Honour `prefers-reduced-motion`** by killing all three animations, not by
   hiding the graphic.
6. **Deterministic, not random.** Same input, same picture, every load.
