// A flag the CLI cannot use is refused, not ignored (HT-04).
//
// `flyt task list --stauts queued` used to run and list everything. The sharp
// version is `--capusd 2`, which is an unbounded loop rather than a $2 one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkFlags } from '../bin/flyt.js';

const cli = fileURLToPath(new URL('../bin/flyt.js', import.meta.url));
const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('a mistyped flag is refused, and told what it probably meant', () => {
  assert.match(checkFlags('task', { stauts: 'queued' }), /Unknown flag "--stauts"\. Did you mean "--status"\?/);
  assert.match(checkFlags('loop', { capusd: '2' }), /Did you mean "--cap-usd"\?/);
  assert.match(checkFlags('loop', { 'soft-usdd': '2' }), /Did you mean "--soft-usd"\?/);
});

test('a flag nothing resembles is refused without a guess', () => {
  const message = checkFlags('task', { xyzzyplugh: '1' });
  assert.match(message, /Unknown flag "--xyzzyplugh"/);
  assert.ok(!/Did you mean/.test(message), `no useful guess exists: ${message}`);
});

test('a cap that is not a number is refused rather than becoming no cap', () => {
  assert.match(checkFlags('loop', { 'cap-usd': 'abc' }), /--cap-usd takes a number, and was given "abc"/);
  assert.match(checkFlags('loop', { 'cap-usd': true }), /takes a number, and was given nothing/);
  assert.match(checkFlags('loop', { 'cap-usd': ['1', '2'] }), /given more than once/);
  assert.equal(checkFlags('loop', { 'cap-usd': '2' }), null);
  assert.equal(checkFlags('loop', { 'cap-usd': '0' }), null, 'zero is a real ceiling');
});

test('global flags work everywhere, command flags work where they belong', () => {
  assert.equal(checkFlags('runs', { json: true, project: '.' }), null);
  assert.equal(checkFlags('task', { status: 'queued' }), null);
  assert.equal(checkFlags('loop', { only: 't-1', parallel: '2', models: 'low=a' }), null);
  assert.match(checkFlags('runs', { probe: true }), /Unknown flag "--probe"/);
});

test('every flag the help documents is accepted where it is documented', () => {
  // The help text is the contract a person reads. If the table and the help
  // disagree, one of them is lying, and this is the cheapest place to find out.
  const source = fs.readFileSync(cli, 'utf8');
  const usage = source.slice(source.indexOf('const USAGE = `'), source.indexOf('`;', source.indexOf('const USAGE = `')));

  let command = null;
  const problems = [];
  for (const line of usage.split('\n')) {
    const entry = /^ {2}flyt ([a-z:]+)/.exec(line);
    if (entry) command = entry[1];
    else if (/^ {2}\S/.test(line)) command = null;              // a heading, e.g. "Options"
    if (!command) continue;
    for (const [, flag] of line.matchAll(/--([a-zA-Z][a-zA-Z-]*)/g)) {
      const message = checkFlags(command, { [flag]: 'x' });
      // A numeric complaint means the flag IS accepted, which is what is under test.
      if (message && /Unknown flag/.test(message)) problems.push(`flyt ${command} --${flag}`);
    }
  }
  assert.deepEqual(problems, [], 'documented but not accepted');
});

test('the refusal happens before anything is bound or spent', () => {
  const bad = run(['loop', 'start', '--capusd', '2']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr + bad.stdout, /Unknown flag "--capusd"/);
  assert.ok(!/loop started/.test(bad.stdout), 'and no loop was started');

  const good = run(['task', 'list', '--status', 'queued', '--json']);
  assert.equal(good.status, 0, good.stderr);
});
