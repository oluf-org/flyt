// A queue can be wedged by one task, and say nothing useful about it.
//
// Found by trying to work this project's own backlog and getting "nothing
// ready" with four queued tasks in it:
//
//   t-0038 → t-0037 (parked)
//   t-0039 → t-0038
//   t-0040 → t-0039
//   t-0008 → t-0006 (removed weeks earlier, after spending $2.29)
//
// Every one of those was reported correctly and individually, and the two facts
// that mattered — one parked task is holding up the whole v2 chain, and one
// dependency does not exist at all — had to be assembled by hand from four
// separate lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Backlog } from '../core/backlog.js';
import { whyNothingReady, blockingRoot, blockersFor } from '../core/blockers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-wedge-'));
const makeBacklog = () => new Backlog(path.join(tmp(), 'backlog'));

// --- removing a task strands whatever depended on it -----------------------

test('removing a task reports what it just made unclaimable', () => {
  const backlog = makeBacklog();
  const base = backlog.add({ title: 'The thing everything needs', goal: 'g' });
  const a = backlog.add({ title: 'Depends on it', goal: 'g' });
  const b = backlog.add({ title: 'Also depends on it', goal: 'g' });
  backlog.update(a.id, { dependsOn: [base.id] });
  backlog.update(b.id, { dependsOn: [base.id] });

  const removed = backlog.remove(base.id);
  assert.equal(removed.removed ?? removed.id, base.id);
  assert.deepEqual(removed.stranded.map(s => s.id).sort(), [a.id, b.id].sort(),
    'both dependents can never become ready again, and this is the moment to say so');

  // And it is true: the picker will never take them.
  assert.equal(backlog.score(backlog.get(a.id)), 0);
  assert.equal(backlog.score(backlog.get(b.id)), 0);
});

test('a task nothing depends on strands nobody, and a landed dependent is not stranded', () => {
  const backlog = makeBacklog();
  const base = backlog.add({ title: 'Lonely', goal: 'g' });
  const done = backlog.add({ title: 'Already finished', goal: 'g' });
  backlog.update(done.id, { dependsOn: [base.id], status: 'landed' });

  const removed = backlog.remove(base.id);
  assert.deepEqual(removed.stranded, [],
    'a task that already landed is not waiting for anything');
});

// --- "nothing ready" names the task actually holding things up -------------

test('a chain of blocked tasks is reported by its root, not one link at a time', () => {
  const backlog = makeBacklog();
  const keystone = backlog.add({ title: 'Phase 2', goal: 'g' });
  const p3 = backlog.add({ title: 'Phase 3', goal: 'g' });
  const p4 = backlog.add({ title: 'Phase 4', goal: 'g' });
  const p5 = backlog.add({ title: 'Phase 5', goal: 'g' });
  backlog.update(keystone.id, { status: 'parked', blockedReason: 'needs a person' });
  backlog.update(p3.id, { dependsOn: [keystone.id] });
  backlog.update(p4.id, { dependsOn: [p3.id] });
  backlog.update(p5.id, { dependsOn: [p4.id] });

  const tasks = backlog.list();
  const byId = new Map(tasks.map(t => [t.id, t]));

  // The walk itself: every one of them is really waiting on the keystone.
  assert.equal(blockingRoot(byId.get(p3.id), byId), keystone.id);
  assert.equal(blockingRoot(byId.get(p4.id), byId), keystone.id, 'two hops away');
  assert.equal(blockingRoot(byId.get(p5.id), byId), keystone.id, 'three hops away');

  const line = whyNothingReady({ tasks });
  assert.match(line, /3 of them behind/);
  assert.match(line, new RegExp(keystone.id));
  assert.match(line, /parked/, 'and why it is not going to resolve on its own');
  // The old line named p3's, p4's and p5's immediate dependency and never the
  // one task that would free all three.
  assert.ok(!line.includes(p4.id), 'the links in the middle are not the news');
});

test('a missing dependency is named as missing, not as something to wait for', () => {
  const backlog = makeBacklog();
  const orphan = backlog.add({ title: 'Waiting for a ghost', goal: 'g' });
  const other = backlog.add({ title: 'Also waiting for it', goal: 'g' });
  backlog.update(orphan.id, { dependsOn: ['t-9999'] });
  backlog.update(other.id, { dependsOn: ['t-9999'] });

  const tasks = backlog.list();
  const byId = new Map(tasks.map(t => [t.id, t]));
  assert.equal(blockingRoot(byId.get(orphan.id), byId), 't-9999');

  const line = whyNothingReady({ tasks });
  assert.match(line, /t-9999/);
  assert.match(line, /missing/, 'a task that does not exist never lands, and the queue has to say so');
});

test('one blocked task still reads the way it always did', () => {
  const backlog = makeBacklog();
  const parked = backlog.add({ title: 'Stuck', goal: 'g' });
  const waiting = backlog.add({ title: 'Waiting', goal: 'g' });
  backlog.update(parked.id, { status: 'parked' });
  backlog.update(waiting.id, { dependsOn: [parked.id] });

  const line = whyNothingReady({ tasks: backlog.list() });
  // Nothing is gained by saying "1 of them behind X" when there is one.
  assert.match(line, /1 task\(s\) blocked/);
  assert.ok(!/of them behind/.test(line));
});

test('a dependency cycle does not send the walk round forever', () => {
  const backlog = makeBacklog();
  const a = backlog.add({ title: 'A', goal: 'g' });
  const b = backlog.add({ title: 'B', goal: 'g' });
  backlog.update(a.id, { dependsOn: [b.id] });
  backlog.update(b.id, { dependsOn: [a.id] });

  const tasks = backlog.list();
  const byId = new Map(tasks.map(t => [t.id, t]));
  // Whatever it answers, it answers — a ring is `dep-cycle`'s business and this
  // must not be what hangs the report.
  assert.doesNotThrow(() => blockingRoot(byId.get(a.id), byId));
  assert.doesNotThrow(() => whyNothingReady({ tasks }));
  assert.ok(blockersFor(byId.get(a.id), { tasks }).some(x => x.kind === 'dep-cycle'),
    'the ring is still reported as a ring');
});

// --- a park notice quotes a reason, it does not reprint one ----------------

// Live, from the run that proved the correction path: t-0037 hit its per-task
// cap while holding gate feedback as its reason, and the park line ran to
// thirty lines — the failing tests, then "do not delete tests to go green",
// then "run the gate yourself before you finish", all addressed to a model that
// was not going to read it, in a notice whose whole job was to say the money
// ran out.
//
// The feedback is written for two readers and opens with a summary sentence
// exactly so that anything quoting it can take one line.
test('a budget park quotes one sentence of the work reason, not the whole brief', async () => {
  const { Supervisor } = await import('../core/supervisor.js');
  const { assessRepair } = await import('../core/repair.js');

  const backlog = makeBacklog();
  const task = backlog.add({ title: 'Expensive', goal: 'g' });

  const tap = ['TAP version 13', 'not ok 1 - a thing works', '  ---',
    "  location: 'tests/thing.test.js:5:1'", "  failureType: 'testCodeFailure'",
    '  error: |-', '    true !== false', "  code: 'ERR_ASSERTION'", '  ...',
    '1..1', '# tests 1', '# fail 1'].join('\n');
  const assessment = assessRepair({
    failure: { command: 'npm test', status: 'fail', code: 1, ms: 900, output: tap },
    changedFiles: ['tests/thing.test.js'], repairs: 0
  });
  assert.ok(assessment.feedback.length > 800, 'the brief really is long');
  backlog.update(task.id, { blockedReason: assessment.feedback, attempts: 1 });

  const lines = [];
  const sup = new Supervisor({
    invoke: async () => { throw new Error('should not run'); },
    projectId: 'p', backlog, pollMs: 1, log: line => lines.push(line),
    // A ledger that says this task has already spent its allowance.
    ledger: { totals: () => ({ usd: 5 }), check: () => ({ action: null }) },
    config: { loop: { caps: { taskUsd: 1 } } }
  });
  await sup.run();

  const park = lines.find(l => l.includes('parked'));
  assert.ok(park, 'it parked on the money');
  assert.match(park, /per-task cap/);
  assert.match(park, /rejected on the work, not the money/,
    'the work reason is still preserved — that is what stops a budget park erasing why');
  assert.match(park, /a thing works|failures/, 'and it still says what that reason was');
  assert.ok(!park.includes('\n'), 'but it is ONE line');
  assert.ok(!/do not delete/i.test(park), 'instructions for the model do not belong in a park notice');
  assert.ok(park.length < 500, `a park notice a person can read (was ${park.length})`);
});

// --- a session cap counts this session's money (D67) ------------------------

// The one place the session/window distinction had not reached. `#checkBudget`
// draws it; the pre-flight affordability check did not, so it measured a task's
// WHOLE LIFE against a cap named at `loop start`.
//
// Live, on the task this correction mechanism was built for: t-0037 had cost
// $2.39 across three attempts over an afternoon. A fresh loop with
// `--task-usd 2` parked it in the same second it picked it up — no run, no
// spend — reporting "Spent $2.39 of its $2 per-task cap". A task therefore
// became permanently unworkable at any session cap below what it had ever
// cost, and the more it was worked the more certainly it could never be worked
// again.
test('a per-task session cap does not count money this session never spent', async () => {
  const { Supervisor } = await import('../core/supervisor.js');
  const { Ledger } = await import('../core/ledger.js');

  const backlog = makeBacklog();
  const task = backlog.add({ title: 'Expensive history', goal: 'g' });
  backlog.update(task.id, { attempts: 3 });

  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  // Yesterday's money, on this task.
  ledger.record({ taskId: task.id, usd: 2.39, estimated: false,
    at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() });

  const started = [];
  const invoke = async (name, args) => {
    if (name === 'work:start') { started.push(args.taskId); return { dir: '/tmp/wt', branch: 'b', attemptId: 'a1' }; }
    if (name === 'flow:run') return 'run-1';
    if (name === 'work:touch') return { touched: true };
    if (name === 'run:snapshot') {
      return { meta: { stage: 'done', nodeStatus: { 'work-1': 'done' } },
        prompt: '', nodeOutputs: { 'work-1': 'x' }, retrospectives: {} };
    }
    if (name === 'work:land') {
      backlog.update(args.taskId, { status: 'landed', blockedReason: null });
      return { landed: true, stage: 'landed', mergeSha: 'abc12345' };
    }
    if (name === 'work:discard') { backlog.release(args.taskId, { status: args.status ?? null }); return { removed: true }; }
    throw new Error(`unexpected ${name}`);
  };

  const lines = [];
  const sup = new Supervisor({
    invoke, projectId: 'p', backlog, ledger, pollMs: 1, log: l => lines.push(l),
    // A cap named at `loop start` — the session kind.
    config: { loop: { caps: { taskUsd: 2 }, sessionCaps: { taskUsd: 2 } } }
  });
  await sup.run();

  assert.deepEqual(started, [task.id],
    'this session has spent nothing on it, so it can afford an attempt');
  assert.ok(!lines.some(l => /per-task cap/.test(l)),
    `no cap should have tripped — got:\n${lines.join('\n')}`);
  assert.equal(backlog.get(task.id).status, 'landed');
});

test('a STANDING per-task cap still counts the rolling window', async () => {
  const { Supervisor } = await import('../core/supervisor.js');
  const { Ledger } = await import('../core/ledger.js');

  const backlog = makeBacklog();
  const task = backlog.add({ title: 'Already spent', goal: 'g' });
  backlog.update(task.id, { attempts: 3 });

  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: task.id, usd: 2.39, estimated: false });

  const lines = [];
  const sup = new Supervisor({
    invoke: async () => { throw new Error('should not run'); },
    projectId: 'p', backlog, ledger, pollMs: 1, log: l => lines.push(l),
    // No sessionCaps: this is a guard standing in the project's config.
    config: { loop: { caps: { taskUsd: 2 } } }
  });
  await sup.run();

  const park = lines.find(l => /per-task cap/.test(l));
  assert.ok(park, 'a standing cap that has genuinely been reached still parks the task');
  assert.match(park, /in the last/, 'and says which span it counted');
  assert.equal(backlog.get(task.id).status, 'parked');
});

// --- a documented command that does not run ---------------------------------

// `npm run flow -- lint` is what CLAUDE.md tells contributors to run after
// changing shipped flows, the DSL, template resolution, or tool-grant linting.
// It printed a usage line and exited 2.
//
// Everybody who followed the instruction got an error, and t-0037 — which put
// the documented command in its `gates` — was unlandable by construction: no
// diff could ever make it pass, and the failure said nothing about any flow.
// `gateProblem` checks that a gate's INTERPRETER exists, which `npm` does;
// nothing checks that the command is well-formed, and nothing can in general.
// So the command is what had to change.
test('the documented bare `flow lint` lints every shipped flow', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');

  const bare = await run(process.execPath, ['core/flowlang/cli.js', 'lint', '--json'], { cwd: repo, maxBuffer: 8e6 });
  const all = JSON.parse(bare.stdout);
  assert.equal(all.ok, true, 'this repository ships flows that lint clean');
  assert.ok(Array.isArray(all.files) && all.files.length > 1,
    'the bare form covers the whole shipped library, not one file');

  // And one file keeps exactly the shape it had — this is a CI surface.
  const one = await run(process.execPath,
    ['core/flowlang/cli.js', 'lint', 'flows/loop-task.flow.yaml', '--json'], { cwd: repo, maxBuffer: 8e6 });
  const single = JSON.parse(one.stdout);
  assert.equal(single.ok, true);
  assert.ok(Array.isArray(single.errors), 'errors/warnings, not a files array');
  assert.equal(single.files, undefined);
});
