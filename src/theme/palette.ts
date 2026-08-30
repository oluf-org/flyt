/**
 * Single source of truth for project theme color math and the shared theme
 * contract.
 *
 * Pure module: no I/O, no DOM, no persistence. Downstream layers import from
 * here — `themeStore` persists `ThemeConfig`, `ThemeProvider` resolves
 * `generateShades()` and applies `CSS_VAR_CONTRACT` to the document root, and
 * settings UI renders swatches — none of them need to know how the HSL math
 * works.
 */

/** Saturation (%) shared by every shade, so all hues read as one family. */
const SHADE_SATURATION = 70;

/** Lightness (%) per shade tier, lightest to darkest accent. */
const SHADE_LIGHTNESS = { light: 45, medium: 35, dark: 25 } as const;

/** The three darkness levels of one project theme, as CSS-ready HSL strings. */
export interface ThemeShades {
  light: string;
  medium: string;
  dark: string;
}

/**
 * Per-project theme config as persisted by the theme store.
 *
 * - `baseHue` — the hue in effect right now: the user's custom hue when
 *   `isCustom`, otherwise `autoHue`.
 * - `autoHue` — the hue originally auto-assigned to the project, preserved
 *   even after a custom override so "reset to auto" can restore it.
 * - `isCustom` — true once the user has overridden the hue via the picker.
 * - `updatedAt` — epoch milliseconds of the last change.
 */
export interface ThemeConfig {
  baseHue: number;
  autoHue: number;
  isCustom: boolean;
  updatedAt: number;
}

/**
 * The 9 template hues in degrees: red, orange, yellow, green, teal, blue,
 * indigo, purple, pink. New projects are auto-assigned one of these that no
 * other project currently uses.
 */
export const BASE_HUES = Object.freeze([0, 30, 55, 110, 170, 215, 255, 285, 330] as const);

/**
 * Derive a project's three shades from a hue in degrees. Works for any hue —
 * a `BASE_HUES` template degree or an arbitrary custom hue from the color
 * picker. Degrees are rounded, then folded into [0, 360), so 360, negative
 * and fractional picker values all land on a clean degree; non-finite input
 * falls back to hue 0 rather than ever emitting an invalid CSS color.
 */
export function generateShades(hue: number): ThemeShades {
  const h = ((Math.round(Number.isFinite(hue) ? hue : 0) % 360) + 360) % 360;
  const s = SHADE_SATURATION;
  return {
    light: `hsl(${h}, ${s}%, ${SHADE_LIGHTNESS.light}%)`,
    medium: `hsl(${h}, ${s}%, ${SHADE_LIGHTNESS.medium}%)`,
    dark: `hsl(${h}, ${s}%, ${SHADE_LIGHTNESS.dark}%)`,
  };
}

/**
 * The CSS variable contract: maps each variable components consume via
 * `var(--theme-*)` to the `ThemeShades` key that fills it. `ThemeProvider`
 * iterates this to set the variables on the document root; components never
 * hardcode a color.
 */
export const CSS_VAR_CONTRACT = Object.freeze({
  "--theme-accent": "medium",
  "--theme-accent-light": "light",
  "--theme-accent-dark": "dark",
} as const) satisfies Readonly<Record<`--theme-${string}`, keyof ThemeShades>>;
