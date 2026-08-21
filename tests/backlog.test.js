// The backlog: work that survives a run (DESIGN-SPEC.md §8), and the tool that lets
// an agent add to it mid-run.
//
// Two things are load-bearing here and get the most attention: claiming has to
// be genuinely atomic (two workers in one worktree is the failure that ruins a
// night), and enqueue_task has to write to the canonical backlog rather than
// wherever the run happens to be standing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Backlog, parseTask, serializeTask, TASK_STATUSES } from '../core/backlog.js';
import { executeTool, getTools } from '../core/tools/index.js';
import { runAgent } from '../core/agent.js';
import { Workspace } from '../core/workspace.js';
import { makeStore, setScript } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-backlog-'));
const newBacklog = () => new Backlog(path.join(tmp(), '.flyt', 'backlog'));

// --- the store -------------------------------------------------------------

test('a task round-trips through its file, prose and all', () => {
  const backlog = newBacklog();
  const task = backlog.add({
    title: 'Add a per-task timeout to the gate runner',
    goal: 'A hung `npm test` parks a worktree forever.',
    doneWhen: ['runGates() kills a gate after its timeout', 'a test proves the kill path'],
    value: 4, effort: 2, dependsOn: ['t-0001'], blastRadius: ['core/gates.js']
  });

  const reread = backlog.get(task.id);
  assert.equal(reread.title, task.title);
  assert.equal(reread.value, 4);
  assert.deepEqual(reread.dependsOn, ['t-0001']);
  assert.deepEqual(reread.blastRadius, ['core/gates.js']);
  assert.match(reread.body, /## Goal/);
  assert.match(reread.body, /## Done when/);
  assert.match(reread.body, /- a test proves the kill path/);
  // Markdown with frontmatter, because a human writes these and an agent writes
  // these and both have to read them.
  const raw = fs.readFileSync(path.join(backlog.rootDir, `${task.id}.task.md`), 'utf8');
  assert.ok(raw.startsWith('---\n'));
  assert.match(raw, /status: queued/);
});

test('a field a later phase adds is preserved, not erased on write', () => {
  const backlog = newBacklog();
  const task = backlog.add({ title: 'x', goal: 'y' });
  const file = path.join(backlog.rootDir, `${task.id}.task.md`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: queued', 'status: queued\nledgerUsd: 1.25'));
  const updated = backlog.update(task.id, { status: 'running' });
  assert.equal(updated.ledgerUsd, 1.25);
  assert.equal(backlog.get(task.id).ledgerUsd, 1.25, 'an older reader must not clobber a newer field');
});

test('ids do not collide, even when two callers add at the same instant', () => {
  const backlog = newBacklog();
  const made = Array.from({ length: 25 }, (_, i) => backlog.add({ title: `t${i}`, goal: 'g' }));
  assert.equal(new Set(made.map(t => t.id)).size, 25);
  assert.equal(backlog.ids().length, 25);
});

test('a task id can never name a file outside the backlog', () => {
  const backlog = newBacklog();
  // Ids arrive from a CLI, an HTTP body and a model's tool call.
  for (const bad of ['../../etc/passwd', 'a/b', '.', '', 'x.task']) {
    assert.throws(() => backlog.get(bad), /Invalid task id/);
  }
});

test('a malformed task is reported, not thrown past', () => {
  const backlog = newBacklog();
  backlog.add({ title: 'fine', goal: 'g' });
  fs.writeFileSync(path.join(backlog.rootDir, 't-0099.task.md'), 'no frontmatter here');
  const tasks = backlog.list();
  assert.equal(tasks.length, 1, 'the good one still comes back');
  assert.equal(backlog.problems.length, 1);
  assert.match(backlog.problems[0].error, /frontmatter/);
});

test('a task nobody can read is still a task somebody can delete', () => {
  // The one entry a reader tolerates must not be the one entry a remover
  // refuses: `list` skips a malformed file so the other forty run, which is
  // exactly what makes it invisible — and if removing it throws too, it is a
  // permanent resident of the queue with no way out short of a text editor.
  const backlog = newBacklog();
  const good = backlog.add({ title: 'fine', goal: 'g' });
  fs.writeFileSync(path.join(backlog.rootDir, 't-0099.task.md'), 'no frontmatter here');

  const removed = backlog.remove('t-0099');
  assert.equal(removed.id, 't-0099');
  assert.match(removed.unreadable, /frontmatter/, 'and it says so rather than inventing a title');
  assert.deepEqual(backlog.ids(), [good.id]);
  backlog.list();
  assert.deepEqual(backlog.problems, [], 'the queue is clean afterwards');
});

test('an id is never handed out twice, however much of the queue is deleted', () => {
  // Ids used to be max(existing) + 1, which reuses a number as soon as its file
  // goes — and the ledger, the archive and the run log all key spend and
  // history by task id. Removing the newest task and adding another would give
  // the new one the old one's money.
  const backlog = newBacklog();
  backlog.add({ title: 'one', goal: 'g' });
  const second = backlog.add({ title: 'two', goal: 'g' });
  assert.equal(second.id, 't-0002');

  backlog.remove(second.id);
  assert.equal(backlog.add({ title: 'three', goal: 'g' }).id, 't-0003', 'not t-0002 again');

  // Emptied entirely, including the highest id, and it still climbs.
  for (const id of backlog.ids()) backlog.remove(id);
  assert.deepEqual(backlog.ids(), []);
  assert.equal(backlog.add({ title: 'four', goal: 'g' }).id, 't-0004');

  // A caller that names its own id spends that number too, or the generated
  // ones walk into it later.
  backlog.add({ id: 't-0050', title: 'named', goal: 'g' });
  backlog.remove('t-0050');
  assert.equal(backlog.add({ title: 'after', goal: 'g' }).id, 't-0051');

  // A lost counter degrades to the old behaviour rather than colliding: the
  // files on disk are still a floor.
  fs.rmSync(path.join(backlog.rootDir, 'next-id.json'));
  assert.equal(backlog.add({ title: 'no counter', goal: 'g' }).id, 't-0052');
});

// --- claiming --------------------------------------------------------------

test('a task can leave the queue for good, unless something is holding it', () => {
  // The queue could be added to and never emptied: release and escalate move a
  // task between states, and nothing removed one. A backlog written against the
  // wrong repository could only be HIDDEN by parking it, where it then sits in
  // the pile a person reads every morning, forever.
  const backlog = newBacklog();
  const a = backlog.add({ title: 'wrong repo', goal: 'g' });
  const b = backlog.add({ title: 'keep me', goal: 'g' });

  const removed = backlog.remove(a.id);
  assert.equal(removed.id, a.id);
  assert.equal(removed.title, 'wrong repo', 'the caller gets what it removed, so it can say so');
  assert.equal(backlog.get(a.id), null);
  assert.deepEqual(backlog.ids(), [b.id]);
  assert.equal(backlog.remove('t-9999'), null, 'removing what is not there is not an error');

  // A claimed task is refused: something holds a lease and probably a worktree,
  // and deleting the file it is working from is how a worker ends up writing
  // into a directory the supervisor has forgotten about.
  backlog.claim(b.id, 'worker-a');
  assert.throws(() => backlog.remove(b.id), /claimed by worker-a/);
  assert.ok(backlog.get(b.id), 'refused means still there');
  assert.equal(backlog.remove(b.id, { force: true }).id, b.id);
  assert.deepEqual(backlog.ids(), [], 'and the lock goes with it');
});

test('only one worker can claim a task', () => {
  const backlog = newBacklog();
  const task = backlog.add({ title: 'contended', goal: 'g' });
  const first = backlog.claim(task.id, 'worker-a');
  const second = backlog.claim(task.id, 'worker-b');
  assert.ok(first, 'the first claim wins');
  assert.equal(first.claimedBy, 'worker-a');
  assert.equal(second, null, 'the second gets nothing rather than a shared task');
  assert.equal(backlog.get(task.id).status, 'claimed');
});

test('an expired lease can be reclaimed, and says so', () => {
  const backlog = newBacklog();
  const task = backlog.add({ title: 'abandoned', goal: 'g' });
  backlog.claim(task.id, 'worker-that-died');
  backlog.update(task.id, { status: 'queued' }); // as a crash recovery would find it

  const tooSoon = backlog.claim(task.id, 'worker-b', { leaseMs: 60_000 });
  assert.equal(tooSoon, null, 'a live lease is respected');

  const later = backlog.claim(task.id, 'worker-b', { leaseMs: 60_000, now: Date.now() + 120_000 });
  assert.ok(later);
  assert.equal(later.stolen, true, 'a silent steal is how two workers end up in one worktree');
  assert.equal(later.claimedBy, 'worker-b');
});

test('releasing drops the lock so the task can be taken again', () => {
  const backlog = newBacklog();
  const task = backlog.add({ title: 'released', goal: 'g' });
  backlog.claim(task.id, 'worker-a');
  backlog.release(task.id);
  assert.equal(backlog.get(task.id).status, 'queued');
  assert.equal(backlog.get(task.id).claimedBy, null);
  assert.ok(backlog.claim(task.id, 'worker-b'), 'reclaimable immediately, no lease wait');
});

test('releasing with no status keeps the one the caller just decided', () => {
  // The supervisor escalates a failed task back into the queue a rung up and
  // THEN throws its worktree away. A release that insists on writing a status
  // of its own undoes that decision silently — which is exactly what happened:
  // every failed landing escalated correctly and was parked a moment later, so
  // the ladder never climbed.
  const backlog = newBacklog();
  const task = backlog.add({ title: 'fails once', goal: 'g', level: 'low' });
  backlog.claim(task.id, 'worker-a');
  const escalated = backlog.escalate(task.id, { reason: 'failed', note: 'review said no' });
  assert.equal(escalated.status, 'queued');
  assert.equal(escalated.level, 'medium');

  const released = backlog.release(task.id, { status: null });
  assert.equal(released.status, 'queued', 'the escalation survives the cleanup');
  assert.equal(released.level, 'medium');
  assert.equal(released.claimedBy, null);
});

// --- picking ---------------------------------------------------------------

test('the picker prefers value over effort, and unblocking over both', () => {
  const backlog = newBacklog();
  const cheapBig = backlog.add({ title: 'cheap and valuable', goal: 'g', value: 5, effort: 1 });
  const dearSmall = backlog.add({ title: 'dear and marginal', goal: 'g', value: 2, effort: 5 });
  const middling = backlog.add({ title: 'middling', goal: 'g', value: 3, effort: 3 });
  backlog.add({ title: 'waits on the middling one', goal: 'g', dependsOn: [middling.id] });

  const ready = backlog.ready();
  assert.equal(ready[0].id, cheapBig.id);
  assert.ok(ready.find(t => t.id === middling.id).score > 1, 'unblocking others counts for something');
  assert.equal(ready.at(-1).id, dearSmall.id);
  // The dependent task is not offered until its dependency lands.
  assert.ok(!ready.some(t => t.dependsOn.length), 'nothing with an unmet dependency is ready');
});

test('a dependency that landed unblocks; one that failed shows up as blocked, with the reason', () => {
  const backlog = newBacklog();
  const first = backlog.add({ title: 'first', goal: 'g' });
  const second = backlog.add({ title: 'second', goal: 'g', dependsOn: [first.id] });

  assert.deepEqual(backlog.ready().map(t => t.id), [first.id]);
  assert.equal(backlog.blocked()[0].id, second.id);
  assert.match(backlog.blocked()[0].reason, new RegExp(`${first.id} \\(queued\\)`));

  backlog.update(first.id, { status: 'landed' });
  assert.deepEqual(backlog.ready().map(t => t.id), [second.id]);

  backlog.update(first.id, { status: 'failed' });
  assert.equal(backlog.ready().length, 0);
  // Why the queue stopped moving must be visible rather than silently skipped.
  assert.match(backlog.blocked()[0].reason, /failed/);
});

test('take() claims the best ready task and skips one another worker just took', () => {
  const backlog = newBacklog();
  const best = backlog.add({ title: 'best', goal: 'g', value: 5, effort: 1 });
  const next = backlog.add({ title: 'next', goal: 'g', value: 4, effort: 1 });
  backlog.claim(best.id, 'worker-a');           // taken out from under us
  backlog.update(best.id, { status: 'queued' }); // ...but still reading as queued
  const taken = backlog.take('worker-b');
  assert.equal(taken.id, next.id, 'walked past the contended one instead of giving up');
  assert.equal(backlog.take('worker-c'), null, 'nothing left ready is null, not an error');
});

test('serializeTask/parseTask survive quoting hazards', () => {
  const round = parseTask(serializeTask({
    title: 'colons: and #hashes, and "quotes"',
    status: 'queued',
    dependsOn: ['t-0001', 't-0002'],
    body: '## Goal\n\nsomething'
  }), 't-0003');
  assert.equal(round.title, 'colons: and #hashes, and "quotes"');
  assert.deepEqual(round.dependsOn, ['t-0001', 't-0002']);
  assert.ok(TASK_STATUSES.includes(round.status));
});

// --- the tool --------------------------------------------------------------

function toolCtx() {
  const store = makeStore();
  const runId = store.createRun('enqueue test');
  const workspace = new Workspace(tmp()).ensure();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  return { store, runId, nodeId: 'work-1', workspace, backlog: newBacklog() };
}

test('enqueue_task writes to the backlog and logs what it queued', async () => {
  const ctx = toolCtx();
  const rec = await executeTool('enqueue_task', {
    title: 'Add a lint script',
    goal: 'The gate runner cannot enforce a gate that does not exist.',
    value: 5, effort: 1
  }, ctx);

  assert.equal(rec.ok, true);
  const queued = ctx.backlog.list();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].title, 'Add a lint script');
  assert.equal(queued[0].value, 5);
  // Provenance: a burst of near-identical tasks from one node is exactly the
  // pathology the overseer watches for, so the source has to be on the record.
  assert.equal(queued[0].createdBy, `agent:${ctx.runId}:work-1`);
  assert.ok(ctx.store.readLog(ctx.runId).some(e => e.event === 'task_enqueued' && e.task === queued[0].id));
});

test('a run with no backlog bound gets an honest error, not a stray file', async () => {
  const ctx = toolCtx();
  ctx.backlog = null;
  const rec = await executeTool('enqueue_task', { title: 't', goal: 'g' }, ctx);
  // The CALL fails — not a successful call carrying a failure object, which is
  // the ambiguity that makes bash's exit codes untrustworthy (DESIGN-SPEC.md §8).
  assert.equal(rec.ok, false);
  // ...and it points at the right alternative rather than just refusing.
  assert.match(rec.error, /create_task/);
});

test('enqueue_task gates like any other write outside the run', async () => {
  const { isDestructive } = await import('../core/tools/index.js');
  assert.equal(isDestructive('enqueue_task'), true, 'attended, adding to the backlog is worth one glance');
  assert.equal(isDestructive('create_task'), false, 'run-scoped work stays ungated');
});

test('an agent queues follow-up work mid-run, through the real tool loop', async () => {
  // The end-to-end shape of "automated task creation during tasks": the model
  // emits a tool call, the loop runs it, and the task outlives the run.
  const ctx = toolCtx();
  let turn = 0;
  setScript(() => {
    turn += 1;
    if (turn === 1) {
      return [
        'While doing this I noticed the repo has no lint script.',
        '```tool',
        JSON.stringify({
          tool: 'enqueue_task',
          args: { title: 'Add a lint script', goal: 'The gate runner needs one to enforce.', value: 5, effort: 1 }
        }),
        '```'
      ].join('\n');
    }
    return 'Done — the change is made and I queued the lint script separately.';
  });

  const out = await runAgent({
    worker: { provider: 'script', model: 'test-model' },
    system: 'SYS', prompt: 'Do the work',
    tools: getTools(['enqueue_task']),
    ctx
  });

  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].tool, 'enqueue_task');
  assert.equal(out.toolCalls[0].ok, true);
  assert.match(out.text, /queued the lint script/);

  const queued = ctx.backlog.list();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].title, 'Add a lint script');
  assert.equal(queued[0].status, 'queued', 'and it is ready for a future run to pick up');
  assert.equal(ctx.backlog.ready()[0].id, queued[0].id);
});

// --- `--only`: work a named subset, without editing the queue to arrange it ---
//
// The gap: the loop could only be pointed at "the backlog". Trying it on one
// task first — the obvious way to decide whether you trust it — meant parking
// or reordering everything else, which is editing the queue to work around the
// tool.

test('take({ only }) claims from the named set, in the picker\'s usual order', () => {
  const b = newBacklog();
  const low = b.add({ title: 'low value', goal: 'g', value: 1, effort: 1 });
  const high = b.add({ title: 'high value', goal: 'g', value: 5, effort: 1 });

  // Unfiltered, the picker takes the higher-scoring one.
  const first = b.take('supervisor', { only: [low.id] });
  assert.equal(first.id, low.id, 'the filter narrows what may be claimed');

  // The one it skipped is untouched — not parked, not blocked, still queued.
  assert.equal(b.get(high.id).status, 'queued');
  assert.equal(b.get(high.id).claimedBy, null);
});

test('take({ only }) does not override the rules that make a task claimable', () => {
  const b = newBacklog();
  const t = b.add({ title: 'parked', goal: 'g' });
  b.update(t.id, { status: 'parked', blockedReason: 'waiting on a human' });
  assert.equal(b.take('supervisor', { only: [t.id] }), null,
    'naming a task does not make an unclaimable one claimable');
});

test('take({ only }) with no match takes nothing rather than falling back', () => {
  const b = newBacklog();
  b.add({ title: 'a real task', goal: 'g' });
  assert.equal(b.take('supervisor', { only: ['t-9999'] }), null);
  // And an empty/absent filter is the whole backlog, as before.
  assert.ok(b.take('supervisor', { only: [] }));
});

// A supervisor killed between writing the lock and recording the claim leaves a
// task whose FILE says queued and unclaimed and whose lock says held. The
// picker skipped it in silence for a full hour while `flyt task ready` listed
// it as ready and the loop reported "nothing ready", blaming a different task's
// missing dependency. Two tasks did exactly that after a stop.
test('a lock left behind by a dead claimer does not poison a queued task', () => {
  const backlog = newBacklog();
  const task = backlog.add({ title: 'Orphaned', goal: 'g' });
  const lock = path.join(backlog.rootDir, `${task.id}.lock`);

  // The lock exists; the task file never learned about it.
  fs.writeFileSync(lock, JSON.stringify({ by: 'a supervisor that died', at: new Date().toISOString() }));
  assert.equal(backlog.get(task.id).status, 'queued');
  assert.equal(backlog.get(task.id).claimedBy, null);

  // Immediately: still believed, because claim() writes the lock before it
  // records the claim and a live claim looks identical for that instant.
  assert.equal(backlog.claim(task.id, 'next'), null);

  // Once the write window has passed, the task file wins.
  const stolen = backlog.claim(task.id, 'next', { now: Date.now() + 60_000 });
  assert.ok(stolen, 'a queued, unclaimed task must not stay unclaimable for an hour');
  assert.equal(stolen.claimedBy, 'next');
  assert.equal(stolen.stolen, true, 'a silent steal is how two workers end up in one worktree');
});

test('a lock held by a live claim is still respected', () => {
  const backlog = newBacklog();
  const task = backlog.add({ title: 'Held', goal: 'g' });
  const held = backlog.claim(task.id, 'first');
  assert.equal(held.claimedBy, 'first');

  // Well past the orphan grace, well inside the lease: the task file says
  // claimed, so there is nothing orphaned about it.
  assert.equal(backlog.claim(task.id, 'second', { now: Date.now() + 10 * 60_000 }), null);
});

test('a number field given a string is coerced, or refused, but never written through', () => {
  // The same hole one type over. Every argument arriving through
  // `flyt call task:update --arg attempts=0` is a STRING, and written through,
  // `attempts: "0"` made `attempts + 1` concatenate: a park message read
  // "across 01 attempt(s)". Nothing else complained, because a numeric string
  // survives every comparison and fails only at arithmetic.
  const backlog = new Backlog(fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-backlog-')));
  const task = backlog.add({ title: 'a task', goal: 'g' });

  assert.strictEqual(backlog.update(task.id, { attempts: '2' }).attempts, 2);
  assert.strictEqual(backlog.get(task.id).attempts, 2, 'and it is a number on disk too');
  assert.strictEqual(backlog.get(task.id).attempts + 1, 3, 'the arithmetic that went wrong');
  assert.strictEqual(backlog.update(task.id, { value: '5', effort: '1' }).value, 5);

  assert.throws(() => backlog.update(task.id, { attempts: 'soon' }),
    /"attempts" is a number, and was given "soon"/);
  assert.throws(() => backlog.update(task.id, { budgetUsd: 'lots' }), /"budgetUsd" is a number/);
  assert.strictEqual(backlog.get(task.id).attempts, 2, 'and the refusal wrote nothing');

  // An empty scalar means "back to the default", which for a budget is no budget.
  assert.strictEqual(backlog.update(task.id, { attempts: '' }).attempts, 0);
  assert.strictEqual(backlog.update(task.id, { budgetUsd: '' }).budgetUsd, null);
});

test('a list field given a scalar is refused, not written', () => {
  // What this prevents: `flyt call task:update --arg dependsOn=` wrote an empty
  // string into a field every reader treats as an array, and task:list then
  // threw for EVERY task — one bad field, the whole queue unreadable.
  const backlog = new Backlog(fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-backlog-')));
  const task = backlog.add({ title: 'a task', goal: 'g' });

  assert.throws(() => backlog.update(task.id, { dependsOn: 't-0001' }),
    /"dependsOn" is a list, and was given "t-0001"/);
  assert.throws(() => backlog.update(task.id, { gates: 'npm test' }), /"gates" is a list/);

  // An empty scalar is the honest way to say "none".
  backlog.update(task.id, { dependsOn: ['t-1'] });
  assert.deepEqual(backlog.get(task.id).dependsOn, ['t-1']);
  assert.deepEqual(backlog.update(task.id, { dependsOn: '' }).dependsOn, []);
  assert.deepEqual(backlog.get(task.id).dependsOn, []);

  // ...and the file is still readable by everything that reads it.
  assert.equal(backlog.list().length, 1);
});
