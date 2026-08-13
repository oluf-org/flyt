// Probe: core/textUtils.js#truncateMiddle (benchmark/pure-function.bench.md).
//
// The independent opinion. The gates already said "the suite is green", but the
// suite is part of the repo the task was editing — this runs from outside and
// asks whether the thing the case described actually exists and behaves.
//
// Every assertion here appears in the case's "Done when" in the same words. A
// probe that checks something the case never asked for is measuring luck.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fail = msg => { console.error(`probe: ${msg}`); process.exit(1); };

const file = path.join(root, 'core', 'textUtils.js');
if (!fs.existsSync(file)) fail('core/textUtils.js does not exist');

const mod = await import(pathToFileURL(file).href).catch(err => fail(`could not import it: ${err.message}`));
if (typeof mod.truncateMiddle !== 'function') fail('core/textUtils.js does not export truncateMiddle');

const { truncateMiddle } = mod;

if (truncateMiddle('hello', 10) !== 'hello') fail('short text was not returned unchanged');

const long = 'abcdefghijklmnopqrstuvwxyz';
const cut = truncateMiddle(long, 12);
if (typeof cut !== 'string') fail('it did not return a string');
if (cut.length > 12) fail(`the result is ${cut.length} characters against a max of 12`);
if (cut === long) fail('it returned the input unchanged for text longer than max');
if (!cut.startsWith('a')) fail(`the head was lost: ${JSON.stringify(cut)}`);
if (!cut.endsWith('z')) fail(`the tail was lost: ${JSON.stringify(cut)}`);

// "with tests" is half the case, so it is half the probe.
const testDir = path.join(root, 'tests');
const tests = fs.existsSync(testDir) ? fs.readdirSync(testDir).filter(f => f.endsWith('.test.js')) : [];
const covered = tests.some(f => fs.readFileSync(path.join(testDir, f), 'utf8').includes('truncateMiddle'));
if (!covered) fail('no file under tests/ exercises truncateMiddle');

console.log('probe: ok');
