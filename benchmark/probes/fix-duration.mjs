// Probe: core/duration.js#parseDuration (benchmark/fix-duration.bench.md).
//
// The seeded defect is that a minute is computed as an hour, and the seeded
// test passes anyway. So this probe checks the units the existing test does not
// — which is the whole shape of the case.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fail = msg => { console.error(`probe: ${msg}`); process.exit(1); };

const file = path.join(root, 'core', 'duration.js');
if (!fs.existsSync(file)) fail('core/duration.js is gone — the fix was supposed to keep it');

const mod = await import(pathToFileURL(file).href).catch(err => fail(`could not import it: ${err.message}`));
if (typeof mod.parseDuration !== 'function') fail('core/duration.js no longer exports parseDuration');

const { parseDuration } = mod;

for (const [input, expected] of [['45s', 45000], ['30m', 1800000], ['2h', 7200000], ['1d', 86400000]]) {
  const got = parseDuration(input);
  if (got !== expected) fail(`parseDuration(${JSON.stringify(input)}) = ${got}, expected ${expected}`);
}

for (const bad of ['soon', '', null, undefined, '5x']) {
  let got;
  try { got = parseDuration(bad); }
  catch (err) { fail(`parseDuration(${JSON.stringify(bad)}) threw: ${err.message}`); }
  if (got !== null) fail(`parseDuration(${JSON.stringify(bad)}) = ${got}, expected null`);
}

// The other half of the case: the hole in the coverage is closed, so this
// cannot silently break again.
const testFile = path.join(root, 'tests', 'duration.test.js');
if (!fs.existsSync(testFile)) fail('tests/duration.test.js is gone');
const text = fs.readFileSync(testFile, 'utf8');
if (!/'\d+m'|"\d+m"/.test(text)) fail('tests/duration.test.js still does not exercise minutes');
if (!/'\d+s'|"\d+s"/.test(text)) fail('tests/duration.test.js still does not exercise seconds');

console.log('probe: ok');
