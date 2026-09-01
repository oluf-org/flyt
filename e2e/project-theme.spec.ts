// ============================================================================
// e2e/project-theme.spec.ts — END-TO-END ACCEPTANCE SPEC (tests drive it)
// ============================================================================
// The five acceptance criteria of the per-project theming feature, each as an
// exported named check. The file is TypeScript (the nominal e2e location, and
// TS like the app's own .tsx) but it is not executed by a TS runner: Node
// 22.12's `node --test` parses neither .ts nor JSX, and the repo has no TS
// test runner. It is loaded — transpiled — through the same vite the app
// ships, by tests/projectThemeE2e.test.js, which runs every check as a
// subtest. One spec, one gate-visible suite.
//
// Checks run against REAL modules end to end: the pure color math, the
// applier that writes the CSS custom properties, the ProjectRegistry that
// persists and auto-assigns, the engine/API/IPC layer, and the settings
// section + shell that consume it all. The browser-level render assertions
// (vite SSR of Shell and the settings section) live in their existing
// suites (projectThemeApply / projectColorSettings) and are referenced by
// the report; this spec holds what no other test holds:
//   - the acceptance thresholds themselves (no other file pins them),
//   - the full chain through api.invoke / IPC / preload / mock,
//   - the theme package a browser actually wears, end to end.
// ============================================================================

import assert from 'node:assert/strict';

import {
  PRESET_PROJECT_COLORS,
  deriveProjectTheme,
  normalizeHexColor,
} from '../src/lib/projectTheme.js';
import {
  applyProjectTheme,
  clearProjectTheme,
  readableOnFillColor,
  resolveProjectTheme,
} from '../src/lib/applyProjectTheme.js';

// --- types -----------------------------------------------------------------

export interface PresetEntry { name: string; hex: string }
export interface Rgb { r: number; g: number; b: number }
export interface Rgb255 { r: number; g: number; b: number }

// --- color helpers (self-contained; the spec must not trust the module) ----

/** hsl (deg/%/%) -> {r,g,b} 0..1, standard CSS math. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0), g: f(8), b: f(4) };
}

/** `hsl(H S% L%)` -> {r,g,b} 0..255. */
export function shadeRgb255(shade: string): Rgb {
  const m = shade.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/);
  assert.ok(m, `a derived shade is a plain hsl() triple: ${shade}`);
  const out = hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
  return { r: out.r * 255, g: out.g * 255, b: out.b * 255 };
}

/** `hsl(H S% L% / A)` veil composited over an opaque {r,g,b} 0..1 surface. */
export function compositeTint(tint: string, surface: Rgb): Rgb {
  const m = tint.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)% \/ ([\d.]+)\)$/);
  assert.ok(m, `bgTint is an hsl() veil with alpha: ${tint}`);
  const veil = hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
  const alpha = Number(m[4]);
  return {
    r: veil.r * alpha + surface.r * (1 - alpha),
    g: veil.g * alpha + surface.g * (1 - alpha),
    b: veil.b * alpha + surface.b * (1 - alpha),
  };
}

export const parseHex = (hex: string): Rgb => ({
  r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255,
  b: parseInt(hex.slice(5, 7), 16) / 255,
});

/** WCAG 2 relative luminance of an {r,g,b} in 0..1. */
export function luminance(rgb: Rgb): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** WCAG contrast ratio between two {r,g,b} colors (0..1 components). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Largest per-channel |delta| between two 0..255 colors. */
export const channelDelta = (a: Rgb255, b: Rgb255): number =>
  Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

/** The {r,g,b} 0..255 of a hex color. */
export const hexRgb255 = (hex: string): Rgb255 => {
  const n = normalizeHexColor(hex);
  assert.ok(n, `${hex} is a hex color`);
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
};

// The surfaces from src/styles.css (light/dark), which the sheet tints.
export const CANVAS: Record<'light' | 'dark', Rgb> = {
  light: parseHex('#f8faf9'),
  dark: parseHex('#0e1310'),
};
export const TX: Record<'light' | 'dark', Rgb> = {
  light: parseHex('#1e2623'),
  dark: parseHex('#e3ebe6'),
};

// --- Criterion 1: two projects with different colors are distinguishable ---

export function checkTwoProjectsDistinguishable(): void {
  const byName = (name: string): PresetEntry => {
    const found = PRESET_PROJECT_COLORS.find((p) => p.name === name);
    assert.ok(found, `preset ${name} exists`);
    return found;
  };
  const red = deriveProjectTheme(byName('Red').hex);
  const blue = deriveProjectTheme(byName('Blue').hex);

  // Accents differ far beyond a JND (~2.5/255 per channel).
  const accentDelta = channelDelta(hexRgb255(red.hex), hexRgb255(blue.hex));
  assert.ok(accentDelta >= 40, `accent delta ${accentDelta} >= 40/255`);

  // The tinted page backgrounds differ on both themes…
  for (const mode of ['light', 'dark'] as const) {
    const a = compositeTint(red.bgTint, CANVAS[mode]);
    const b = compositeTint(blue.bgTint, CANVAS[mode]);
    const d = channelDelta(
      { r: a.r * 255, g: a.g * 255, b: a.b * 255 },
      { r: b.r * 255, g: b.g * 255, b: b.b * 255 },
    );
    assert.ok(d >= 2.5, `${mode}: tinted-canvas delta ${d.toFixed(2)} >= 2.5/255`);
  }

  // …and the full derived package (accent + all shades + tint) differs
  // for EVERY preset pair — any two auto-assigned projects are separable,
  // not just the canonical Red/Blue example.
  let minPairDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < PRESET_PROJECT_COLORS.length; i++) {
    for (let j = i + 1; j < PRESET_PROJECT_COLORS.length; j++) {
      const a = deriveProjectTheme(PRESET_PROJECT_COLORS[i].hex);
      const b = deriveProjectTheme(PRESET_PROJECT_COLORS[j].hex);
      const d = channelDelta(hexRgb255(a.hex), hexRgb255(b.hex));
      minPairDelta = Math.min(minPairDelta, d);
    }
  }
  assert.ok(minPairDelta >= 40, `min accent delta across all pairs ${minPairDelta} >= 40/255`);

  // The applier writes visibly different variable sets for the two records.
  const doc = fakeDoc();
  applyProjectTheme({ colorHex: byName('Red').hex }, doc);
  const first = doc.documentElement.style.getPropertyValue('--project-color');
  applyProjectTheme({ colorHex: byName('Blue').hex }, doc);
  const second = doc.documentElement.style.getPropertyValue('--project-color');
  assert.notEqual(first, second);
}

// --- Criterion 2: auto-assignment rarely collides while presets remain -----

export function checkAutoAssignment(): void {
  // Deterministic rngs, seeded per trial: the same statistical experiment
  // every run, no flakes, no dependence on the registry constructor's hook.
  function mulberry32(seed: number): () => number {
    let a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 300 independent four-project sessions: how often does a new project
  // share a color with an existing one while unused presets remain?
  const trials = 300;
  const perSession = 4;
  let collisions = 0;
  let allDistinct = 0;
  let presetsRemainingMin = PRESET_PROJECT_COLORS.length;
  for (let t = 0; t < trials; t++) {
    const rng = mulberry32(1000 + t);
    const picked: string[] = [];
    for (let k = 0; k < perSession; k++) picked.push(avoidPick(picked, rng));
    const distinct = new Set(picked).size;
    collisions += perSession - distinct;
    if (distinct === perSession) allDistinct++;
    presetsRemainingMin = Math.min(presetsRemainingMin, PRESET_PROJECT_COLORS.length - new Set(picked).size);
  }
  const rate = collisions / (trials * perSession);
  assert.ok(rate <= 0.02, `collision rate ${(rate * 100).toFixed(1)}% <= 2% over ${trials} sessions`);
  assert.ok(allDistinct >= trials * 0.9, `${allDistinct}/${trials} sessions had zero collisions`);
  assert.ok(presetsRemainingMin >= 5, `unused presets remain (min ${presetsRemainingMin} of 9)`);
}

/** One draw of the registry's assignment rule, standalone: uniform among the
    presets no listed project uses; the full template when all are taken. */
function avoidPick(used: string[], rng: () => number): string {
  const taken = new Set(used.map((h) => normalizeHexColor(h)).filter(Boolean) as string[]);
  const unused = PRESET_PROJECT_COLORS.filter((p) => !taken.has(p.hex));
  const pool = unused.length > 0 ? unused : PRESET_PROJECT_COLORS;
  return pool[Math.floor(rng() * pool.length) % pool.length].hex;
}

// --- Criterion 3: any preset or custom color yields a coherent theme -------

const CUSTOM_EXTRAS = ['#22d3ee', '#f97316', '#7c3aed', '#eab308', '#2a2a2a', '#123456', '#f0abfc', '#ff0000', '#00ff00'];

export const allThemeBases = (): string[] => [
  ...PRESET_PROJECT_COLORS.map((p) => p.hex),
  ...CUSTOM_EXTRAS,
];

/** The theme package one project wears, derived through the real applier. */
export function themePackageFor(project: Record<string, unknown>): {
  color: string;
  shades: Rgb255[];
  tinted: Record<'light' | 'dark', Rgb255>;
  onAccent: string;
  accentLight: string;
  accentDark: string;
} {
  const resolved = resolveProjectTheme(project);
  const doc = fakeDoc();
  applyProjectTheme(project, doc);
  const style = doc.documentElement.style;
  const tinted = {} as Record<'light' | 'dark', Rgb255>;
  for (const mode of ['light', 'dark'] as const) {
    tinted[mode] = compositeTint255(resolved.theme.bgTint, mode === 'light' ? '#f8faf9' : '#0e1310');
  }
  return {
    color: style.getPropertyValue('--project-color'),
    shades: (resolved.theme.shades as string[]).map(shadeRgb255),
    tinted,
    onAccent: style.getPropertyValue('--project-on-accent'),
    accentLight: style.getPropertyValue('--project-accent-light'),
    accentDark: style.getPropertyValue('--project-accent-dark'),
  };
}

function compositeTint255(tint: string, surfaceHex: string): Rgb255 {
  const m = tint.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)% \/ ([\d.]+)\)$/);
  assert.ok(m, `bgTint parses: ${tint}`);
  const veil = hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
  const base = hexRgb255(surfaceHex);
  const a = Number(m[4]);
  return {
    r: Math.round(veil.r * a * 255 + base.r * (1 - a)),
    g: Math.round(veil.g * a * 255 + base.g * (1 - a)),
    b: Math.round(veil.b * a * 255 + base.b * (1 - a)),
  };
}

export function checkAnyColorCoherentTheme(): void {
  for (const base of allThemeBases()) {
    const pkg = themePackageFor({ colorHex: base });
    const derived = deriveProjectTheme(base);
    const label = base;

    // 3 visibly darker shades: monotonic, distinct steps, hue/sat preserved.
    assert.equal(pkg.shades.length, 3, `${label}: three shades`);
    let previousL = derived.hsl.l;
    derived.shades.forEach((shade, i) => {
      const m = shade.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/);
      assert.ok(m, `${label}: shade ${i + 1} parses`);
      const l = Number(m[3]);
      assert.equal(Number(m[1]), derived.hsl.h, `${label}: shade ${i + 1} keeps the hue`);
      assert.equal(Number(m[2]), derived.hsl.s, `${label}: shade ${i + 1} keeps the saturation`);
      assert.ok(l < previousL, `${label}: shade ${i + 1} is darker than the tier above`);
      assert.ok(previousL - l >= 1.9, `${label}: shade ${i + 1} step >= 1.9 L-points (geometric ladder never clamps)`);
      previousL = l;
    });
    assert.ok(new Set(pkg.shades.map((s) => `${s.r},${s.g},${s.b}`)).size === 3, `${label}: shades are visibly distinct`);

    // Subtle tinted background: drift <= 30/255 (a veil, not a repaint)…
    for (const mode of ['light', 'dark'] as const) {
      const base255 = mode === 'light' ? hexRgb255('#f8faf9') : hexRgb255('#0e1310');
      const d = channelDelta(pkg.tinted[mode], base255);
      assert.ok(d <= 30, `${label} ${mode}: tint drift ${d.toFixed(1)} <= 30/255`);
      // …with contrast preserved: body text keeps WCAG AA (>= 4.5) over it.
      const tinted01 = { r: pkg.tinted[mode].r / 255, g: pkg.tinted[mode].g / 255, b: pkg.tinted[mode].b / 255 };
      const ratio = contrast(TX[mode], tinted01);
      assert.ok(ratio >= 4.5, `${label} ${mode}: text contrast ${ratio.toFixed(2)} >= 4.5 over the tinted canvas`);
    }

    // Readable on-fill text (active tab, buttons) — ink or white, >= 3:1.
    const on = readableOnFillColor(base);
    assert.equal(pkg.onAccent, on, `${label}: the on-accent variable matches the pairing`);
    const fill01 = parseHex(base);
    const on01 = on === '#ffffff' ? { r: 1, g: 1, b: 1 } : parseHex('#0b140f');
    const onRatio = contrast(fill01, on01);
    assert.ok(onRatio >= 3, `${label}: on-fill contrast ${onRatio.toFixed(2)} >= 3`);

    // Per-theme text accent: >= 3:1 against the tinted canvas, or the family
    // maximum when nothing clears it (near-black customs on dark canvas).
    const familyRatios = (tinted01: Rgb): number[] => [
      contrast(parseHex(derived.hex), tinted01),
      ...derived.shades.map((s) => contrast({
        r: shadeRgb255(s).r / 255, g: shadeRgb255(s).g / 255, b: shadeRgb255(s).b / 255,
      }, tinted01)),
    ];
    for (const mode of ['light', 'dark'] as const) {
      const chosen = mode === 'light' ? pkg.accentLight : pkg.accentDark;
      assert.ok(chosen, `${label}: ${mode} accent variable written`);
      const chosenRgb = chosen.startsWith('hsl(') ? shadeRgb255(chosen) : hexRgb255(chosen);
      const tinted01 = { r: pkg.tinted[mode].r / 255, g: pkg.tinted[mode].g / 255, b: pkg.tinted[mode].b / 255 };
      const ratio = contrast({ r: chosenRgb.r / 255, g: chosenRgb.g / 255, b: chosenRgb.b / 255 }, tinted01);
      const best = Math.max(...familyRatios(tinted01));
      assert.ok(
        ratio >= 3 || ratio >= best - 0.02,
        `${label} ${mode}: accent contrast ${ratio.toFixed(2)} (>= 3, or the family best ${best.toFixed(2)})`,
      );
    }

    // The base is a preset or a normalized custom — never junk on the root.
    assert.match(pkg.color, /^#[0-9a-f]{6}$/, `${label}: --project-color is a clean #rrggbb`);
  }
}

// --- Criterion 4: settings color change persists and applies immediately ---

export async function checkSettingsPersistsAndAppliesImmediately(): Promise<void> {
  const dataRoot = mkdtemp();
  const mk = () => createEngineAt(dataRoot);
  const first = mk();
  const api = createApiAt(first);
  const folder = mkdtemp();
  await api.invoke('project:open', { folder });
  const id = folderProjectId(folder);

  // Preset click → persisted to settings.json immediately…
  await api.invoke('project:color', { projectId: id, hex: '#DC4A3A' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings.json'), 'utf8')) as unknown;
  assert.equal(getIn(onDisk, ['projects', 'colors', id]), '#dc4a3a', 'preset persisted (normalized)');

  // …and read back by a brand-new process over the same profile: survival
  // across reload, at the level the data layer actually guarantees.
  const second = mk();
  second.registry.restore(second.settings.projects ?? {});
  assert.equal(second.registry.colorOf(id), '#dc4a3a');

  // Custom picker value → same one write path, same persistence.
  await api.invoke('project:color', { projectId: id, hex: 'ABC123' });
  assert.equal(
    ((await api.invoke('project:color', { projectId: id })) as { colorHex: string }).colorHex,
    '#abc123',
  );

  // IMMEDIATE APPLIES: the exact record listProjects() now ships, run through
  // the real applier, must produce the new theme — no reload in the chain.
  const payload = (await api.invoke('project:list', {})) as {
    tabs: { id: string; colorHex: string }[];
    active: string | null;
  };
  const record = payload.tabs.find((tab) => tab.id === id);
  assert.equal(record?.colorHex, '#abc123');
  const doc = fakeDoc();
  applyProjectTheme(record as unknown as Record<string, unknown>, doc);
  assert.equal(doc.documentElement.style.getPropertyValue('--project-color'), '#abc123');
  const themed = resolveProjectTheme(record as unknown as Record<string, unknown>);
  assert.equal(themed.usedFallback, false, 'the record carries its own color — no fallback');

  // Junk is refused by the service and changes nothing.
  await assert.rejects(
    () => api.invoke('project:color', { projectId: id, hex: 'not-a-color' }),
    (err: unknown) => err instanceof ApiError && (err as ApiError).code === 'bad_color',
  );
  assert.equal(
    ((await api.invoke('project:color', { projectId: id })) as { colorHex: string }).colorHex,
    '#abc123',
  );

  // The settings section commits through flyt.projectColor and the host merge
  // re-reads listProjects — the live-retheme seam, held as source shape (the
  // repo's pattern for wiring only React mounts).
  const settingsSrc = readFile('src/Settings.jsx');
  assert.match(settingsSrc, /tab === 'project' && \(\s*<ProjectColorSettings projects=\{projects\} onColorChange=\{onColorChange\}/);
  const daily = readFile('src/v2/DailyRoot.jsx');
  assert.match(daily, /acceptProjects\(await window\.flyt\.listProjects\(\)\)/);
  const section = readFile('src/components/settings/ProjectColorSettings.tsx');
  assert.match(section, /api\.projectColor\(pid, hex\)/);
  assert.match(section, /onColorChange\?\.\(\{ \.\.\.project, \.\.\.record \}\)/);
  void first;
}

/** Walk a nested path of an unknown-shaped parsed JSON value. */
function getIn(value: unknown, keys: string[]): unknown {
  let cur: unknown = value;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// --- Criterion 5: no regressions in existing flows -------------------------

export function checkNoRegressions(): void {
  // The feature's surface grew as documented additions; every pre-existing
  // key the settings/projects flows relied on is still present, and the
  // listOpen payload is a superset of the pre-color shape.
  const { registry } = makeRegistry();
  const { project } = registry.createAppdata('Regression probe');
  const tab = registry.listOpen().find((t) => t.id === project.id);
  for (const key of ['id', 'folder', 'name', 'kind', 'live', 'state']) {
    assert.ok(key in tab, `listOpen still carries "${key}"`);
  }
  const saved = registry.serialize();
  for (const key of ['open', 'active', 'recents', 'tabState', 'names']) {
    assert.ok(key in saved, `serialize still carries "${key}"`);
  }
  // The theme layer is inert without a project: nothing is written, nothing
  // is left behind after a clear.
  const doc = fakeDoc();
  assert.equal(clearProjectTheme(doc), true);
  assert.equal(doc.documentElement.getAttribute('data-project-theme'), null);
  applyProjectTheme({ colorHex: '#dc4a3a' }, doc);
  assert.equal(doc.documentElement.getAttribute('data-project-theme'), '');
  assert.equal(clearProjectTheme(doc), true);
  assert.equal(doc.documentElement.style.getPropertyValue('--project-color'), '');
  // Status color is never spent on the project (the sheet hard-errs it).
  const sheet = readFile('src/styles/project-theme.css');
  assert.match(sheet, /\.activity-badge\.tone-err\s*\{[^}]*--err/);
}

// ============================================================================
// Tests drive this spec. Everything below is the driver's toolkit: the DOM
// stub, the tmp-dir helpers, and the registry factory.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry, projectIdFor } from '../core/projects.js';
import { createEngine } from '../core/engine.js';
import { createApi, ApiError } from '../core/api.js';

/** A minimal DOM stub — the applier only needs documentElement + inline style. */
export function fakeDoc(): {
  documentElement: {
    style: {
      setProperty: (name: string, value: string) => void;
      removeProperty: (name: string) => void;
      getPropertyValue: (name: string) => string;
    };
    setAttribute: (name: string, value: string) => void;
    removeAttribute: (name: string) => void;
    getAttribute: (name: string) => string | null;
  };
} {
  const attrs = new Map<string, string>();
  const style = new Map<string, string>();
  return {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => style.set(name, value),
        removeProperty: (name: string) => style.delete(name),
        getPropertyValue: (name: string) => style.get(name) ?? '',
      },
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
      getAttribute: (name: string) => attrs.get(name) ?? null,
    },
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const join = (...parts: string[]): string => path.join(projectRoot, ...parts);
const readFile = (rel: string): string => fs.readFileSync(join(rel), 'utf8');
const mkdtemp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-e2e-'));

function createEngineAt(dataRoot: string): ReturnType<typeof createEngine> {
  return createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
}

function createApiAt(engine: ReturnType<typeof createEngine>): {
  invoke: (command: string, payload?: unknown) => Promise<unknown> | unknown;
} {
  return createApi(engine);
}

function makeRegistry(): { registry: InstanceType<typeof ProjectRegistry> } {
  const root = mkdtemp();
  const registry = new ProjectRegistry({
    defaultRunsDir: path.join(root, 'runs'),
    appDataDir: path.join(root, 'appdata'),
    getStorage: () => 'workspace',
    createRunner: () => ({ live: new Set() }),
    onPersist: () => fs.writeFileSync(
      path.join(root, 'settings.json'),
      JSON.stringify({ projects: registry.serialize() }, null, 2)),
  });
  return { registry };
}

function folderProjectId(folder: string): string {
  return projectIdFor(folder);
}
