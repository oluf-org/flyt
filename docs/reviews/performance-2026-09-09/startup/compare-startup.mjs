import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const file = 'kernel/dist/api/contract.js';
const after = fs.readFileSync(file, 'utf8');
const before = after.replace(/    \/\/ Build's legacy commands[\s\S]*?    try \{/, '    try {');
assert(before !== after && before.includes('new Ajv2020'));
const run = (label, large, cpu) => {
  const result = spawnSync(process.execPath, ['scripts/profile-app.mjs'], { stdio: 'inherit', windowsHide: true,
    env: { ...process.env, FLYT_PERF_CPU: cpu ? '1' : '0', FLYT_PERF_RUNS: large ? '10' : '100', FLYT_PERF_CHUNKS: large ? '2000' : '200', FLYT_PERF_TOOL_BYTES: large ? '2097152' : '0', FLYT_PERF_OUTPUT: `.flyt/performance/${label}.json` } });
  assert.equal(result.status, 0, label);
};
try {
  for (const large of [false, true]) {
    for (let repeat = 1; repeat <= 3; repeat++) {
      // Alternate which variant runs first to reduce ordering bias.
      for (const variant of repeat % 2 ? ['before', 'after'] : ['after', 'before']) {
        fs.writeFileSync(file, variant === 'before' ? before : after);
        run(`startup-final-${large ? 'large' : '100'}-${variant}-${repeat}`, large, false);
      }
    }
  }
} finally { fs.writeFileSync(file, after); }
