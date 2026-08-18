// Setup: seed the defect for benchmark/fix-duration.bench.md.
//
// Runs in the throwaway clone before the loop starts, and is committed into the
// baseline — a seeded failure that is not committed is a failure the task never
// sees, because every worktree branches from the base commit.
//
// It adds a module AND a test that passes anyway. Both halves matter: a bug
// nobody's tests cover is the realistic case, and "the suite is green" being
// insufficient evidence is the exact lesson the loop keeps having to learn
// (`DESIGN-SPEC.md` §8). It touches nothing that already exists, so the
// baseline stays green and the other cases are scored on their own merits.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const module_ = `// Short durations, the way the CLI writes them: 30m, 24h, 7d.
//
// One parser rather than a regex per call site — \`flyt spend --since\` grew its
// own and only ever handled hours.
const UNITS = {
  s: 1000,
  m: 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000
};

/**
 * Milliseconds for a short duration, or null when it cannot be read.
 *
 * Null rather than a throw, and null rather than a default: a caller that got a
 * duration it did not ask for cannot tell that anything went wrong.
 */
export function parseDuration(text) {
  const m = /^(\\d+)([smhd])$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * UNITS[m[2]];
}
`;

const test = `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../core/duration.js';

test('parseDuration reads hours', () => {
  assert.equal(parseDuration('1h'), 3600000);
  assert.equal(parseDuration('24h'), 86400000);
});

test('parseDuration returns null for anything it cannot read', () => {
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(null), null);
});
`;

fs.mkdirSync(path.join(root, 'core'), { recursive: true });
fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
fs.writeFileSync(path.join(root, 'core', 'duration.js'), module_);
fs.writeFileSync(path.join(root, 'tests', 'duration.test.js'), test);
console.log('setup: seeded core/duration.js and tests/duration.test.js');
