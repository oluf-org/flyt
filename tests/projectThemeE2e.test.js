// Acceptance driver for the per-project theming feature.
//
// Two TypeScript specs hold what the feature's acceptance rests on:
//   e2e/project-theme.spec.ts      — the five acceptance criteria, end to end
//   src/lib/projectTheme.test.ts   — the derivation module's own invariants
//
// They are TypeScript, like the app's own renderer modules (.tsx), but Node
// 22.12's `node --test` parses neither .ts nor JSX and the repo ships no TS
// runner — so this driver loads each spec through the same vite the app ships
// (ssrLoadModule, the pattern the .tsx settings-section tests already use) and
// runs every check as a subtest. One driver, fully executed and reported by
// the gate.
//
// Each test loads its spec through a fresh vite server and registers its
// checks as subtests INSIDE the async body (tests registered after a load
// resolves are not collected by this runner), so every check is an awaited
// subtest with its own pass/fail and message in the TAP output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createViteServer } from 'vite';

async function loadModule(path) {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    return await vite.ssrLoadModule(path);
  } finally {
    await vite.close();
  }
}

// The five acceptance criteria, in order. Titles are the report.
const CHECKS = [
  ['criterion 1: two projects with different colors are distinguishable at a glance', 'checkTwoProjectsDistinguishable'],
  ['criterion 2: auto-assignment rarely collides while unused presets remain', 'checkAutoAssignment'],
  ['criterion 3: any preset or arbitrary custom color yields a coherent theme', 'checkAnyColorCoherentTheme'],
  ['criterion 4: a color change in settings persists and applies immediately', 'checkSettingsPersistsAndAppliesImmediately'],
  ['criterion 5: existing settings and project flows show no regressions', 'checkNoRegressions'],
];

test('the acceptance spec (e2e/project-theme.spec.ts) exports every criterion check', async (t) => {
  const spec = await loadModule('/e2e/project-theme.spec.ts');
  for (const [title, name] of CHECKS) {
    assert.equal(typeof spec[name], 'function', `the spec exports ${name}`);
    // Deferred registration: the subtests run here, awaited, so the criterion
    // fails THIS test — visibly — when it fails.
    await t.test(title, spec[name]);
  }
});

test('the unit spec (src/lib/projectTheme.test.ts) holds the derivation invariants', async (t) => {
  const unit = await loadModule('/src/lib/projectTheme.test.ts');
  const checks = Object.entries(unit)
    .filter(([name, value]) => name.startsWith('check') && typeof value === 'function');
  assert.ok(checks.length >= 10, `the unit spec exports its checks (found ${checks.length})`);
  assert.ok(checks.every(([, check]) => typeof check === 'function'));
  for (const [name, check] of checks) {
    await t.test(name, check);
  }
});
