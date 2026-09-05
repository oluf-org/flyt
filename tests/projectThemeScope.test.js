import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('project identity does not override the Slate & Sage page palette', () => {
  const sheet = read('../src/styles/project-theme.css');
  const baseTokens = [
    'accent', 'accent-soft', 'accent-fill', 'accent-tx', 'on-accent',
    'canvas', 'app', 'rail', 'side', 'card', 'border', 'divider', 'dot',
    'chip', 'chip-tx', 'tx', 'dim', 'faint', 'app-tx', 'app-dim',
  ];
  for (const token of baseTokens) {
    assert.doesNotMatch(sheet, new RegExp(`^\\s*--${token}\\s*:`, 'm'), `--${token} stays on the app palette`);
  }
  assert.match(sheet, /\.v2-shell-nav\s*\{[^}]*--project-color/s);
  assert.match(sheet, /\.lander-greeting \.logo-mark-wrap/);
  assert.match(sheet, /\.lander-title \.mono/);
});

test('project tabs use marks, faded backgrounds, and an active-color connection', () => {
  const component = read('../src/TabStrip.jsx');
  const styles = read('../src/styles.css');
  assert.match(component, /<LogoMark size=\{14\}/);
  assert.match(component, /--tab-project-color/);
  assert.doesNotMatch(styles, /\.tab::before/);
  assert.match(styles, /\.tab\s*\{[^}]*color-mix\(in srgb, var\(--tab-project-color\) 16%, var\(--app\)\)/s);
  assert.match(styles, /\.tab\.active\s*\{[^}]*background: var\(--tab-project-color\)/s);
  assert.match(styles, /\.tab-strip\s*\{[^}]*padding: 5px 0 0/s);
  assert.match(styles, /\.v2-shell-nav\s*\{[^}]*border-bottom: 2px solid var\(--accent\)/s);
});

test('native titlebar calls stay on the app palette for active projects', () => {
  const shell = read('../src/v2/Shell.jsx');
  assert.doesNotMatch(shell, /setTitleBarTheme\?\.\(mode, vars\[/);
  assert.match(shell, /applyProjectTheme\(activeProject\);[\s\S]*setTitleBarTheme\?\.\(mode, null\)/);
});
