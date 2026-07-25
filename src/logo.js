// The Flyt mark (D29) — the canonical, non-random member of the sigil family.
//
// `sigil.js` draws a seeded burst: evenly spaced rays at random radii from a
// solid centre, some dot-tipped. Those are noise — a barcode of a run id. This
// is the same alphabet saying something on purpose: eleven rays at a fixed 30°
// step over a 300° arc, lengths ramping monotonically from short to long, with
// the 60° gap sitting at the bottom so the shortest and longest rays flank it
// and the ramp is visible at a glance. Nothing here is seeded; logoMark(size)
// is a pure function of size alone.
//
// `currentColor` only, exactly like sigil() — the mark inherits its context's
// colour, so it themes for free and needs no light/dark variant. The one place
// that cannot apply is the packaged app icon, which has to bake a colour in;
// scripts/make-icons.mjs does that from this same geometry (see below).
//
// Anti-ideas (D26): flat, single-colour, geometric. No gradient, no shadow, no
// animated variant. sigil() uses a gradient for its barcode read; the logo
// deliberately does not — a logo that fades is a logo that disappears on the
// wrong background.

const START_DEG = 120;       // lower-left; sweeps clockwise over the top,
                             // leaving the missing 60° at the bottom

// Two cadences over the same 300° arc (count × step, both below). The full mark is 11 rays at a 30° step
// (the 60° gap is exactly two missing steps, so it reads as deliberate rather
// than arbitrary). Below ~20px those rays land less than a pixel apart near the
// centre and the mark silts up into a blob, so favicon/tray sizes drop to 6 at
// 60° — same arc, same ramp, same silhouette, half the detail. This is an
// optical variant of one logo, not a second logo: the two are indistinguishable
// at the sizes where they overlap.
const CADENCE_FULL = { count: 11, step: 30 };
const CADENCE_SMALL = { count: 6, step: 60 };
const SMALL_MAX = 20;

function cadenceFor(size) { return size <= SMALL_MAX ? CADENCE_SMALL : CADENCE_FULL; }

// Radii as fractions of the box. The inner radius is held well outside the
// centre dot so no ray ever disappears into it, and the outer ramp tops out at
// 0.40 so a 1024px icon still keeps ~7% breathing room after the round cap.
const R_INNER = 0.12;
const R_OUTER_MIN = 0.24;
const R_OUTER_MAX = 0.44;

const STROKE_K = 1.45;       // × (size / 26), the scale sigil() established
const TIP_DOT_K = 1.25;
const CENTRE_DOT_K = 1.85;
// Dot-tipped at intervals, like sigil() — but on a fixed cadence rather than a
// seeded one. Every third ray, ending on the longest: four dots spread across
// the arc. Dotting the two longest instead (the obvious choice) puts both bulbs
// side by side at the wide end and the mark grows antennae.
const DOT_EVERY = 3;

// The geometry, in pixels, for a `size`×`size` box. Exported so the icon
// rasterizer (scripts/make-icons.mjs) draws from exactly the same numbers the
// SVG does — two renderers, one source of truth, no chance of drift.
export function logoGeometry(size = 26) {
  const s = size;
  const c = s / 2;
  const k = s / 26;
  const strokeWidth = STROKE_K * k;
  const { count, step } = cadenceFor(s);
  const dotPhase = (count - 1) % DOT_EVERY;   // always includes the longest ray
  const rays = [];
  const dots = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const a = (START_DEG + i * step) * Math.PI / 180;
    const r0 = s * R_INNER;
    const r1 = s * (R_OUTER_MIN + (R_OUTER_MAX - R_OUTER_MIN) * t);
    const cos = Math.cos(a), sin = Math.sin(a);
    rays.push({ x0: c + cos * r0, y0: c + sin * r0, x1: c + cos * r1, y1: c + sin * r1 });
    if (i % DOT_EVERY === dotPhase) {
      dots.push({ x: c + cos * r1, y: c + sin * r1, r: TIP_DOT_K * k });
    }
  }
  const centre = { x: c, y: c, r: CENTRE_DOT_K * k };

  // Optical centring. A ramp is asymmetric by definition, so the ink's bounding
  // box does NOT sit on the geometric centre — left alone, the mark hangs
  // low-right in its box and every use of it looks like a mistake. Measure the
  // ink (strokes at half-width, dots at radius) and translate the whole thing so
  // the box is balanced. The centre dot moves with it: the anchor is the mark's
  // centre, not the viewBox's.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y, r) => {
    if (x - r < minX) minX = x - r;
    if (y - r < minY) minY = y - r;
    if (x + r > maxX) maxX = x + r;
    if (y + r > maxY) maxY = y + r;
  };
  const half = strokeWidth / 2;
  for (const r of rays) { grow(r.x0, r.y0, half); grow(r.x1, r.y1, half); }
  for (const d of dots) grow(d.x, d.y, d.r);
  grow(centre.x, centre.y, centre.r);
  const dx = c - (minX + maxX) / 2;
  const dy = c - (minY + maxY) / 2;
  for (const r of rays) { r.x0 += dx; r.x1 += dx; r.y0 += dy; r.y1 += dy; }
  for (const d of dots) { d.x += dx; d.y += dy; }
  centre.x += dx; centre.y += dy;

  return { size: s, rays, dots, centre, strokeWidth };
}

// The mark as an SVG string, `currentColor` throughout.
// `title` gives it an accessible name; omit it (the default) for decorative
// uses where an adjacent wordmark already carries the name.
export function logoMark(size = 26, { title = null, className = 'logo-mark' } = {}) {
  const g = logoGeometry(size);
  const f = n => n.toFixed(2);
  const rays = g.rays
    .map(r => `<line x1="${f(r.x0)}" y1="${f(r.y0)}" x2="${f(r.x1)}" y2="${f(r.y1)}"/>`)
    .join('');
  const dots = g.dots
    .map(d => `<circle cx="${f(d.x)}" cy="${f(d.y)}" r="${f(d.r)}" fill="currentColor"/>`)
    .join('');
  const a11y = title
    ? `role="img" aria-label="${title}"`
    : 'aria-hidden="true"';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="${className}" ${a11y}>`
    + `<g stroke="currentColor" stroke-width="${f(g.strokeWidth)}" stroke-linecap="round">${rays}</g>`
    + `${dots}<circle cx="${f(g.centre.x)}" cy="${f(g.centre.y)}" r="${f(g.centre.r)}" fill="currentColor"/></svg>`;
}
