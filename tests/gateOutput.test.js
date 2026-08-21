// What the next attempt is told when a gate goes red.
//
// Found by watching one. A task failed `npm test`, and the guidance handed to
// the retry was ten thousand characters of PASSING tests, then
// `…[255386 characters omitted]…`, then ten thousand more passing tests and
// `# fail 1`. The assertion that failed was in the omitted part. The ladder
// then escalated a band so a dearer model could read the same nothing.
//
// The old cut was head-and-tail, and its reasoning holds for a suite with
// twenty tests: first failure at the top, summary at the bottom. This suite has
// fifteen hundred, `node --test` prints an `ok` line and a YAML block for every
// one, and a failure at test 1300 is exactly what a middle-out cut deletes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGates } from '../core/gates.js';

// A TAP run big enough to need cutting, with its one failure buried in the
// middle where the old cut could not reach it.
function tapRun({ tests = 1500, failAt = 900 } = {}) {
  const lines = ['TAP version 13'];
  for (let i = 1; i <= tests; i++) {
    if (i === failAt) {
      lines.push(`not ok ${i} - a log that stops mid-step still builds`);
      lines.push('  ---');
      lines.push("  location: 'tests/traceModel.test.js:75:1'");
      lines.push('  failureType: \'testCodeFailure\'');
      lines.push('  error: |-');
      lines.push('    no response, so it is unsettled');
      lines.push('    true !== false');
      lines.push('  code: \'ERR_ASSERTION\'');
      lines.push('  ...');
      continue;
    }
    lines.push(`ok ${i} - a test that passed and is not why anybody is reading this`);
    lines.push('  ---');
    lines.push('  duration_ms: 1.2345');
    lines.push('  ...');
  }
  lines.push(`1..${tests}`, `# tests ${tests}`, '# pass ' + (tests - 1), '# fail 1');
  return lines.join('\n');
}

async function inTempRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-gate-'));
  try {
    return await fn(dir);
  } finally {
    // The child that just exited can still hold the directory on Windows for a
    // beat, and a cleanup failure must not read as a failed assertion.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* it is a temp dir */ }
  }
}

test('a failure buried in the middle of a huge suite survives the cut', async () => {
  await inTempRepo(async dir => {
    const script = path.join(dir, 'suite.js');
    fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(tapRun())});\nprocess.exit(1);\n`);

    const run = await runGates([`node ${JSON.stringify(script)}`], { cwd: dir });
    const output = run.failure.output;

    assert.ok(output.length <= 21_000, 'still bounded — it goes back to a model as guidance');
    assert.match(output, /not ok 900 - a log that stops mid-step still builds/,
      'the failing test is named');
    assert.match(output, /no response, so it is unsettled/,
      'and so is the assertion, which is the whole reason anyone reads this');
    assert.match(output, /# fail 1/, 'the summary is still at the end');
    assert.match(output, /1 failure\(s\), in full/, 'and the reader is told what they are looking at');
  });
});

test('several failures are all kept, and the ones that did not fit are counted', async () => {
  await inTempRepo(async dir => {
    const lines = ['TAP version 13'];
    for (let i = 1; i <= 400; i++) {
      lines.push(`not ok ${i} - failure number ${i}`);
      lines.push('  ---');
      lines.push(`  error: 'the ${i}th thing went wrong, at some length, ${'x'.repeat(120)}'`);
      lines.push('  ...');
    }
    lines.push('# fail 400');
    const script = path.join(dir, 'suite.js');
    fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(lines.join('\n'))});\nprocess.exit(1);\n`);

    const run = await runGates([`node ${JSON.stringify(script)}`], { cwd: dir });
    const output = run.failure.output;
    assert.ok(output.length <= 21_000);
    assert.match(output, /not ok 1 - failure number 1/);
    assert.match(output, /and \d+ more failure\(s\), not shown/,
      'a cut that silently keeps some failures is a cut that reads as "these are all of them"');
  });
});

test('output that fits is passed through untouched', async () => {
  await inTempRepo(async dir => {
    const script = path.join(dir, 'suite.js');
    fs.writeFileSync(script, 'process.stdout.write("not ok 1 - small\\n# fail 1\\n");process.exit(1);');
    const run = await runGates([`node ${JSON.stringify(script)}`], { cwd: dir });
    assert.equal(run.failure.output, 'not ok 1 - small\n# fail 1\n');
  });
});

test('a runner that is not TAP still gets its error lines kept', async () => {
  await inTempRepo(async dir => {
    const noise = Array.from({ length: 4000 }, (_, i) => `  compiled module ${i} with nothing to say`);
    noise.splice(2000, 0, "src/thing.ts(41,7): error TS2322: Type 'string' is not assignable to type 'number'.");
    const script = path.join(dir, 'suite.js');
    fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(noise.join('\n'))});\nprocess.exit(2);\n`);

    const run = await runGates([`node ${JSON.stringify(script)}`], { cwd: dir });
    assert.match(run.failure.output, /error TS2322/,
      'the compiler line is the finding, wherever in the log it fell');
  });
});
