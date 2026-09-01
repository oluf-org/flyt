import test from "node:test";
import assert from "node:assert/strict";

import {
  PRESET_PROJECT_COLORS,
  SHADE_LIGHTNESS_RATIO,
  BG_TINT_ALPHA,
  PROJECT_THEME_CSS_VARS,
  normalizeHexColor,
  isPresetColor,
  deriveProjectTheme,
  projectThemeCssVars,
  pickProjectColorHex,
} from "../src/lib/projectTheme.js";

/** Parse a `hsl(H S% L%)` shade string back into its components. */
function parseShade(shade) {
  const m = shade.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/);
  assert.ok(m, `shade is a plain hsl() triple: ${shade}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

/** hsl (deg/%/%) -> {r,g,b} in 0..1, standard CSS math. */
function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0), g: f(8), b: f(4) };
}

/** WCAG 2 relative luminance of an {r,g,b} in 0..1. */
function luminance({ r, g, b }) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two {r,g,b} colors. */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composite a `hsl(H S% L% / A)` veil over an opaque {r,g,b} surface. */
function compositeTintOver(tint, surface) {
  const m = tint.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)% \/ ([\d.]+)\)$/);
  assert.ok(m, `bgTint is an hsl() veil with alpha: ${tint}`);
  const rgb = hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
  const alpha = Number(m[4]);
  return {
    r: rgb.r * alpha + surface.r * (1 - alpha),
    g: rgb.g * alpha + surface.g * (1 - alpha),
    b: rgb.b * alpha + surface.b * (1 - alpha),
  };
}

const hexToRgb = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255,
  b: parseInt(hex.slice(5, 7), 16) / 255,
});

// The surfaces the veil actually composites over, from src/styles.css:
// --canvas and --tx, light and dark themes.
const CANVAS_LIGHT = hexToRgb("#f8faf9");
const CANVAS_DARK = hexToRgb("#0e1310");
const TX_LIGHT = hexToRgb("#1e2623");
const TX_DARK = hexToRgb("#e3ebe6");

test("the template is 9 unique, valid, named preset colors", () => {
  assert.equal(PRESET_PROJECT_COLORS.length, 9);
  const hexes = new Set();
  const names = new Set();
  for (const preset of PRESET_PROJECT_COLORS) {
    assert.match(preset.hex, /^#[0-9a-f]{6}$/, `${preset.name} hex is #rrggbb`);
    assert.equal(normalizeHexColor(preset.hex), preset.hex);
    hexes.add(preset.hex);
    names.add(preset.name);
    assert.equal(isPresetColor(preset.hex), true, `${preset.name} is recognized as a preset`);
  }
  assert.equal(hexes.size, 9, "preset hexes are unique");
  assert.equal(names.size, 9, "preset names are unique");
  assert.equal(isPresetColor("#000000"), false, "non-preset colors are not presets");
});

test("every preset derives 3 shades, each strictly darker and clearly distinct", () => {
  for (const preset of PRESET_PROJECT_COLORS) {
    const { hsl, shades } = deriveProjectTheme(preset.hex);
    const base = hsl.l;
    let previous = base;
    for (const shade of shades) {
      const { h, s, l } = parseShade(shade);
      assert.equal(h, hsl.h, `${preset.name}: shade keeps the base hue`);
      assert.equal(s, hsl.s, `${preset.name}: shade keeps the base saturation`);
      assert.ok(l < previous - 3, `${preset.name}: ${shade} is visibly darker than the tier above (${previous} -> ${l})`);
      previous = l;
    }
  }
});

test("an arbitrary custom color takes the identical path as a preset", () => {
  const custom = deriveProjectTheme("#22d3ee");
  const preset = deriveProjectTheme("#3e7fd4");
  assert.deepEqual(Object.keys(custom).sort(), Object.keys(preset).sort());
  assert.deepEqual(Object.keys(custom.hsl), ["h", "s", "l"]);
  assert.equal(custom.shades.length, 3);
  assert.ok(Object.isFrozen(custom), "derived theme is frozen");

  let previous = custom.hsl.l;
  for (const shade of custom.shades) {
    const l = parseShade(shade).l;
    assert.ok(l < previous - 3, `custom cyan darkens visibly: ${previous} -> ${l}`);
    previous = l;
  }
});

test("custom colors across hue, saturation and darkness all derive coherent ladders", () => {
  const cases = [
    ["#f97316", "orange", 60], // bright warm
    ["#7c3aed", "violet", 40], // mid cool
    ["#2a2a2a", "near-black", 4], // floor of the scale: still strictly darker
    ["#eab308", "low-contrast yellow", 60],
    ["#0ea5e9", "sky", 55],
    ["#b91c1c", "deep red", 40],
  ];
  for (const [hex, label, minStep] of cases) {
    const theme = deriveProjectTheme(hex);
    let previous = theme.hsl.l;
    for (const shade of theme.shades) {
      const l = parseShade(shade).l;
      assert.ok(l < previous, `${label}: ${shade} is strictly darker than ${previous}`);
      assert.ok(previous - l >= Math.min(minStep, 1), `${label}: step never collapses to zero`);
      previous = l;
    }
  }
});

test("normalization accepts the formats a picker produces and rejects the rest", () => {
  assert.equal(normalizeHexColor("#DC4A3A"), "#dc4a3a");
  assert.equal(normalizeHexColor("dc4a3a"), "#dc4a3a");
  assert.equal(normalizeHexColor("#f00"), "#ff0000");
  assert.equal(normalizeHexColor("  #AbCdEf  "), "#abcdef");
  for (const junk of ["", "#1234", "#12345", "rgb(0,0,0)", "rgba(0,0,0,1)", "hsl(0 0% 0%)", "red", "#dc4a3a;", "#dc4a3", null, undefined, 42]) {
    assert.equal(normalizeHexColor(junk), null, `rejects ${String(junk)}`);
  }
  assert.equal(deriveProjectTheme("#DC4A3A").hex, deriveProjectTheme("#dc4a3a").hex, "case-insensitive");
});

test("deriveProjectTheme throws on input that cannot be a color", () => {
  for (const bad of ["nope", "", "#zzzzzz", null, undefined, 123, {}]) {
    assert.throws(() => deriveProjectTheme(bad), TypeError, `throws for ${String(bad)}`);
  }
});

test("the background tint stays subtle: normal text keeps WCAG AA over it, both themes", () => {
  assert.ok(BG_TINT_ALPHA > 0 && BG_TINT_ALPHA <= 0.1, `tint alpha ${BG_TINT_ALPHA} is a veil, not a fill`);
  const bases = [
    ...PRESET_PROJECT_COLORS.map((p) => p.hex),
    "#22d3ee",
    "#7c3aed",
  ];
  for (const hex of bases) {
    const { bgTint } = deriveProjectTheme(hex);
    const light = contrast(TX_LIGHT, compositeTintOver(bgTint, CANVAS_LIGHT));
    const dark = contrast(TX_DARK, compositeTintOver(bgTint, CANVAS_DARK));
    assert.ok(light >= 4.5, `${hex} on light canvas: contrast ${light.toFixed(2)} >= 4.5`);
    assert.ok(dark >= 4.5, `${hex} on dark canvas: contrast ${dark.toFixed(2)} >= 4.5`);
  }
});

test("shades stay the base family and darken monotonically toward black", () => {
  // The ladder is geometric, so it never clamps: even a dark base keeps
  // strictly decreasing tiers.
  const theme = deriveProjectTheme("#2a2a2a");
  const levels = theme.shades.map((s) => parseShade(s).l);
  assert.deepEqual(levels, [...levels].sort((a, b) => b - a), "levels decrease monotonically");
  assert.equal(new Set(theme.shades).size, 3, "the three shades are distinct");
  assert.ok(new Set(levels).size === 3);
});

test("the CSS variable contract covers accent, three shades and the background tint", () => {
  assert.deepEqual(Object.keys(PROJECT_THEME_CSS_VARS), ["color", "shade1", "shade2", "shade3", "bgTint"]);
  for (const name of Object.values(PROJECT_THEME_CSS_VARS)) {
    assert.match(name, /^--project-[a-z0-9-]+$/, `${name} is a --project-* custom property`);
  }
  const theme = deriveProjectTheme("#3e7fd4");
  assert.deepEqual(projectThemeCssVars(theme), {
    [PROJECT_THEME_CSS_VARS.color]: theme.hex,
    [PROJECT_THEME_CSS_VARS.shade1]: theme.shades[0],
    [PROJECT_THEME_CSS_VARS.shade2]: theme.shades[1],
    [PROJECT_THEME_CSS_VARS.shade3]: theme.shades[2],
    [PROJECT_THEME_CSS_VARS.bgTint]: theme.bgTint,
  });
});

test("auto-assignment avoids presets already in use when any remain", () => {
  const used = PRESET_PROJECT_COLORS.slice(0, 8).map((p) => p.hex);
  // Mixed formats and junk entries in the used list must not matter.
  const noisyUsed = [...used, "#3E7FD4", "blue", "not-a-color"];
  const missing = PRESET_PROJECT_COLORS[8].hex;
  assert.equal(pickProjectColorHex(noisyUsed), missing, "the only unused preset is the one picked");
  assert.equal(
    pickProjectColorHex(used.map((hex) => hex.toUpperCase()).concat("teal-ish")),
    missing,
    "used entries are matched after normalization",
  );
});

test("auto-assignment falls back to the full template when all presets are taken", () => {
  const all = PRESET_PROJECT_COLORS.map((p) => p.hex);
  const picked = pickProjectColorHex(all);
  assert.ok(PRESET_PROJECT_COLORS.some((p) => p.hex === picked), "still returns a template color");
});

test("auto-assignment is deterministic under an injected rng", () => {
  const presets = PRESET_PROJECT_COLORS.map((p) => p.hex);
  assert.equal(pickProjectColorHex([], () => 0), presets[0], "rng 0 -> first unused preset");
  assert.equal(pickProjectColorHex([], () => 0.9999), presets[8], "rng ~1 -> last unused preset");
  assert.equal(pickProjectColorHex(presets, () => 0), presets[0], "exhausted pool draws from the full template");
  // Uniform draw from the unused pool, not the whole template.
  const used = presets.slice(1);
  assert.equal(pickProjectColorHex(used, () => 0), presets[0]);
});

test("the module exposes everything a downstream layer needs", async () => {
  const mod = await import("../src/lib/projectTheme.js");
  for (const name of [
    "PRESET_PROJECT_COLORS",
    "SHADE_LIGHTNESS_RATIO",
    "BG_TINT_ALPHA",
    "PROJECT_THEME_CSS_VARS",
    "normalizeHexColor",
    "isPresetColor",
    "deriveProjectTheme",
    "projectThemeCssVars",
    "pickProjectColorHex",
  ]) {
    assert.ok(mod[name] !== undefined, `exports ${name}`);
  }
  assert.equal(typeof mod.deriveProjectTheme, "function");
  assert.equal(typeof mod.pickProjectColorHex, "function");
  assert.ok(Object.isFrozen(mod.PRESET_PROJECT_COLORS), "preset template is frozen");
  assert.ok(Object.isFrozen(mod.PROJECT_THEME_CSS_VARS), "var contract is frozen");
});
