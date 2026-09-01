// ============================================================================
// src/lib/projectTheme.test.ts — UNIT SPEC for the pure color-math module
// ============================================================================
// TypeScript, colocated with the module it verifies (the nominal location).
// Like the .tsx settings section, Node 22.12's `node --test` cannot parse it
// and the repo ships no TS runner — so it is loaded (transpiled) through the
// same vite the app ships, by tests/projectThemeE2e.test.js, and every check
// runs as a gate-visible subtest. Checks are exported named functions
// (`check*`) rather than top-level test() registrations: tests registered
// during a module load are not collected by this runner.
//
// Scope: the derivation's OWN invariants, held independently of the wider
// suites (tests/projectTheme.test.js owns the export contract and template
// shape; e2e/project-theme.spec.ts owns the acceptance thresholds). Here:
// the HSL round-trip the applier depends on, the geometric ladder across the
// whole custom-color gamut, and the picker's contract.
// ============================================================================

import assert from 'node:assert/strict';

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
} from './projectTheme.js';

/** hsl (deg/%/%) -> [r,g,b] 0..255, standard CSS math (inverse of hexToHsl). */
function hslToRgb255(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((c) => Math.round(c * 255)) as [number, number, number];
}

/** The exact hex `hexToHsl` would parse back to this hsl triple (0.1-rounded). */
function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb255(h, s, l);
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** Parse a `hsl(H S% L%)` shade back into numbers. */
function parseShade(shade: string): { h: number; s: number; l: number } {
  const m = shade.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/);
  assert.ok(m, `a derived shade is a plain hsl() triple: ${shade}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

/** rgb 0..255 -> hsl (deg/%/%) — an INDEPENDENT implementation, so the
    module's parse can be checked against something that is not itself. */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

/** A spread of hexes across the picker's reachable gamut. */
const GAMUT: Array<{ h: number; s: number; l: number }> = [];
for (let h = 0; h < 360; h += 45) {
  for (const s of [20, 55, 90]) {
    for (const l of [15, 35, 55, 75]) GAMUT.push({ h, s, l });
  }
}

// --- the derivation, across the whole gamut --------------------------------

export function checkHslRoundTrip(): void {
  // Two claims, kept separate:
  //  1. INVERTIBILITY — the module's parse of a hex agrees with an independent
  //     rgbToHsl of the SAME hex to within the module's 0.1 rounding. This is
  //     what the applier's shade→hex→contrast path leans on.
  //  2. QUANTIZATION — an sRGB hex only stores the nominal color approximately:
  //     lightness/saturation to ~2.6 points, hue to ~(120/chroma)/255 degrees
  //     (dark, low-chroma colors quantize hue hardest; achromatic hue is
  //     meaningless). That is 8-bit hex physics, not the module's behavior.
  for (const { h, s, l } of GAMUT) {
    const hex = hslToHex(h, s, l);
    const rgb255 = hslToRgb255(h, s, l);
    const parsed = deriveProjectTheme(hex).hsl;
    const own = rgbToHsl(rgb255[0], rgb255[1], rgb255[2]);
    for (const key of ['h', 's', 'l'] as const) {
      assert.ok(
        Math.abs(parsed[key] - own[key]) <= 0.11,
        `${hex}: parsed ${key} ${parsed[key]} == independent parse ${own[key].toFixed(2)}`,
      );
    }
    const chroma = (Math.max(...rgb255) - Math.min(...rgb255)) / 255;
    const hueTolerance = chroma > 0 ? (120 / chroma) / 255 + 0.2 : 360;
    assert.ok(Math.abs(own.h - h) <= hueTolerance, `${hex}: hue within 8-bit quantization of ${h}`);
    assert.ok(Math.abs(own.s - s) <= 2.6, `${hex}: saturation within 8-bit quantization of ${s}`);
    assert.ok(Math.abs(own.l - l) <= 2.6, `${hex}: lightness within 8-bit quantization of ${l}`);
  }
}

export function checkLadderIsGeometric(): void {
  for (const { h, s, l } of GAMUT) {
    // Work from the hex the picker can actually produce, and from the HSL the
    // module round-trips (up to 8-bit quantization, see checkHslRoundTrip).
    const hex = hslToHex(h, s, l);
    const theme = deriveProjectTheme(hex);
    const rgb255 = hslToRgb255(h, s, l);
    const base = rgbToHsl(rgb255[0], rgb255[1], rgb255[2]).l;
    const tiers = [base, ...theme.shades.map((shade) => parseShade(shade).l)];
    for (let i = 1; i < tiers.length; i++) {
      const expected = tiers[i - 1] * SHADE_LIGHTNESS_RATIO;
      assert.ok(
        Math.abs(tiers[i] - expected) <= 0.35,
        `h${h} s${s} l${l}: tier ${i} is ${tiers[i]} ~ ${tiers[i - 1].toFixed(2)} x ${SHADE_LIGHTNESS_RATIO} = ${expected.toFixed(2)}`,
      );
    }
  }
}

export function checkNoClampOnDarkCustoms(): void {
  // The floor case of the whole design: at low lightness the steps shrink
  // (the shades are emitted at 0.1-point resolution) but the ladder stays
  // STRICTLY DECREASING — a clamped ladder would emit duplicate or
  // non-decreasing shades. Ratio-identity is checkLadderIsGeometric's claim.
  for (const l of [1, 5, 15]) {
    const theme = deriveProjectTheme(hslToHex(210, 60, l));
    const levels = theme.shades.map((shade) => parseShade(shade).l);
    assert.equal(new Set(levels).size, 3, `l=${l}: three distinct shades`);
    assert.ok(levels[0] < l, `l=${l}: first shade darker than the base`);
    for (let i = 1; i < levels.length; i++) {
      assert.ok(levels[i] < levels[i - 1], `l=${l}: tier ${i} strictly darker`);
    }
  }
}

export function checkPresetBandStepsAreVisible(): void {
  for (const preset of PRESET_PROJECT_COLORS) {
    const { hsl, shades } = deriveProjectTheme(preset.hex);
    let previous = hsl.l;
    for (const shade of shades) {
      const l = parseShade(shade).l;
      assert.ok(previous - l >= 5, `${preset.name}: ${previous} -> ${l} is a visible step`);
      previous = l;
    }
  }
}

export function checkShadesKeepTheBaseFamily(): void {
  for (const { h, s, l } of GAMUT) {
    const theme = deriveProjectTheme(hslToHex(h, s, l));
    for (const shade of theme.shades) {
      const parsed = parseShade(shade);
      assert.equal(parsed.h, theme.hsl.h, `h${h} s${s}: shade keeps the hue`);
      assert.equal(parsed.s, theme.hsl.s, `h${h} s${s}: shade keeps the saturation`);
    }
  }
}

// --- the background tint -----------------------------------------------------

export function checkBgTintIsTheBaseAtTheVeilAlpha(): void {
  assert.ok(BG_TINT_ALPHA > 0 && BG_TINT_ALPHA <= 0.1, `alpha ${BG_TINT_ALPHA} is a veil`);
  for (const preset of PRESET_PROJECT_COLORS) {
    const theme = deriveProjectTheme(preset.hex);
    const m = theme.bgTint.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)% \/ ([\d.]+)\)$/);
    assert.ok(m, `${preset.name}: bgTint is an hsl veil with alpha`);
    assert.equal(Number(m[1]), theme.hsl.h, `${preset.name}: tint keeps the hue`);
    assert.equal(Number(m[2]), theme.hsl.s, `${preset.name}: tint keeps the saturation`);
    assert.equal(Number(m[3]), theme.hsl.l, `${preset.name}: tint is AT the base lightness`);
    assert.equal(Number(m[4]), BG_TINT_ALPHA, `${preset.name}: tint alpha is the veil constant`);
  }
}

// --- the picker's contract ---------------------------------------------------

export function checkPickerDrawsOnlyFromUnused(): void {
  const all = PRESET_PROJECT_COLORS.map((p) => p.hex);
  // rng 0.999 -> the LAST pool entry, so this pins the pool, not just its size.
  for (let taken = 0; taken < all.length; taken++) {
    const used = all.slice(0, taken);
    const expectedUnused = all.slice(taken);
    const last = pickProjectColorHex(used, () => 0.999);
    assert.equal(last, expectedUnused[expectedUnused.length - 1],
      `with ${taken} taken, the draw comes from the ${expectedUnused.length} unused presets`);
  }
  // Exhausted: the full template is the pool, proven the same way.
  assert.equal(pickProjectColorHex(all, () => 0.999), all[all.length - 1]);
}

export function checkPickerNormalizesTheUsedList(): void {
  const red = PRESET_PROJECT_COLORS[0];
  const otherEight = PRESET_PROJECT_COLORS.slice(1).map((p) => p.hex);
  assert.equal(pickProjectColorHex([red.hex.toUpperCase(), ...otherEight], () => 0), red.hex,
    'uppercase of every preset but one leaves that one');
  assert.equal(pickProjectColorHex([red.hex.slice(1), ...otherEight], () => 0), red.hex,
    'a #less entry still counts as used');
  // Junk entries do not poison the used set.
  const junk = ['garbage', 42, null] as unknown as string[];
  assert.equal(pickProjectColorHex(junk, () => 0.999), PRESET_PROJECT_COLORS[8].hex,
    'only real colors are excluded');
}

// --- normalization -----------------------------------------------------------

export function checkNormalizeHexColor(): void {
  const cases: Array<[unknown, string | null]> = [
    ['#DC4A3A', '#dc4a3a'],
    ['dc4a3a', '#dc4a3a'],
    ['#f00', '#ff0000'],
    ['  #AbCdEf  ', '#abcdef'],
    ['#ABC', '#aabbcc'],
    ['', null],
    ['#12345', null],
    ['#1234567', null],
    ['rgb(0, 0, 0)', null],
    ['hsl(210 50% 50%)', null],
    ['oklch(0.6 0.1 210)', null],
    ['red', null],
    ['#dc4a3a;', null],
    [null, null],
    [undefined, null],
    [42, null],
    [{}, null],
    [['#dc4a3a'], null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeHexColor(input as string), expected, `normalizeHexColor(${JSON.stringify(input)})`);
  }
  // 3-digit expansion duplicates each nibble, it does not pad with zeros.
  assert.equal(normalizeHexColor('#0f0'), '#00ff00');
}

export function checkIsPresetColor(): void {
  for (const preset of PRESET_PROJECT_COLORS) {
    assert.equal(isPresetColor(preset.hex), true);
    assert.equal(isPresetColor(preset.hex.toUpperCase()), true);
  }
  assert.equal(isPresetColor('#000000'), false);
  assert.equal(isPresetColor('#dc4a3b'), false, 'a near-miss is not a preset');
  assert.equal(isPresetColor('garbage'), false);
}

// --- the variable contract ---------------------------------------------------

export function checkCssVarsContractValues(): void {
  const theme = deriveProjectTheme('#3e7fd4');
  const vars = projectThemeCssVars(theme);
  assert.deepEqual(Object.keys(vars), [
    PROJECT_THEME_CSS_VARS.color,
    PROJECT_THEME_CSS_VARS.shade1,
    PROJECT_THEME_CSS_VARS.shade2,
    PROJECT_THEME_CSS_VARS.shade3,
    PROJECT_THEME_CSS_VARS.bgTint,
  ]);
  assert.equal(vars[PROJECT_THEME_CSS_VARS.color], theme.hex);
  assert.equal(vars[PROJECT_THEME_CSS_VARS.shade1], theme.shades[0]);
  assert.equal(vars[PROJECT_THEME_CSS_VARS.shade2], theme.shades[1]);
  assert.equal(vars[PROJECT_THEME_CSS_VARS.shade3], theme.shades[2]);
  assert.equal(vars[PROJECT_THEME_CSS_VARS.bgTint], theme.bgTint);
}

export function checkDerivationIsTotalOverTheGamut(): void {
  for (const { h, s, l } of GAMUT) {
    const theme = deriveProjectTheme(hslToHex(h, s, l));
    assert.match(theme.hex, /^#[0-9a-f]{6}$/);
    assert.equal(theme.shades.length, 3);
    assert.match(theme.bgTint, /^hsl\([\d.]+ [\d.]+% [\d.]+% \/ 0\.08\)$/);
  }
}
