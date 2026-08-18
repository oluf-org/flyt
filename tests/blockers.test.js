// core/blockers.js (DECISIONS.md D45): why a task is not moving, as one sentence
// with a remedy where one exists.
//
// One case per kind, because the taxonomy IS the deliverable — a kind with no
// test is a sentence nobody has read. The cycle case is the one that is a real
// bug being fixed rather than a reason being reported: today two tasks that
// depend on each other both score 0 forever and nothing says the word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockersFor, blockersAll, boardBlockers, cycleThrough, whyNothingReady, LEASE_MS } from '../core/blockers.js';

const task = (id, over = {}) => ({
  id, title: `Task ${id}`, status: 'queued', value: 3, effort: 3, level: null,
  dependsOn: [], gates: [], blastRadius: [], attempts: 0, ...over
});

// Enough context that nothing project-wide fires by accident: a reviewer, a
// band model, and a running loop with a free slot.
const ctx = (tasks, over = {}) => ({
  tasks,
  settings: { workers: { reviewer: { provider: 'auto', model: 'm' } }, loopModels: { low: 'm' } },
  config: { loop: { parallelism: 2 } },
  status: { running: true, inFlight: [] },
  ...over
});

const kinds = list => list.map(b => b.kind);

// --- one case per kind -----------------------------------------------------

test('dep-missing: names the id that is not there, and offers to drop it', () => {
  const t = task('t-0008', { dependsOn: ['t-0006'] });
  const [b, ...rest] = blockersFor(t, ctx([t]));
  assert.equal(rest.length, 0);
  assert.equal(b.kind, 'dep-missing');
  assert.equal(b.severity, 'blocked');
  assert.equal(b.summary, 'Waiting on t-0006, which does not exist.');
  assert.deepEqual(b.subjects, ['t-0006']);
  assert.equal(b.remedy.action, 'remove-dep');
});

test('dep-unlanded: a dependency that is simply not finished yet', () => {
  const dep = task('t-0001', { status: 'running' });
  const t = task('t-0002', { dependsOn: ['t-0001'] });
  const [b] = blockersFor(t, ctx([dep, t]));
  assert.equal(b.kind, 'dep-unlanded');
  assert.match(b.summary, /Waiting on t-0001 \(running\) to land/);
  // Nothing to press: the answer is to wait, and a button that does nothing is
  // worse than none.
  assert.equal(b.remedy, null);
});

test('dep-unlanded: the chain goes exactly one level deep', () => {
  const a = task('t-0001', { status: 'queued', dependsOn: ['t-0000'] });
  const root = task('t-0000', { status: 'queued' });
  const t = task('t-0002', { dependsOn: ['t-0001'] });
  const [b] = blockersFor(t, ctx([root, a, t]));
  assert.match(b.detail, /t-0001 is itself waiting on t-0000/);
  // And not two: t-0000's own dependencies are not in the sentence.
  assert.doesNotMatch(b.detail, /t-0002/);
});

test('dep-cycle: the ring is named in order and an edge to cut is offered', () => {
  const a = task('t-0001', { dependsOn: ['t-0002'] });
  const b = task('t-0002', { dependsOn: ['t-0001'] });
  const found = blockersFor(a, ctx([a, b])).find(x => x.kind === 'dep-cycle');
  assert.ok(found, 'expected a dep-cycle blocker');
  assert.match(found.summary, /Circular dependency: t-0001 → t-0002 → t-0001/);
  assert.equal(found.remedy.action, 'break-cycle');
  assert.deepEqual(found.remedy.args, { id: 't-0001', drop: 't-0002' });
});

test('dep-cycle: a ring of three is found from any member', () => {
  const a = task('t-0001', { dependsOn: ['t-0002'] });
  const b = task('t-0002', { dependsOn: ['t-0003'] });
  const c = task('t-0003', { dependsOn: ['t-0001'] });
  const all = [a, b, c];
  for (const t of all) {
    assert.ok(blockersFor(t, ctx(all)).some(x => x.kind === 'dep-cycle'), `no cycle found from ${t.id}`);
  }
  assert.deepEqual(cycleThrough('t-0002', all), ['t-0002', 't-0003', 't-0001', 't-0002']);
});

test('dep-cycle: a task that merely POINTS AT a cycle is not blamed for it', () => {
  const a = task('t-0001', { dependsOn: ['t-0002'] });
  const b = task('t-0002', { dependsOn: ['t-0001'] });
  const bystander = task('t-0003', { dependsOn: ['t-0001'] });
  const found = blockersFor(bystander, ctx([a, b, bystander]));
  assert.ok(!kinds(found).includes('dep-cycle'));
  // It IS waiting on something unlanded, which is the true and useful answer.
  assert.ok(kinds(found).includes('dep-unlanded'));
  assert.equal(cycleThrough('t-0003', [a, b, bystander]), null);
});

test('dep-failed: a dead dependency is distinguished from a slow one', () => {
  const dep = task('t-0001', { status: 'failed', blockedReason: 'gates never went green' });
  const t = task('t-0002', { dependsOn: ['t-0001'] });
  const found = blockersFor(t, ctx([dep, t]));
  const b = found.find(x => x.kind === 'dep-failed');
  assert.ok(b);
  assert.match(b.summary, /which is failed — it will not finish on its own/);
  assert.match(b.detail, /gates never went green/);
  assert.equal(b.remedy.action, 'open-task');
  // And it is not ALSO reported as merely unlanded — one fact, one sentence.
  assert.ok(!kinds(found).includes('dep-unlanded'));
});

test('gate-unrunnable: a gate this machine cannot run, before the task is picked', () => {
  const t = task('t-0003', { gates: ['definitely-not-a-real-binary-xyz --run'] });
  const b = blockersFor(t, ctx([t])).find(x => x.kind === 'gate-unrunnable');
  assert.ok(b);
  assert.match(b.summary, /cannot run here/);
  assert.match(b.detail, /is not an executable command/);
  assert.equal(b.remedy.action, 'edit-gates');
});

test('lease-held: a stale claim is reported, a fresh one is not', () => {
  const now = Date.parse('2026-08-18T12:00:00.000Z');
  const stale = task('t-0004', {
    status: 'claimed', claimedBy: 'supervisor',
    claimedAt: new Date(now - LEASE_MS - 60_000).toISOString()
  });
  const fresh = task('t-0005', {
    status: 'claimed', claimedBy: 'supervisor',
    claimedAt: new Date(now - 60_000).toISOString()
  });
  const c = ctx([stale, fresh], { now });
  const b = blockersFor(stale, c).find(x => x.kind === 'lease-held');
  assert.ok(b);
  assert.equal(b.remedy.action, 'release-task');
  assert.deepEqual(kinds(blockersFor(fresh, c)), []);
});

test('attempts-exhausted: at the top band the remedy is requeue, below it a level up', () => {
  const top = task('t-0006', { status: 'parked', level: 'max', attempts: 4, blockedReason: 'out of ladder' });
  const mid = task('t-0007', { status: 'parked', level: 'medium', attempts: 2 });
  const b1 = blockersFor(top, ctx([top])).find(x => x.kind === 'attempts-exhausted');
  assert.match(b1.summary, /top band/);
  assert.equal(b1.remedy.action, 'requeue');
  assert.equal(b1.detail, 'out of ladder');
  const b2 = blockersFor(mid, ctx([mid])).find(x => x.kind === 'attempts-exhausted');
  assert.equal(b2.remedy.action, 'requeue-up');
});

test('unreadable: a file that would not parse short-circuits everything else', () => {
  const problem = { id: 't-0099', error: 'unexpected token at line 3', unreadable: true, dependsOn: ['t-0001'] };
  const found = blockersFor(problem, ctx([]));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'unreadable');
  assert.match(found[0].detail, /unexpected token/);
  assert.equal(found[0].remedy.action, 'remove-task');
});

test('parallelism-full: a warning, not a wall, and only when there is nothing real wrong', () => {
  const t = task('t-0010');
  const c = ctx([t], { config: { loop: { parallelism: 1 } }, status: { running: true, inFlight: [{ taskId: 'x' }] } });
  const [b] = blockersFor(t, c);
  assert.equal(b.kind, 'parallelism-full');
  assert.equal(b.severity, 'warning');
  assert.equal(b.remedy.action, 'raise-parallelism');

  // A task that is genuinely blocked does not also get told the queue is busy —
  // that would paint a real problem as a capacity note.
  const blocked = task('t-0011', { dependsOn: ['t-nope'] });
  const c2 = ctx([blocked], { config: { loop: { parallelism: 1 } }, status: { running: true, inFlight: [{ taskId: 'x' }] } });
  assert.deepEqual(kinds(blockersFor(blocked, c2)), ['dep-missing']);
});

// --- project-wide ----------------------------------------------------------

test('no-reviewer: project-wide, and it says nothing can land', () => {
  const t = task('t-0001');
  const b = boardBlockers({ ...ctx([t]), settings: { loopModels: { low: 'm' } } })
    .find(x => x.kind === 'no-reviewer');
  assert.ok(b);
  assert.match(b.summary, /nothing can land/);
  assert.equal(b.remedy.action, 'set-reviewer');
  // And it is NOT repeated on the card.
  assert.ok(!kinds(blockersFor(t, ctx([t]))).includes('no-reviewer'));
});

test('no-model: no band model and no router key', () => {
  const found = boardBlockers({
    tasks: [], status: { running: true },
    settings: { workers: { reviewer: { model: 'm' } }, loopModels: {}, providerKeys: {} }
  });
  assert.ok(kinds(found).includes('no-model'));
  // A key is enough on its own — the router picks inside the band. Both key
  // shapes count: publicSettings() reports `providers.<id>.hasKey` because no
  // key ever leaves the main process, and the CLI carries `providerKeys`.
  for (const settings of [
    { workers: { reviewer: { model: 'm' } }, loopModels: {}, providerKeys: { openrouter: 'sk-x' } },
    { workers: { reviewer: { model: 'm' } }, loopModels: {}, providers: { openrouter: { hasKey: true } } }
  ]) {
    assert.ok(!kinds(boardBlockers({ tasks: [], status: { running: true }, settings })).includes('no-model'));
  }
});

test('budget-hard stops, budget-soft only warns', () => {
  const base = { tasks: [], status: { running: true }, settings: { workers: { reviewer: { model: 'm' } }, loopModels: { low: 'm' } } };
  const hard = boardBlockers({ ...base, spend: { hits: ['hard', 'soft'], caps: { hardUsd: 4, softUsd: 2 }, window: { usd: 4.2 } } });
  const h = hard.find(x => x.kind === 'budget-hard');
  assert.equal(h.severity, 'blocked');
  assert.match(h.summary, /\$4\.00/);
  // Only the strongest one: two money banners for one wallet is noise.
  assert.ok(!kinds(hard).includes('budget-soft'));

  const soft = boardBlockers({ ...base, spend: { hits: ['soft'], caps: { softUsd: 2 }, window: { usd: 2.5 } } });
  const s = soft.find(x => x.kind === 'budget-soft');
  assert.equal(s.severity, 'warning');
  assert.match(s.summary, /nothing escalates/);
});

test('loop-stopped: only when there is actually something ready to pick up', () => {
  const ready = task('t-0001');
  const settings = { workers: { reviewer: { model: 'm' } }, loopModels: { low: 'm' } };
  const withWork = boardBlockers({ tasks: [ready], settings, status: { running: false } });
  assert.ok(kinds(withWork).includes('loop-stopped'));

  // An empty queue with the loop off is the FINISHED state, not a problem.
  const empty = boardBlockers({ tasks: [], settings, status: { running: false } });
  assert.ok(!kinds(empty).includes('loop-stopped'));

  // And neither is a queue where everything left is blocked on something else.
  const stuck = boardBlockers({ tasks: [task('t-0002', { dependsOn: ['t-gone'] })], settings, status: { running: false } });
  assert.ok(!kinds(stuck).includes('loop-stopped'));
});

// --- ordering, emptiness, and the whole-board pass -------------------------

test('two blockers on one task: the actionable one comes first', () => {
  const t = task('t-0008', { dependsOn: ['t-gone'], gates: ['definitely-not-a-real-binary-xyz'] });
  const found = blockersFor(t, ctx([t]));
  assert.equal(found.length, 2);
  assert.ok(found.every(b => b.remedy));
  assert.ok(found.every(b => b.severity === 'blocked'));
  // A warning can never be the first thing a stuck task says.
  const mixed = blockersFor(t, ctx([t], { config: { loop: { parallelism: 1 } }, status: { running: true, inFlight: [{}] } }));
  assert.equal(mixed[0].severity, 'blocked');
});

test('no blockers returns an empty list, not a placeholder', () => {
  const t = task('t-0001');
  assert.deepEqual(blockersFor(t, ctx([t])), []);
  assert.deepEqual(blockersFor(null, ctx([])), []);
});

test('blockersAll: keyed by id, and unreadable files get an entry too', () => {
  const a = task('t-0001', { dependsOn: ['t-gone'] });
  const b = task('t-0002');
  const map = blockersAll({ ...ctx([a, b]), problems: [{ id: 't-0099', error: 'bad yaml' }] });
  assert.equal(map.get('t-0001')[0].kind, 'dep-missing');
  assert.deepEqual(map.get('t-0002'), []);
  assert.equal(map.get('t-0099')[0].kind, 'unreadable');
});

// --- the headline ----------------------------------------------------------

test('whyNothingReady: names the blocked tasks in the same words the card uses', () => {
  const t = task('t-0008', { dependsOn: ['t-0006'] });
  const line = whyNothingReady(ctx([t]));
  assert.match(line, /^nothing ready — 1 task\(s\) blocked: t-0008 \(Waiting on t-0006, which does not exist\.\)$/);
});

test('whyNothingReady: "backlog empty" only when it really is', () => {
  assert.equal(whyNothingReady(ctx([])), 'backlog empty');
  // The distinction D44 recorded getting wrong: a queue of parked work is not
  // an empty backlog, and reporting it as one hid a night's output.
  assert.equal(whyNothingReady(ctx([task('t-0001', { status: 'parked' })])), 'nothing queued — 1 task(s) waiting on you');
  assert.equal(whyNothingReady(ctx([task('t-0001', { status: 'running' })])), 'nothing queued — 1 task(s) still in flight');
  assert.equal(whyNothingReady(ctx([task('t-0001', { status: 'landed' })])), 'backlog empty');
});

test('whyNothingReady: caps the list and says how many more', () => {
  const many = ['a', 'b', 'c', 'd', 'e'].map((_, i) => task(`t-000${i}`, { dependsOn: ['t-gone'] }));
  const line = whyNothingReady(ctx(many));
  assert.match(line, /5 task\(s\) blocked/);
  assert.match(line, /and 2 more/);
});
