// The Loop view's projections (LOOP-PLAN §14).
//
// Pure functions, tested without a renderer, for the same reason
// nodeFeedData.js and runDocument.js are: every interesting decision in that
// panel is a projection, and a projection you can test is one you can trust.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pilesOf, burndown, flightRow, headline, humanDuration, tailLines, trendBars, taskDetail, shortStamp, PILE_ORDER } from '../src/loopViewData.js';

test('the pile that needs a person comes first', () => {
  // The only part of the screen that is ASKING for something. Landed is
  // reassurance, the queue is future work; neither is a request.
  assert.equal(PILE_ORDER[0], 'parked');
});

test('every status a human would read as "someone has it" lands in one pile', () => {
  const piles = pilesOf([
    { id: 't-1', status: 'queued' },
    { id: 't-2', status: 'claimed' },
    { id: 't-3', status: 'running' },
    { id: 't-4', status: 'verifying' },
    { id: 't-5', status: 'review' },
    { id: 't-6', status: 'parked' },
    { id: 't-7', status: 'landed' }
  ]);
  assert.deepEqual(piles.running.map(t => t.id), ['t-2', 't-3', 't-4', 't-5']);
  assert.deepEqual(piles.queued.map(t => t.id), ['t-1']);
  assert.deepEqual(piles.parked.map(t => t.id), ['t-6']);
});

test('no cap means no burn-down, because a bar with no ceiling implies a limit that does not exist', () => {
  assert.equal(burndown({ usd: 5 }, {}), null);

  const ok = burndown({ usd: 5, unknown: 2 }, { softUsd: 10, hardUsd: 20 });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.pct, 25);
  // The number someone will quote back at their bank statement has to say how
  // much of itself is guesswork.
  assert.equal(ok.unknown, 2);

  assert.equal(burndown({ usd: 12 }, { softUsd: 10, hardUsd: 20 }).state, 'capped');
  assert.equal(burndown({ usd: 20 }, { softUsd: 10, hardUsd: 20 }).state, 'stopped');
  // Past the ceiling the bar stops at full rather than overflowing its box.
  assert.equal(burndown({ usd: 99 }, { hardUsd: 20 }).pct, 100);
});

test('a flight row distinguishes long from stuck', () => {
  // A long task is the design target; a stuck one is the failure. Showing a
  // duration and leaving the reader to guess which is which defeats the panel.
  const working = flightRow({ taskId: 't-1', ageMs: 90 * 60_000, idleMs: 30_000, stage: 'execution' });
  assert.equal(working.health, 'working');
  assert.equal(working.age, '1h 30m');

  assert.equal(flightRow({ taskId: 't', idleMs: 6 * 60_000 }).health, 'quiet');
  assert.equal(flightRow({ taskId: 't', idleMs: 11 * 60_000 }).health, 'stalled');
  // Once the supervisor has acted, say so: a person watching should be able to
  // see it is being handled rather than wonder whether to step in.
  const handled = flightRow({ taskId: 't', idleMs: 11 * 60_000, interventions: ['nudge'] });
  assert.equal(handled.health, 'intervened');
  assert.deepEqual(handled.interventions, ['nudge']);
});

test('a pinned model replaces the band on the row that is running it', () => {
  // "high" describes a rung that chose a model. Once a model is named the rung
  // chooses nothing, so showing it would describe a decision nobody made.
  assert.equal(flightRow({ taskId: 't', level: 'high' }).model, null);
  assert.equal(flightRow({ taskId: 't', level: 'high', model: 'deepseek/deepseek-v4-pro' }).model, 'deepseek/deepseek-v4-pro');
});

test('an opened task says why it is here, what it would touch, and what has been tried', () => {
  const detail = taskDetail({
    id: 't-0007', title: 'Add an explicit agent promotion policy',
    status: 'queued', level: 'high', attempts: 2, value: 4, effort: 2,
    createdBy: 'agent:t-0031', createdAt: '2026-08-14T06:40:11.000Z',
    dependsOn: ['t-0038'], gates: ['npm test'], blastRadius: ['core/gates/'],
    runIds: ['run-1', 'run-2'], budgetUsd: 1.5,
    body: '## Goal\n\nA hung gate parks a worktree forever.'
  }, { spend: { usd: 0.4213, calls: 9, unknown: 1 } });

  assert.equal(detail.empty, false);
  const facts = Object.fromEntries(detail.facts.map(f => [f.label, f.value]));
  assert.equal(facts.Status, 'queued');
  assert.equal(facts.Effort, 'high');
  assert.equal(facts.Attempts, '2');
  assert.equal(facts.Value, '4/5 for 2/5 effort');
  assert.equal(facts.Created, '08-14 06:40');
  assert.equal(facts.Budget, '$1.50');
  // The number someone will check against a bank statement has to say how much
  // of itself is guesswork — the same rule the burn-down follows.
  assert.match(facts.Spent, /\$0\.4213 across 9 call\(s\) · 1 unpriced/);
  assert.deepEqual(detail.lists.map(l => l.key), ['dependsOn', 'gates', 'blastRadius']);
  assert.deepEqual(detail.runIds, ['run-1', 'run-2']);
  assert.match(detail.body, /^## Goal/);
});

test('an empty field is absent rather than dashed', () => {
  // A grid of "—" reads as broken; a missing row reads as nothing to say.
  const detail = taskDetail({ id: 't-1', title: 'bare', status: 'queued' });
  const labels = detail.facts.map(f => f.label);
  assert.ok(!labels.includes('Attempts'));
  assert.ok(!labels.includes('Budget'));
  assert.ok(!labels.includes('Spent'));
  assert.deepEqual(detail.lists, []);
  // Nothing to open onto: the expander should say so rather than show a blank.
  assert.equal(detail.empty, true);
  // A level nobody set is the project's default, not an absence of one.
  assert.equal(detail.facts.find(f => f.label === 'Effort').value, 'project default');
});

test('a spend of nothing is not reported as a measurement', () => {
  // Zero calls means the ledger has never seen this task, which is not the same
  // as it having cost $0.00.
  const detail = taskDetail({ id: 't-1', title: 'x' }, { spend: { usd: 0, calls: 0 } });
  assert.ok(!detail.facts.some(f => f.label === 'Spent'));
});

test('a stamp keeps what someone would read and drops what they would not', () => {
  assert.equal(shortStamp('2026-08-16T09:41:03.000Z'), '08-16 09:41');
  assert.equal(shortStamp(null), null);
  assert.equal(shortStamp('whenever'), null);
});

test('durations read the way a person would say them', () => {
  assert.equal(humanDuration(4500), '5s');
  assert.equal(humanDuration(90_000), '2m');
  assert.equal(humanDuration(3 * 3600_000), '3h');
  assert.equal(humanDuration(3.5 * 3600_000), '3h 30m');
  assert.equal(humanDuration(-1), '—');
});

test('the headline answers the question someone would actually ask', () => {
  assert.equal(headline({ status: { running: true, inFlight: [{}, {}] } }), 'Working 2 tasks');
  assert.equal(headline({ status: { running: true, inFlight: [] } }), 'Waiting for something to pick up');
  assert.match(headline({ status: { running: false, stopping: 'hard cap reached ($20.00)' } }), /Stopped — hard cap/);
  assert.equal(headline({ status: {}, piles: { parked: [{}, {}, {}] } }), 'Idle — 3 waiting on you');
  assert.equal(headline({ status: {}, piles: {} }), 'Idle');
});

test('the log tail is bounded and carries a readable clock', () => {
  const entries = Array.from({ length: 300 }, (_, i) => ({ at: `2026-08-13T09:${String(i % 60).padStart(2, '0')}:00.000Z`, line: `line ${i}` }));
  const tail = tailLines(entries, 50);
  assert.equal(tail.length, 50);
  assert.equal(tail.at(-1).line, 'line 299');
  assert.match(tail[0].time, /^\d\d:\d\d:\d\d$/);
});

test('the trend refuses to call a direction from one point', () => {
  const series = { points: [{ date: '2026-08-12', score: 0.5, verified: 1, cases: 2, benchUsd: 3 }], scored: 1, latest: null, direction: null };
  const one = trendBars(series);
  assert.equal(one.direction, null);
  // Nothing scored yet reads as an invitation rather than as a failure: the
  // first night has nothing to compare against and that is not a problem.
  assert.match(one.summary, /run the benchmark/);

  const two = trendBars({
    points: [
      { date: '2026-08-10', score: 0.5, verified: 1, cases: 2, benchUsd: 3 },
      { date: '2026-08-11', score: null },
      { date: '2026-08-12', score: 1, verified: 2, cases: 2, benchUsd: 2 }
    ],
    scored: 2,
    latest: { date: '2026-08-12', score: 1, verified: 2, cases: 2 },
    direction: 'improving'
  });
  assert.equal(two.bars.length, 3);
  assert.equal(two.bars[0].pct, 50);
  assert.equal(two.bars[0].label, '08-10');
  // A day nobody scored keeps its slot: a run of unscored days is itself the
  // answer to why the number has not moved.
  assert.equal(two.bars[1].scored, false);
  assert.equal(two.bars[1].pct, null);
  assert.match(two.summary, /100% on 2026-08-12 \(2\/2 cases\) · improving/);

  assert.match(trendBars({ points: [] }).summary, /Nothing archived yet/);
  // Bounded for rendering, newest kept.
  const many = trendBars({ points: Array.from({ length: 40 }, (_, i) => ({ date: `2026-08-${String(i % 28 + 1).padStart(2, '0')}`, score: 1 })) }, { limit: 5 });
  assert.equal(many.bars.length, 5);
});
