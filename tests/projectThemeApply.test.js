import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';

import { PRESET_PROJECT_COLORS } from '../src/lib/projectTheme.js';
import {
  applyProjectTheme,
  activeProjectColorHex,
  clearProjectTheme,
  readableOnFillColor,
  resolveProjectTheme,
  DEFAULT_PROJECT_COLOR_HEX,
  PROJECT_COLOR_FIELDS,
  PROJECT_THEME_ACTIVE_ATTR,
} from '../src/lib/applyProjectTheme.js';

/** A minimal DOM stub — the applier only needs documentElement + inline style. */
function fakeDoc() {
  const attrs = new Map();
  const style = new Map();
  return {
    documentElement: {
      style: {
        setProperty: (name, value) => style.set(name, value),
        removeProperty: (name) => style.delete(name),
        getPropertyValue: (name) => style.get(name) ?? '',
      },
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: (name) => attrs.delete(name),
      getAttribute: (name) => attrs.get(name) ?? null,
    },
  };
}

/** Composite `hsl(H S% L% / A)` over a #rrggbb surface, to {r,g,b} in 0..255. */
function tintOver(tint, base) {
  const [h, s, l, a] = tint.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)% \/ ([\d.]+)\)$/).slice(1).map(Number);
  const sat = s / 100;
  const lig = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const chroma = (1 - Math.abs(2 * lig - 1)) * sat;
  const hue = (n) => lig - chroma / 2 * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const mix = (fg, bg) => fg * a + bg * (1 - a);
  return {
    r: Math.round(mix(hue(0), parseInt(base.slice(1, 3), 16) / 255) * 255),
    g: Math.round(mix(hue(8), parseInt(base.slice(3, 5), 16) / 255) * 255),
    b: Math.round(mix(hue(4), parseInt(base.slice(5, 7), 16) / 255) * 255),
  };
}

const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const luminance = (rgb) => {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = Array.isArray(rgb) ? rgb : [rgb.r, rgb.g, rgb.b];
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

test('active project color resolution: record field, legacy field, fallback', () => {
  assert.equal(activeProjectColorHex({ colorHex: '#DC4A3A' }), '#dc4a3a');
  assert.equal(activeProjectColorHex({ color: '52b23f' }), '#52b23f');
  assert.equal(activeProjectColorHex({ colorHex: 'not-a-color', color: '#abc' }), '#aabbcc');
  assert.equal(activeProjectColorHex({ colorHex: 'not-a-color' }), null);
  assert.equal(activeProjectColorHex({}), null);
  assert.equal(activeProjectColorHex(null), null);
  assert.deepEqual(PROJECT_COLOR_FIELDS, ['colorHex', 'color']);
});

test('resolveProjectTheme falls back to a default preset before persistence lands', () => {
  const resolved = resolveProjectTheme({});
  assert.equal(resolved.usedFallback, true);
  assert.ok(
    PRESET_PROJECT_COLORS.some((preset) => preset.hex === resolved.hex),
    `the fallback is one of the 9 presets, got ${resolved.hex}`,
  );
  assert.match(resolved.vars['--project-color'], /^#[0-9a-f]{6}$/);
  assert.equal(resolveProjectTheme({ colorHex: '#dc4a3a' }).usedFallback, false);
  // An invalid stored color is a "no color yet", not a broken theme.
  assert.equal(resolveProjectTheme({ colorHex: 'url(javascript:)' }).usedFallback, true);
});

test('applyProjectTheme writes the contract variables and the active switch', () => {
  const doc = fakeDoc();
  const vars = applyProjectTheme({ colorHex: '#dc4a3a' }, doc);
  assert.equal(doc.documentElement.getAttribute(PROJECT_THEME_ACTIVE_ATTR), '');
  assert.equal(doc.documentElement.style.getPropertyValue('--project-color'), '#dc4a3a');
  for (const name of ['--project-color', '--project-color-shade-1', '--project-color-shade-2',
    '--project-color-shade-3', '--project-bg-tint']) {
    assert.ok(String(vars[name]), `${name} is written`);
  }
  assert.notEqual(vars['--project-color-shade-1'], vars['--project-color-shade-3'],
    'the shade ladder reaches the shell as visibly distinct values');
});

test('re-applying for a different project color swaps the variables with no reload', () => {
  const doc = fakeDoc();
  applyProjectTheme({ colorHex: '#dc4a3a' }, doc);
  const first = doc.documentElement.style.getPropertyValue('--project-color');
  applyProjectTheme({ colorHex: '#3e7fd4' }, doc);
  const second = doc.documentElement.style.getPropertyValue('--project-color');
  assert.notEqual(first, second);
  assert.equal(second, '#3e7fd4');
  // Same element, same variable names — nothing else is needed for a live swap.
  assert.equal(doc.documentElement.getAttribute(PROJECT_THEME_ACTIVE_ATTR), '');
});

test('clearProjectTheme removes the variables and the active switch', () => {
  const doc = fakeDoc();
  applyProjectTheme({ colorHex: '#dc4a3a' }, doc);
  assert.equal(clearProjectTheme(doc), true);
  assert.equal(doc.documentElement.getAttribute(PROJECT_THEME_ACTIVE_ATTR), null);
  assert.equal(doc.documentElement.style.getPropertyValue('--project-color'), '');
  assert.equal(clearProjectTheme(fakeDoc()), true);
});

test('the on-fill pairing is readable: ink or white, whichever contrasts more', () => {
  // The presets are mid-lightness, but Indigo is deep enough that white wins —
  // the contract is the better of the two candidates, never a fixed color, and
  // the winner always clears the 3:1 UI floor (the crossover of the two
  // ratios sits above 4, so no color leaves both candidates below 3).
  const INK = '#0b140f';
  for (const preset of PRESET_PROJECT_COLORS) {
    const on = readableOnFillColor(preset.hex);
    const overFill = contrast(parse(preset.hex), parse(on));
    const overInk = contrast(parse(preset.hex), parse(INK));
    const overWhite = contrast(parse(preset.hex), parse('#ffffff'));
    assert.equal(on, overWhite >= overInk ? '#ffffff' : INK,
      `${preset.name} pairs with whichever candidate contrasts more`);
    assert.ok(overFill >= 3, `${preset.name}: on-fill contrast ${overFill.toFixed(2)} >= 3`);
  }
  assert.equal(readableOnFillColor('#111111'), '#ffffff');
  assert.equal(readableOnFillColor('#123456'), '#ffffff');
  assert.equal(readableOnFillColor('garbage'), readableOnFillColor(DEFAULT_PROJECT_COLOR_HEX),
    'an unusable color pairs against the default preset, not against nothing');
  // The written variable matches the pairing for the active color.
  const doc = fakeDoc();
  applyProjectTheme({ colorHex: '#111111' }, doc);
  assert.equal(doc.documentElement.style.getPropertyValue('--project-on-accent'), '#ffffff');
  applyProjectTheme({ colorHex: '#dc4a3a' }, doc);
  assert.equal(doc.documentElement.style.getPropertyValue('--project-on-accent'), INK);
});

test('background tint is subtle and text keeps readable contrast', () => {
  // The real surfaces the tint composites over, from src/styles.css.
  const CANVAS = { light: '#f8faf9', dark: '#0e1310' };
  const INK = { light: '#1e2623', dark: '#e3ebe6' };
  for (const preset of PRESET_PROJECT_COLORS) {
    const { theme } = resolveProjectTheme({ colorHex: preset.hex });
    for (const mode of ['light', 'dark']) {
      const tinted = tintOver(theme.bgTint, CANVAS[mode]);
      // Subtle: the tinted canvas stays near the untinted one.
      const base = parse(CANVAS[mode]).map((c) => c * 255);
      const drift = Math.max(
        Math.abs(tinted.r - base[0]),
        Math.abs(tinted.g - base[1]),
        Math.abs(tinted.b - base[2]),
      );
      assert.ok(drift <= 30, `${preset.name} ${mode}: tint drift ${drift} <= 30`);
      // Readable: body text over the tinted canvas keeps WCAG AA.
      const ratio = contrast(tinted, parse(INK[mode]));
      assert.ok(ratio >= 4.5, `${preset.name} ${mode}: contrast ${ratio.toFixed(2)} >= 4.5`);
    }
  }
});

test('two different project colors produce visibly different themes', () => {
  const red = PRESET_PROJECT_COLORS[0];
  const blue = PRESET_PROJECT_COLORS.find((preset) => preset.name === 'Blue');
  const a = resolveProjectTheme({ colorHex: red.hex }).vars;
  const b = resolveProjectTheme({ colorHex: blue.hex }).vars;
  for (const name of ['--project-color', '--project-bg-tint']) assert.notEqual(a[name], b[name]);
});

test('the shell hosts the theme: active switch on the root, records read by id', async () => {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const ShellModule = await vite.ssrLoadModule('/src/v2/Shell.jsx');
    const { activeProjectRecord } = ShellModule;
    // Active with an explicit color renders the switch…
    const themed = renderToStaticMarkup(React.createElement(ShellModule.default, {
      projects: {
        tabs: [{ id: 'p1', name: 'One', colorHex: '#dc4a3a' }, { id: 'p2', name: 'Two', colorHex: '#3e7fd4' }],
        active: 'p1',
      },
    }));
    assert.match(themed, /data-project-theme/);
    // …a projectless shell does not…
    const bare = renderToStaticMarkup(React.createElement(ShellModule.default, {
      projects: { tabs: [], active: null },
    }));
    assert.doesNotMatch(bare, /data-project-theme/);
    // …and the record reader picks the active tab and tolerates gaps.
    assert.equal(activeProjectRecord({ tabs: [{ id: 'a' }, { id: 'b', name: 'B' }], active: 'b' }).name, 'B');
    assert.equal(activeProjectRecord({ tabs: [{ id: 'a' }], active: 'gone' }), null);
    assert.equal(activeProjectRecord(null), null);
  } finally {
    await vite.close();
  }
});
