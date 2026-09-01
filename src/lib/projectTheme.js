/**
 * Single source of truth for per-project theme color math and the CSS
 * variable contract that applies it.
 *
 * Pure module: no I/O, no DOM, no persistence. Downstream layers import from
 * here and never reimplement the color math:
 *
 * - the project record / settings store persists `hex` (the user's chosen or
 *   auto-assigned color) and calls `pickProjectColorHex()` when a new project
 *   has no color yet;
 * - the settings screen renders `PRESET_PROJECT_COLORS` as swatches and feeds
 *   the picker's value straight into `deriveProjectTheme()`, so presets and
 *   custom colors are one code path;
 * - the theme provider calls `projectThemeCssVars()` and writes the result
 *   onto `document.documentElement.style` (or a project-scoped root), which
 *   is the repo's existing mechanism: CSS custom properties consumed by
 *   `src/styles.css` tokens and components.
 *
 * Supersedes the partial `src/theme/palette.ts` (hue-seeded, `--theme-accent*`,
 * no consumers — commit 61e69b9). Audit of that partial work and the reasons
 * for each replacement live in `.flyt/backlog/project-color-plan.md`.
 */

/**
 * The 9 template colors, spanning the hue wheel at a mid lightness so every
 * preset reads as an accent on both light and dark surfaces and every one
 * derives three visibly darker shades. Order is the template order; new
 * projects are auto-assigned one of these that no other project currently
 * uses. The settings swatch row renders exactly this array.
 */
export const PRESET_PROJECT_COLORS = Object.freeze(
  [
    { name: "Red", hex: "#dc4a3a" },
    { name: "Orange", hex: "#e0782a" },
    { name: "Amber", hex: "#d3a32b" },
    { name: "Green", hex: "#52b23f" },
    { name: "Teal", hex: "#35b0a6" },
    { name: "Blue", hex: "#3e7fd4" },
    { name: "Indigo", hex: "#6a5acd" },
    { name: "Purple", hex: "#a855c8" },
    { name: "Pink", hex: "#d65596" },
  ].map(Object.freeze),
);

/**
 * Each shade's lightness as a ratio of the previous tier's lightness, in HSL.
 * Geometric rather than arithmetic steps so the ladder stays strictly
 * decreasing and visibly distinct for ANY base — a near-black custom color
 * still darkens (approaching black asymptotically) instead of clamping three
 * shades onto the same value. 0.8 puts the preset band (lightness 44-60) at
 * roughly 9-11 lightness points per step, the same feel as a 500/600/700/800
 * accent ramp.
 */
export const SHADE_LIGHTNESS_RATIO = 0.8;

/**
 * Alpha of the background-tint veil. The tint is emitted as a translucent
 * layer of the project color that surfaces composite over their own
 * background (`color-mix`, a stacked background, or plain alpha blending all
 * work), which keeps it subtle on both the light and dark themes without the
 * module knowing their surface colors. Kept at or below 0.1 so normal text
 * over a tinted surface keeps a wide WCAG AA margin.
 */
export const BG_TINT_ALPHA = 0.08;

/**
 * The CSS custom property naming contract. `projectThemeCssVars()` maps a
 * derived theme onto exactly these names; `src/styles.css` and components
 * consume them via `var(--project-color)` etc. and never hardcode a project
 * color.
 *
 * - `--project-color` — the base accent (top bar, sidebar, primary buttons).
 * - `--project-color-shade-1..3` — progressively darker accents (links,
 *   hover/active states, borders); shade 3 is the darkest.
 * - `--project-bg-tint` — translucent veil of the project color for the page
 *   background (composite over `--canvas`; do not use opaquely).
 */
export const PROJECT_THEME_CSS_VARS = Object.freeze({
  color: "--project-color",
  shade1: "--project-color-shade-1",
  shade2: "--project-color-shade-2",
  shade3: "--project-color-shade-3",
  bgTint: "--project-bg-tint",
});

/**
 * Normalize any hex-ish color string to lowercase `#rrggbb`.
 * Accepts `#rgb`, `#rrggbb`, any case, with or without the leading `#`.
 * Returns `null` for anything else (rgba, hsl, named colors, junk) — callers
 * decide whether that is an error or a "no color set".
 */
export function normalizeHexColor(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  let hex = match[1].toLowerCase();
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return "#" + hex;
}

/** True when `value` normalizes to one of the 9 template colors. */
export function isPresetColor(value) {
  const hex = normalizeHexColor(value);
  return hex != null && PRESET_PROJECT_COLORS.some((preset) => preset.hex === hex);
}

/**
 * Derive a full project theme from ANY base color — a template preset or an
 * arbitrary custom picker value take the identical path.
 *
 * Returns a frozen object:
 * - `hex` — the normalized base color; the value of `--project-color`.
 * - `hsl` — the parsed base as `{ h, s, l }` (degrees / %, rounded to 0.1)
 *   for consumers that need the components.
 * - `shades` — three CSS colors, progressively darker accents, darkest last;
 *   the values of `--project-color-shade-1..3`. Same hue and saturation as
 *   the base (they read as the same family), lightness stepped down by
 *   `SHADE_LIGHTNESS_RATIO` per tier.
 * - `bgTint` — a translucent layer of the project color; the value of
 *   `--project-bg-tint`. Composite it over a surface color; never use it
 *   opaquely.
 *
 * Throws a TypeError on input that does not normalize to a hex color, rather
 * than silently emitting an invalid CSS color.
 */
export function deriveProjectTheme(baseColorHex) {
  const hex = normalizeHexColor(baseColorHex);
  if (!hex) {
    throw new TypeError(
      `deriveProjectTheme: expected a hex color like "#dc4a3a", got ${JSON.stringify(baseColorHex)}`,
    );
  }
  const { h, s, l } = hexToHsl(hex);
  const round1 = (n) => Math.round(n * 10) / 10;
  const hh = round1(h);
  const ss = round1(s);
  const shades = [1, 2, 3].map((tier) => {
    const lightness = round1(l * Math.pow(SHADE_LIGHTNESS_RATIO, tier));
    return `hsl(${hh} ${ss}% ${lightness}%)`;
  });
  return Object.freeze({
    hex,
    hsl: Object.freeze({ h: hh, s: ss, l: round1(l) }),
    shades: Object.freeze(shades),
    bgTint: `hsl(${hh} ${ss}% ${round1(l)}% / ${BG_TINT_ALPHA})`,
  });
}

/**
 * Map a derived theme onto the CSS custom property contract — the exact
 * object a theme provider writes onto an element style
 * (`Object.entries(vars).forEach(([name, value]) => root.style.setProperty(name, value))`).
 */
export function projectThemeCssVars(theme) {
  return {
    [PROJECT_THEME_CSS_VARS.color]: theme.hex,
    [PROJECT_THEME_CSS_VARS.shade1]: theme.shades[0],
    [PROJECT_THEME_CSS_VARS.shade2]: theme.shades[1],
    [PROJECT_THEME_CSS_VARS.shade3]: theme.shades[2],
    [PROJECT_THEME_CSS_VARS.bgTint]: theme.bgTint,
  };
}

/**
 * Auto-assign a preset color to a project, avoiding presets already in use by
 * other projects when possible. `usedHexes` are the colors of the projects
 * that already exist (any format `normalizeHexColor` accepts; garbage entries
 * are ignored). Draws uniformly from the unused presets; falls back to the
 * full template when all 9 are taken. `rng` is injectable for deterministic
 * tests; defaults to `Math.random`. Returns the preset hex to persist on the
 * project record.
 */
export function pickProjectColorHex(usedHexes = [], rng = Math.random) {
  const used = new Set(
    (Array.isArray(usedHexes) ? usedHexes : [])
      .map((value) => normalizeHexColor(value))
      .filter(Boolean),
  );
  const unused = PRESET_PROJECT_COLORS.filter((preset) => !used.has(preset.hex));
  const pool = unused.length > 0 ? unused : PRESET_PROJECT_COLORS;
  return pool[Math.floor(rng() * pool.length) % pool.length].hex;
}

/** Hex (`#rrggbb`) to `{ h, s, l }` in degrees / percent. Internal. */
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 }; // achromatic: hue 0
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}
