/**
 * Apply the active project's theme as CSS custom properties.
 *
 * The bridge between the project record and the pure color math in
 * `projectTheme.js`: read the color off the active project, derive the theme,
 * and write the `PROJECT_THEME_CSS_VARS` contract onto the document root.
 * `src/styles/project-theme.css` consumes the variables only for project
 * identity — the active-tab edge and the lander's mark/name — so a change
 * takes effect live without recoloring the application's page palette.
 *
 * Persistence of the color field is a separate concern (settings UI, project
 * creation). Until a record carries one, the DEFAULT_PROJECT_COLOR_HEX preset
 * stands in, so this layer works before persistence lands. Projectless (no
 * active record) is deliberately unthemed: `clearProjectTheme()` removes the
 * variables and the `PROJECT_THEME_ACTIVE_ATTR` switch, and every rule in the
 * theme sheet goes inert — non-project surfaces keep the stock palette.
 *
 * Scope: the variables are written on ONE document root. Each Electron window
 * has its own document, so every window themes its own active project, and
 * nothing outside the gated sheet reads the variables.
 */

import {
  PROJECT_THEME_CSS_VARS,
  PRESET_PROJECT_COLORS,
  deriveProjectTheme,
  normalizeHexColor,
  projectThemeCssVars,
} from './projectTheme.js';

/**
 * Project-record fields a color may arrive on. `colorHex` is the canonical
 * field the persistence layer is specified to write; `color` is accepted so a
 * record that already carries a differently-named color field themes without
 * a migration. Values go through `normalizeHexColor`, so `#ABC`, `abc`, and
 * `#a1b2c3` all work; junk reads as "no color set" and falls back.
 */
export const PROJECT_COLOR_FIELDS = Object.freeze(['colorHex', 'color']);

/**
 * The preset that stands in when the active project has no color yet — Blue,
 * so the default reads as a deliberate project color rather than an error.
 * Auto-assignment (avoiding presets already in use) belongs to project
 * creation/persistence and replaces this fallback as records gain colors.
 */
export const DEFAULT_PROJECT_COLOR_HEX =
  PRESET_PROJECT_COLORS.find((preset) => preset.name === 'Blue')?.hex ?? PRESET_PROJECT_COLORS[0].hex;

/**
 * Set on the document root while a project is active. The theme sheet's rules
 * are gated on it, so the theming exists only while a project is open — the
 * belt to the braces of the variables being cleared with it.
 */
export const PROJECT_THEME_ACTIVE_ATTR = 'data-project-theme';

/** The text/icon color ON a project fill (the active project tab). */
export const PROJECT_ON_ACCENT_VAR = '--project-on-accent';

/** The readable project-family color used by the lander's identity accents. */
export const PROJECT_ACCENT_VAR = '--project-accent';

/* Ink and white, the two candidates for text on a project fill. Ink is the
   dark half of the compiled palette's on-accent pair (styles.css light theme). */
const ON_FILL_INK = '#0b140f';

/* The canvas literals of both themes, from styles.css (the same pair the
   theme sheet copies into --pt-canvas-base). Accent contrast is measured
   against the canvas WITH the project tint composited, which is the surface
   links and chips actually sit on. */
const PT_CANVAS_BASE = Object.freeze({ light: '#f8faf9', dark: '#0e1310' });

/** WCAG relative luminance of a #rrggbb color. */
function relativeLuminance(hex) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colors. */
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The readable text/icon color for a project-colored fill: ink or white,
 * whichever contrasts more against the fill. On the mid-lightness presets
 * that is ink (the sheet's own fallback); a near-black custom flips to white.
 * The better candidate is always ≥ 3:1 — the crossover of the two ratios sits
 * above 4 — so no project color ends with unreadable controls.
 */
export function readableOnFillColor(fillHex) {
  const hex = normalizeHexColor(fillHex) ?? DEFAULT_PROJECT_COLOR_HEX;
  const whiteContrast = contrastRatio(hex, '#ffffff');
  const inkContrast = contrastRatio(hex, ON_FILL_INK);
  return whiteContrast >= inkContrast ? '#ffffff' : ON_FILL_INK;
}

/* Composite the theme's background-tint veil over an opaque #rrggbb surface
   (plain alpha blending, the same math the browser does for color-mix with a
   translucent operand). Returns #rrggbb. */
function tintedSurface(bgTint, surfaceHex) {
  const m = bgTint.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)% \/ ([\d.]+)\)$/);
  const alpha = m ? Number(m[4]) : 0;
  const to255 = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const veil = m ? hslToRgb255(Number(m[1]), Number(m[2]), Number(m[3])) : to255(surfaceHex);
  const base = to255(surfaceHex);
  return '#' + veil
    .map((c, i) => Math.round(c * alpha + base[i] * (1 - alpha)))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('');
}

/* hsl (deg/%/%) -> [r,g,b] 0..255, standard CSS math. */
function hslToRgb255(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((c) => Math.round(c * 255));
}

/* The accent candidates for TEXT in the project family: the raw base plus its
   three derived shades (darkest last), each as #rrggbb so the WCAG math can
   compare them. On light surfaces the darker members hold contrast that a
   bright base loses; on dark surfaces the raw base is usually the best a
   light-handed color can do. */
function hslShadeToHex(shade) {
  const m = shade.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/);
  if (!m) return normalizeHexColor(shade) ?? '#000000';
  const [r, g, b] = hslToRgb255(Number(m[1]), Number(m[2]), Number(m[3]));
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/**
 * The accent color for text set in the project family — links, the rail's
 * active destination, option chips — chosen per theme half so the same
 * project stays readable when the OS theme flips. From the base and its
 * three derived shades, the lightest candidate that still clears 3:1 (WCAG
 * for large text and UI strokes) against the tinted canvas wins, keeping the
 * accent as close to the user's color as readability allows; when no
 * candidate clears it (a near-black custom on dark canvas), the
 * highest-contrast one does — the best that can be done while still wearing
 * the color. The 3:1 floor matches the stock palette's own design: the sage
 * accent is 3.70:1 on light canvas and 8.31:1 on dark.
 * Returns `{ light, dark }` — one value per color-scheme half, written as
 * two custom properties by the applier and consumed via light-dark().
 */
export function readableProjectAccent(theme) {
  const candidates = [theme.hex, ...theme.shades.map(hslShadeToHex)];
  const pick = (mode) => {
    const surface = tintedSurface(theme.bgTint, PT_CANVAS_BASE[mode]);
    const ratios = candidates.map((hex) => ({ hex, ratio: contrastRatio(hex, surface) }));
    const passing = ratios.filter((c) => c.ratio >= 3);
    if (passing.length > 0) return passing[0].hex; // candidates are lightest-first
    return ratios.reduce((best, c) => (c.ratio > best.ratio ? c : best), ratios[0]).hex;
  };
  return { light: pick('light'), dark: pick('dark') };
}

/**
 * The color the active project record carries, or `null` when it carries
 * none (no record, no field, or a value that does not normalize to hex).
 */
export function activeProjectColorHex(project) {
  if (project == null || typeof project !== 'object') return null;
  for (const field of PROJECT_COLOR_FIELDS) {
    const hex = normalizeHexColor(project[field]);
    if (hex) return hex;
  }
  return null;
}

/**
 * Resolve the theme for the active project record:
 * - `hex` — the color in force (the record's own, or the default preset).
 * - `usedFallback` — true when the record carried no usable color, so the
 *   default preset decided; the persistence layer can log or migrate these.
 * - `theme` / `vars` — the derived theme and its CSS variable mapping, ready
 *   for `setProperty`. Pure: no DOM, no I/O.
 */
export function resolveProjectTheme(project) {
  const fromRecord = activeProjectColorHex(project);
  const hex = fromRecord ?? DEFAULT_PROJECT_COLOR_HEX;
  const theme = deriveProjectTheme(hex);
  return { hex, usedFallback: fromRecord == null, theme, vars: projectThemeCssVars(theme) };
}

/** The document when a DOM exists (tests and SSR pass one explicitly); `null` otherwise. */
function defaultDoc() {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Write the active project's theme variables onto the document root and turn
 * the sheet on. Idempotent — called again whenever the active project or its
 * color changes, which is what makes a color change land without a reload.
 * Returns the variable mapping it wrote (or would write, when no DOM is
 * available, as under SSR).
 */
export function applyProjectTheme(project, doc = defaultDoc()) {
  const { theme, vars } = resolveProjectTheme(project);
  const root = doc?.documentElement ?? null;
  if (root) {
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    root.style.setProperty(PROJECT_ON_ACCENT_VAR, readableOnFillColor(vars[PROJECT_THEME_CSS_VARS.color]));
    const accent = readableProjectAccent(theme);
    root.style.setProperty(`${PROJECT_ACCENT_VAR}-light`, accent.light);
    root.style.setProperty(`${PROJECT_ACCENT_VAR}-dark`, accent.dark);
    root.setAttribute(PROJECT_THEME_ACTIVE_ATTR, '');
  }
  return vars;
}

/**
 * Remove every project theme variable and the active switch from the document
 * root — the projectless state. Returns true when a root was found and cleared.
 */
export function clearProjectTheme(doc = defaultDoc()) {
  const root = doc?.documentElement ?? null;
  if (!root) return false;
  for (const name of [
    ...Object.values(PROJECT_THEME_CSS_VARS),
    PROJECT_ON_ACCENT_VAR,
    `${PROJECT_ACCENT_VAR}-light`,
    `${PROJECT_ACCENT_VAR}-dark`,
  ]) {
    root.style.removeProperty(name);
  }
  root.removeAttribute(PROJECT_THEME_ACTIVE_ATTR);
  return true;
}
