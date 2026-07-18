// Run sigil — a deterministic "burst" glyph for a run id: 8–14 evenly spaced
// radial ticks at seeded inner/outer radii, some dot-tipped. The length pattern
// is a visual barcode of the id, so a run becomes recognizable at a glance in
// the list, the run header, and (later) the deck cards.
//
// Ported from the "burst" variant (sigil-v4.html, variant I). Pure and
// deterministic: sigil(id, size) always returns the same SVG string for the
// same inputs, across restarts. Colour is `currentColor` only — the mark
// inherits whatever colour its context sets, so it needs no theme awareness of
// its own; the identity is entirely in the geometry, not the hue.

// FNV-1a: a stable string hash (same bytes → same number, every run).
function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// A tiny deterministic PRNG seeded from the hash; identical sequence per seed.
function rng(seed) {
  return () => {
    seed = Math.imul(seed ^ (seed >>> 15), seed | 1);
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61);
    return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296;
  };
}

export function sigil(id, size = 26) {
  const s = size;
  const r = rng(hash(id));
  const c = s / 2, k = s / 26;
  // The gradient id MUST be unique per sigil: duplicate <defs> ids across list
  // rows are silently deduped by the browser, which breaks the gradient. Suffix
  // it with the id's hash so every distinct run gets its own.
  const gid = 'sg' + hash(id).toString(36);

  // Fewer, chunkier rays at small sizes so the burst reads instead of muddies.
  const maxExtra = s <= 22 ? 4 : 6;             // 8–12 small, 8–14 otherwise
  const n = 8 + Math.floor(r() * (maxExtra + 1));
  const off = r() * Math.PI * 2;

  let rays = '', dots = '';
  for (let i = 0; i < n; i++) {
    const a = off + (i / n) * Math.PI * 2;
    const r0 = s * (0.10 + r() * 0.10);         // inner radius
    const r1 = s * (0.24 + r() * 0.20);         // outer radius (the "barcode")
    const x0 = c + Math.cos(a) * r0, y0 = c + Math.sin(a) * r0;
    const x1 = c + Math.cos(a) * r1, y1 = c + Math.sin(a) * r1;
    rays += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`;
    if (r() < 0.3) {
      dots += `<circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="${(1.1 * k).toFixed(1)}" fill="currentColor"/>`;
    }
  }
  const ang = (r() * 360).toFixed(0);

  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" class="sigil" aria-hidden="true">`
    + `<defs><linearGradient id="${gid}" gradientTransform="rotate(${ang} .5 .5)">`
    + `<stop offset="0" stop-color="currentColor"/>`
    + `<stop offset="1" stop-color="currentColor" stop-opacity="0.35"/>`
    + `</linearGradient></defs>`
    + `<g stroke="url(#${gid})" stroke-width="${(1.2 * k).toFixed(1)}" stroke-linecap="round">${rays}</g>`
    + `${dots}<circle cx="${c}" cy="${c}" r="${(1.7 * k).toFixed(1)}" fill="currentColor"/></svg>`;
}
