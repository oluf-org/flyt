// A flag the CLI cannot use is refused, not ignored (HT-04).
//
// `flyt task list --stauts queued` used to run and list everything. The sharp
// version is `--capusd 2`, which is an unbounded loop rather than a $2 one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkFlags, renderWhy } from '../bin/flyt.js';

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

// A diagnostic that names a command must name one that exists.
//
// `flyt doctor` told people to run `flyt incident resolve <id>` from the day
// incidents landed. The API handler existed; the CLI command did not, so the
// answer was "Unknown command \"incident\"". An operator who is told to run
// something that does not exist stops believing the diagnostics — which is
// expensive for a subsystem whose entire job is to be believed.
test('every flyt command a diagnostic advertises is a command', () => {
  const source = fs.readFileSync(cli, 'utf8');
  // The switch is the list. Reading it from the file keeps this honest when a
  // command is added or removed, instead of pinning a copy that goes stale.
  const known = new Set([...source.matchAll(/^ {4}case '([a-z:]+)':/gm)].map(m => m[1]));
  assert.ok(known.size > 15, `expected the command switch, found ${known.size}`);

  const dir = fileURLToPath(new URL('../core', import.meta.url));
  const files = fs.readdirSync(dir, { recursive: true })
    .filter(f => String(f).endsWith('.js'))
    .map(f => path.join(dir, String(f)));

  const problems = [];
  for (const file of files) {
    for (const [, verb] of fs.readFileSync(file, 'utf8').matchAll(/\bflyt ([a-z][a-z:]*)/g)) {
      if (!known.has(verb)) problems.push(`${path.basename(file)}: "flyt ${verb}"`);
    }
  }
  assert.deepEqual([...new Set(problems)], [], 'advertised but not implemented');
});

test('the refusal happens before anything is bound or spent', () => {
  const bad = run(['loop', 'start', '--capusd', '2']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr + bad.stdout, /Unknown flag "--capusd"/);
  assert.ok(!/loop started/.test(bad.stdout), 'and no loop was started');

  const good = run(['task', 'list', '--status', 'queued', '--json']);
  assert.equal(good.status, 0, good.stderr);
});

// `flyt retry` (t-0088). `run:restartNode` has existed since D39 and the only
// door to it was the generic `flyt call`, which printed ok:true the instant the
// walk relaunched and returned — so the relaunched run survived only as long as
// nothing closed stdout, and piping the output to `head` killed it silently.
test('flyt retry is a command, takes its flags, and is documented', () => {
  const source = fs.readFileSync(cli, 'utf8');
  assert.match(source, /^ {4}case 'retry': \{$/m, 'the command exists');
  for (const flag of ['guidance', 'model', 'gates']) {
    assert.equal(checkFlags('retry', { [flag]: 'x' }), null, `--${flag}`);
  }
  assert.equal(checkFlags('retry', { timeout: '2400' }), null, '--timeout is a number');
  assert.match(checkFlags('retry', { guidence: 'x' }), /Did you mean "--guidance"\?/);
});

test('flyt retry refuses a missing argument, and a run that is not there', () => {
  // `die` exits 1; the pre-flight flag refusal is what exits 2.
  const noArgs = run(['retry']);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr + noArgs.stdout, /flyt retry <runId> <nodeId>/);

  const noNode = run(['retry', 'some-run']);
  assert.equal(noNode.status, 1, 'a runId alone is not enough');

  // The runner's own message, not a stack trace. This used to be an ENOENT
  // naming an internal .flyt path.
  const missing = run(['retry', 'no-such-run-xyz', 'work']);
  assert.equal(missing.status, 1);
  const said = missing.stderr + missing.stdout;
  assert.match(said, /No run "no-such-run-xyz"/);
  assert.ok(!/ENOENT|at .*\.js:\d+/.test(said), `no stack trace:\n${said}`);
});

// A repeat is the same defect wearing different clothes: the flag is spelled
// right, the command runs, and the value is not what was written. `--goal`
// twice produced the brief "first,second" — `String(['first','second'])` —
// and the worker read that as the task.
test('a repeated flag that takes one value is refused, not joined', () => {
  assert.match(checkFlags('task', { goal: ['first', 'second'] }),
    /--goal was given more than once; it takes one value\./);
  assert.match(checkFlags('task', { status: ['queued', 'landed'] }), /given more than once/);
  assert.match(checkFlags('loop', { 'cap-usd': ['1', '2'] }), /it takes one number\./,
    'a number says number');
});

test('the flags documented as repeatable still repeat', () => {
  assert.equal(checkFlags('task', { done: ['one', 'two'] }), null);
  assert.equal(checkFlags('task', { skill: ['a', 'b'] }), null);
  assert.equal(checkFlags('call', { arg: ['k=v', 'j=w'] }), null);
  assert.equal(checkFlags('run', { in: ['repo=x', 'ref=y'] }), null);
  assert.equal(checkFlags('loop', { only: ['t-1', 't-2'] }), null);
});

test('a repeated --goal never reaches the task file', () => {
  const bad = run(['task', 'add', 'scratch repeat probe', '--goal', 'first', '--goal', 'second']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr + bad.stdout, /--goal was given more than once/);
  assert.ok(!/queued t-/.test(bad.stderr + bad.stdout), 'and no task was written');
});

// A flag the CLI consumes itself must never arrive as an argument.
//
// `flyt call` copied every parsed flag into the command's arguments and skipped
// only json, project and arg. `--arg-json` was added later and never added to
// that list, so it arrived as an argument named "arg-json" — and `task:update`
// preserves fields it does not recognise on purpose, so the flag's own name
// became a frontmatter field in the task file and stayed there. Four tasks in
// this project's backlog were found carrying one.
test('flyt call does not write its own flags into the target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-call-'));
  const added = run(['task', 'add', 'arg-json probe', '--goal', 'x', '--project', dir]);
  const id = (added.stdout.match(/t-\d{4}/) ?? [])[0];
  assert.ok(id, `expected a queued task: ${added.stdout}${added.stderr}`);

  const out = run(['call', 'task:update', '--arg', `id=${id}`,
    '--arg-json', 'gates=["npm test"]', '--project', dir]);
  assert.equal(out.status, 0, out.stderr);

  const file = fs.readFileSync(path.join(dir, '.flyt', 'backlog', `${id}.task.md`), 'utf8');
  assert.match(file, /gates: \[npm test\]/, 'the argument it was given still lands');
  assert.ok(!/^arg-json:/m.test(file), `the flag itself must not become a field:\n${file}`);
});

// --- `flyt why` on a run that is waiting for a decision ---------------------
//
// This is a rendering feature, so what it renders is the thing to test, and
// nothing could until renderWhy was exported. The first version said "is
// waiting for your decision" two lines below a verdict line that already said
// "waiting for your decision" — in the command whose entire job is to be read.

const whyReport = gate => ({
  runId: 'run-1', verdict: 'waiting for your decision', flow: 'Spec an idea',
  gate, nodes: [], suggestions: [],
  signals: { modelCalls: 9, modelMs: 73200, toolCalls: 17, usd: '0.004', tools: [] },
});

test('flyt why: an approval gate leads with the decision, and says it once', () => {
  const out = renderWhy(whyReport({
    kind: 'pre', meaning: 'a checkpoint: this node asks before it runs',
    node: 'plan', title: 'What this becomes',
  }));

  assert.match(out, /"What this becomes"/, 'the title, not the node id');
  assert.match(out, /a checkpoint: this node asks before it runs/);
  assert.equal(out.split('waiting for your decision').length - 1, 1,
    'the verdict line already said it; saying it again buries the point');
  // The two things the reader came for.
  assert.match(out, /flyt approve run-1/);
  assert.match(out, /flyt reject {2}run-1/);
  assert.ok(out.indexOf('flyt approve') < out.indexOf('9 model call'),
    'the decision comes before the machinery');
});

test('flyt why: a held tool call says what it wanted to do', () => {
  const out = renderWhy(whyReport({
    kind: 'tool', meaning: 'a tool call was held at the ceiling before it ran',
    node: 'work', title: 'Do the work',
    tool: 'bash', summary: 'rm -rf ./build', risk: 'high',
    reason: 'destructive under approvalMode ask', checkedBy: 'screen',
  }));

  assert.match(out, /tool: bash \(risk: high\)/);
  assert.match(out, /it wants to: rm -rf \.\/build/);
  assert.match(out, /why it stopped: destructive under approvalMode ask/);
  assert.match(out, /screened by: screen/);
});

test('flyt why: an escalation says a human was asked, and quotes why', () => {
  const out = renderWhy(whyReport({
    kind: 'escalation', meaning: 'an evaluation concluded a human has to decide',
    node: 'seval', title: 'Check it', reason: 'three retries still fail lint',
  }));

  assert.match(out, /a human was asked to decide how to proceed/);
  assert.match(out, /why: three retries still fail lint/);
});

test('flyt why: a run with no gate renders none of it', () => {
  const out = renderWhy({
    runId: 'run-1', verdict: 'completed', nodes: [], suggestions: [],
    signals: { modelCalls: 1, modelMs: 10, toolCalls: 0, usd: null, tools: [] },
  });
  assert.ok(!/flyt approve/.test(out), out);
});
