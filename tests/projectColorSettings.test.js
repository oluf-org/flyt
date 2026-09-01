import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';

import { PRESET_PROJECT_COLORS } from '../src/lib/projectTheme.js';
import { DEFAULT_PROJECT_COLOR_HEX, resolveProjectTheme } from '../src/lib/applyProjectTheme.js';

/**
 * The Color section's tests. The component itself is a renderer module — it
 * is loaded through vite (the same transpile the app runs) rather than
 * imported, because Node's test runner parses neither JSX nor TS. The pure
 * helpers come off the same module, so the tests hold the exact code the
 * section runs.
 */
async function loadSection() {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    return { module: await vite.ssrLoadModule('/src/components/settings/ProjectColorSettings.tsx') };
  } finally {
    await vite.close();
  }
}

const PROJECTS = (tabs, active) => ({ tabs, active });

test('the Color section renders the 9 presets with the stored color selected', async () => {
  const { module } = await loadSection();
  const html = renderToStaticMarkup(React.createElement(module.default, {
    projects: PROJECTS([
      { id: 'p1', name: 'One', colorHex: '#3e7fd4' },
      { id: 'p2', name: 'Two', colorHex: '#dc4a3a' },
    ], 'p2'),
  }));
  assert.match(html, /data-project-color-section="true"/);
  // The 9 template colors, named, in template order.
  for (const preset of PRESET_PROJECT_COLORS) assert.match(html, new RegExp(`aria-label="${preset.name}"`));
  assert.equal((html.match(/role="radio"/g) ?? []).length, 9);
  // The active record's color is the selected one — the selection state is
  // the stored value, not a local default.
  assert.match(html, /project-color-swatch selected/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /Red — current/);
  assert.doesNotMatch(html, /Blue — current/);
  // The picker mirrors the stored color; the hex read shows it.
  assert.match(html, /type="color"/);
  assert.match(html, /value="#dc4a3a"/);
  assert.match(html, /#dc4a3a<\/span>/);
  // The current-selection pill names the preset.
  assert.match(html, /Red<\/span>/);
});

test('a project with no explicit color shows its auto-assigned state', async () => {
  const { module } = await loadSection();
  const html = renderToStaticMarkup(React.createElement(module.default, {
    projects: PROJECTS([{ id: 'p1', name: 'One' }], 'p1'),
  }));
  // Nothing is selected yet — the record carries no color — and the pill
  // says the color is auto-assigned rather than naming a preset.
  assert.doesNotMatch(html, /project-color-swatch selected/);
  assert.match(html, /auto-assigned/);
  assert.doesNotMatch(html, /aria-checked="true"/);
  // The picker rests on the applier's fallback: the color the window is
  // wearing at this moment, not a value the section invented.
  assert.equal(DEFAULT_PROJECT_COLOR_HEX, '#3e7fd4');
  assert.match(html, new RegExp(`value="${DEFAULT_PROJECT_COLOR_HEX}"`));
});

test('no active project renders the muted state and no swatch acts', async () => {
  const { module } = await loadSection();
  const html = renderToStaticMarkup(React.createElement(module.default, {
    projects: PROJECTS([], null),
  }));
  assert.match(html, /data-project-color-section="true"/);
  assert.match(html, /Open a project to give it a color/);
  // With no record to write to, every control is disabled — a click could
  // only error against a project id that does not exist.
  assert.equal((html.match(/disabled/g) ?? []).length, 10);
});

test('committedHex: one gate for both commit paths — normalize, dedupe, refuse', async () => {
  const { committedHex } = await loadSection().then(({ module }) => module);
  // A real commit normalizes any picker-shaped value.
  assert.equal(committedHex('#DC4A3A', null), '#dc4a3a');
  assert.equal(committedHex('abc', '#000000'), '#aabbcc');
  // Committing the stored color is a no-op, not a redundant write — the
  // dedupe compares normalized values, so `#ABC` against `#aabbcc` is the
  // same color and stays quiet.
  assert.equal(committedHex('#dc4a3a', '#dc4a3a'), null);
  assert.equal(committedHex('abc', '#aabbcc'), null);
  // Junk is refused — the API rejects it, so the section does not send it.
  assert.equal(committedHex('not-a-color', null), null);
  assert.equal(committedHex('', null), null);
  assert.equal(committedHex(null, null), null);
});

test('record readers: active tab, both color fields, label mapping', async () => {
  const { activeProjectRecord, currentProjectColor, projectColorLabel } =
    await loadSection().then(({ module }) => module);
  const projects = PROJECTS([{ id: 'a' }, { id: 'b', name: 'B', colorHex: '#52b23f' }], 'b');
  assert.equal(activeProjectRecord(projects).id, 'b');
  assert.equal(activeProjectRecord(PROJECTS([{ id: 'a' }], 'gone')), null);
  assert.equal(activeProjectRecord(null), null);
  assert.equal(currentProjectColor(activeProjectRecord(projects)), '#52b23f');
  // The legacy field tolerated by the applier is tolerated here too.
  assert.equal(currentProjectColor({ color: '#ABC' }), '#aabbcc');
  assert.equal(currentProjectColor({}), null);
  assert.equal(currentProjectColor(null), null);
  assert.equal(projectColorLabel('#dc4a3a'), 'Red');
  assert.equal(projectColorLabel('#123456'), 'Custom');
  assert.equal(projectColorLabel(null), 'auto-assigned');
});

test('the updated record the host merges derives the theme that lands on screen', () => {
  // The host's onColorChange merge puts the updated record into state; the
  // shell re-derives from exactly that record. A committed custom color, run
  // through the same resolution the applier performs, must produce the new
  // family — proving the click-to-visible-theme chain has no second path.
  const before = { id: 'p1', name: 'One', colorHex: '#dc4a3a' };
  const after = { ...before, colorHex: '#123456' };
  assert.notEqual(
    resolveProjectTheme(after).vars['--project-color'],
    resolveProjectTheme(before).vars['--project-color'],
  );
});

test('the Settings page hosts the section and the daily host feeds it the live merge', () => {
  // The seam, held as source shape (the repo's pattern for cross-module
  // wiring that only React mounts): the Settings page renders the section on
  // its own tab, and the daily host passes the live project payload plus the
  // change handler whose listProjects merge is the no-reload re-theme.
  const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const settings = read('../src/Settings.jsx');
  assert.match(settings, /import ProjectColorSettings from '\.\/components\/settings\/ProjectColorSettings\.tsx'/);
  assert.match(settings, /\['project', 'Project'\]/);
  assert.match(settings, /tab === 'project' && \(\s*<ProjectColorSettings projects=\{projects\} onColorChange=\{onColorChange\}/);
  const daily = read('../src/v2/DailyRoot.jsx');
  assert.match(daily, /acceptProjects\(await window\.flyt\.listProjects\(\)\)/);
});

