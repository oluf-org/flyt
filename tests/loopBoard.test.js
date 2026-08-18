// src/loopBoardData.js (DECISIONS.md D45): the board's projections.
//
// The invariant the routing tests are really guarding: every task lands in
// EXACTLY ONE column. A task in two is one you count twice; a task in none has
// silently left the board, which is the failure mode the stacked piles had.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS, columnsOf, columnFor, cardOf, allowedMoves, boardBanner,
  filterTasks, parseQuery, questionOf, moveCursor
} from '../src/loopBoardData.js';

const task = (id, over = {}) => ({
  id, title: `Task ${id}`, status: 'queued', value: 3, effort: 3,
  dependsOn: [], gates: [], attempts: 0, ...over
});
const blocked = (kind = 'dep-missing', remedy = { action: 'remove-dep', label: 'Drop it', args: {} }) =>
  [{ kind, severity: 'blocked', summary: 'Waiting on t-0006, which does not exist.', detail: null, subjects: [], remedy }];
const warning = () => [{ kind: 'parallelism-full', severity: 'warning', summary: 'All slots busy.', detail: null, subjects: [], remedy: null }];

const byId = cols => Object.fromEntries(cols.map(c => [c.id, c]));

// --- routing ---------------------------------------------------------------

test('columnsOf routes all eight statuses, plus unreadables, into exactly one column each', () => {
  const tasks = [
    task('t-1', { status: 'queued' }),
    task('t-2', { status: 'claimed' }),
    task('t-3', { status: 'running' }),
    task('t-4', { status: 'verifying' }),
    task('t-5', { status: 'review' }),
    task('t-6', { status: 'landed' }),
    task('t-7', { status: 'failed' }),
    task('t-8', { status: 'parked' })
  ];
  const cols = byId(columnsOf(tasks, {}, { problems: [{ id: 't-9', error: 'bad yaml' }], showDone: true }));

  assert.deepEqual(cols.queued.cards.map(c => c.id), ['t-1']);
  assert.deepEqual(cols.working.cards.map(c => c.id), ['t-2', 't-3', 't-4']);
  assert.deepEqual(cols.review.cards.map(c => c.id), ['t-5']);
  assert.deepEqual(cols.done.cards.map(c => c.id), ['t-6', 't-7']);
  assert.deepEqual(cols['needs-you'].cards.map(c => c.id), ['t-8', 't-9']);
  assert.deepEqual(cols.blocked.cards, []);

  // Exactly one, counted rather than assumed.
  const placed = Object.values(cols).flatMap(c => c.cards.map(x => x.id));
  assert.equal(placed.length, 9);
  assert.equal(new Set(placed).size, 9);
});

test('a blocked queued task is in Blocked and NOT in Queued — the whole point of the split', () => {
  const tasks = [task('t-1'), task('t-2')];
  const cols = byId(columnsOf(tasks, { 't-2': blocked() }));
  assert.deepEqual(cols.queued.cards.map(c => c.id), ['t-1']);
  assert.deepEqual(cols.blocked.cards.map(c => c.id), ['t-2']);
});

test('a WARNING does not move a task out of Queued', () => {
  const cols = byId(columnsOf([task('t-1')], { 't-1': warning() }));
  assert.deepEqual(cols.queued.cards.map(c => c.id), ['t-1']);
  assert.deepEqual(cols.blocked.cards, []);
});

test('an unknown status lands where a person will see it, rather than vanishing', () => {
  assert.equal(columnFor(task('t-1', { status: 'something-new' }), []), 'needs-you');
});

test('the columns are stable: an empty board still has its columns, minus Done', () => {
  const cols = columnsOf([], {});
  assert.deepEqual(cols.map(c => c.id), ['needs-you', 'queued', 'blocked', 'working', 'review']);
  assert.equal(cols[0].label, 'Needs you', 'Needs you is always first');
  assert.equal(cols[0].emptyText, 'Nothing is waiting on you.');
});

test('Done collapses to a count, and the toggle opens it', () => {
  const tasks = [task('t-1', { status: 'landed' })];
  const shut = byId(columnsOf(tasks, {})).done;
  assert.equal(shut.count, 1);
  assert.equal(shut.collapsed, true);
  assert.deepEqual(shut.cards, []);
  const open = byId(columnsOf(tasks, {}, { showDone: true })).done;
  assert.equal(open.collapsed, false);
  assert.equal(open.cards.length, 1);
});

test('a truncated column says how many it is hiding', () => {
  const many = Array.from({ length: 12 }, (_, i) => task(`t-${i}`));
  const col = byId(columnsOf(many, {}, { limit: 5 })).queued;
  assert.equal(col.count, 12);
  assert.equal(col.cards.length, 5);
  assert.equal(col.truncated, 7);
});

test('the top of Queued is marked as what the loop will take next', () => {
  const cols = byId(columnsOf([task('t-3'), task('t-1')], {}));
  // The caller hands the list in the picker's order; the board marks it.
  assert.equal(cols.queued.nextUp, 't-3');
});

// --- the card --------------------------------------------------------------

test('cardOf prints the blocker as a sentence, not a badge', () => {
  const card = cardOf(task('t-8'), blocked());
  assert.equal(card.line, 'Waiting on t-0006, which does not exist.');
  assert.equal(card.blocked, true);
  assert.equal(card.actionable, true);
});

test('cardOf: a warning-only card is not "blocked"', () => {
  const card = cardOf(task('t-1'), warning());
  assert.equal(card.blocked, false);
  assert.equal(card.actionable, false);
});

test('cardOf: a task with nothing wrong has no line at all', () => {
  assert.equal(cardOf(task('t-1'), []).line, null);
});

test('cardOf: the source-run affordance survives', () => {
  const card = cardOf(task('t-1', { sourceRunId: 'run-1', sourceNodeId: 'reader' }), []);
  assert.equal(card.sourceRunId, 'run-1');
  assert.equal(card.sourceNodeId, 'reader');
});

// --- questions (ask_human) -------------------------------------------------

test('questionOf parses what ask_human wrote, options and all', () => {
  const q = questionOf({
    blockedReason: 'Q: Should the drawer height be per project or global?\nOptions: (1) per project  (2) global\nAlready established: both are one line.'
  });
  assert.equal(q.question, 'Should the drawer height be per project or global?');
  assert.deepEqual(q.options, ['per project', 'global']);
  assert.equal(q.context, 'both are one line.');
});

test('questionOf: an ordinary parked reason is not a question', () => {
  assert.equal(questionOf({ blockedReason: 'gates never went green' }), null);
  assert.equal(questionOf({}), null);
});

test('a question outranks the generic parked sentence on the card', () => {
  const t = task('t-8', { status: 'parked', blockedReason: 'Q: Which pattern should this follow?' });
  const card = cardOf(t, [{ kind: 'attempts-exhausted', severity: 'blocked', summary: 'Parked and waiting on you.', remedy: null }]);
  assert.equal(card.line, 'Which pattern should this follow?');
  assert.equal(card.question.question, 'Which pattern should this follow?');
});

// --- allowedMoves ----------------------------------------------------------

const actions = t => allowedMoves(t).map(m => m.action);

test('allowedMoves refuses an illegal move for every status', () => {
  // Requeue is for work that has stopped, never for work in flight.
  for (const status of ['queued', 'claimed', 'running', 'verifying', 'review', 'landed']) {
    assert.ok(!actions(task('t', { status })).includes('requeue'), `requeue offered on ${status}`);
  }
  // Park is for something in the queue, not for something a worker holds.
  for (const status of ['claimed', 'running', 'parked', 'landed']) {
    assert.ok(!actions(task('t', { status })).includes('park'), `park offered on ${status}`);
  }
  // Editing a task the supervisor is writing loses a field silently, so it is
  // refused rather than raced (the same rule update_task enforces).
  for (const status of ['claimed', 'running', 'verifying']) {
    assert.ok(!actions(task('t', { status })).includes('edit'), `edit offered on ${status}`);
  }
});

test('allowedMoves: parked offers both requeues, and only one at the top band', () => {
  assert.deepEqual(actions(task('t', { status: 'parked' })).slice(0, 2), ['requeue', 'requeue-up']);
  // No ladder left: a button that quietly does nothing is worse than none.
  const top = actions(task('t', { status: 'parked', level: 'max' }));
  assert.ok(top.includes('requeue'));
  assert.ok(!top.includes('requeue-up'));
});

test('allowedMoves: remove is always there, always two-press, and forced on a held task', () => {
  for (const status of ['queued', 'parked', 'landed', 'failed', 'review']) {
    const m = allowedMoves(task('t', { status })).find(x => x.action === 'remove');
    assert.equal(m.confirm, 'twice', `remove on ${status}`);
    assert.equal(m.force, undefined);
  }
  const held = allowedMoves(task('t', { status: 'claimed' })).find(x => x.action === 'remove');
  assert.equal(held.force, true, 'a claimed task is refused first — the second press has to mean it');
});

test('allowedMoves: an unreadable file has exactly one move', () => {
  assert.deepEqual(actions({ id: 't-9', error: 'bad yaml', unreadable: true }), ['remove']);
});

test('allowedMoves: a blocker\'s remedy becomes a move bound to a real command', () => {
  const moves = allowedMoves(task('t-8'), { blockers: blocked() });
  const remedy = moves.find(m => m.action === 'remove-dep');
  assert.ok(remedy);
  assert.equal(remedy.command, 'task:update');
  assert.equal(remedy.label, 'Drop it');
});

test('allowedMoves: every move names a command, so none can invent a transition', () => {
  for (const status of ['queued', 'claimed', 'running', 'verifying', 'review', 'landed', 'failed', 'parked']) {
    for (const m of allowedMoves(task('t', { status }))) {
      assert.ok(m.command, `${status}/${m.action} has no command`);
      assert.match(m.command, /^(task|loop|work):/);
    }
  }
});

// --- the banner ------------------------------------------------------------

test('boardBanner is null when nothing project-wide is wrong', () => {
  assert.equal(boardBanner([]), null);
  assert.equal(boardBanner(), null);
});

test('boardBanner picks the blocking one and keeps the rest behind it', () => {
  const b = boardBanner([
    { kind: 'budget-soft', severity: 'warning', summary: 'Soft cap reached.' },
    { kind: 'no-reviewer', severity: 'blocked', summary: 'No reviewer model is set, so nothing can land.', remedy: { action: 'set-reviewer', label: 'Set a reviewer' } }
  ]);
  assert.equal(b.summary, 'No reviewer model is set, so nothing can land.');
  assert.equal(b.remedy.action, 'set-reviewer');
  assert.deepEqual(b.others.map(x => x.kind), ['budget-soft']);
});

// --- the filter bar --------------------------------------------------------

test('parseQuery separates operators from free text, and quotes survive', () => {
  assert.deepEqual(parseQuery('is:blocked level:high board'), {
    terms: [{ op: 'is', value: 'blocked' }, { op: 'level', value: 'high' }],
    text: ['board']
  });
  assert.deepEqual(parseQuery('gate:"npm test"').terms, [{ op: 'gate', value: 'npm test' }]);
  // An unknown `foo:bar` is free text, not a silently-dropped filter.
  assert.deepEqual(parseQuery('foo:bar'), { terms: [], text: ['foo:bar'] });
  assert.deepEqual(parseQuery(''), { terms: [], text: [] });
});

test('filterTasks: each operator, and they combine with AND', () => {
  const tasks = [
    task('t-1', { title: 'Build the board', level: 'high', gates: ['npm test'], createdBy: 'human' }),
    task('t-2', { title: 'Fix the parser', level: 'low', dependsOn: ['t-0006'], createdBy: 'agent:run-1:x' }),
    task('t-3', { title: 'Board polish', level: 'high', status: 'parked' })
  ];
  const blockers = { 't-2': blocked() };
  const ids = q => filterTasks(tasks, q, blockers).map(t => t.id);

  assert.deepEqual(ids('board'), ['t-1', 't-3']);
  assert.deepEqual(ids('is:blocked'), ['t-2']);
  assert.deepEqual(ids('is:ready'), ['t-1']);
  assert.deepEqual(ids('is:mine'), ['t-1']);
  assert.deepEqual(ids('is:agent'), ['t-2']);
  assert.deepEqual(ids('level:high'), ['t-1', 't-3']);
  assert.deepEqual(ids('dep:t-0006'), ['t-2']);
  // Quoted, because a gate command has spaces in it and an unquoted
  // `gate:npm test` is two terms: gate:npm AND the free word "test".
  assert.deepEqual(ids('gate:"npm test"'), ['t-1']);
  assert.deepEqual(ids('gate:npm test'), [], 'unquoted, the second word is a text search');
  assert.deepEqual(ids('status:parked'), ['t-3']);
  assert.deepEqual(ids('kind:dep-missing'), ['t-2']);

  // AND: typing more must narrow, never widen.
  assert.deepEqual(ids('level:high board'), ['t-1', 't-3']);
  assert.deepEqual(ids('level:high status:parked'), ['t-3']);
  assert.deepEqual(ids('level:high is:blocked'), []);
  // An empty query is everything, not nothing.
  assert.equal(filterTasks(tasks, '', blockers).length, 3);
});

test('filterTasks: is:question finds what an agent asked', () => {
  const tasks = [task('t-1'), task('t-2', { status: 'parked', blockedReason: 'Q: which way?' })];
  assert.deepEqual(filterTasks(tasks, 'is:question').map(t => t.id), ['t-2']);
});

// --- keyboard --------------------------------------------------------------

const board = () => columnsOf([
  task('a1', { status: 'parked' }), task('a2', { status: 'parked' }),
  task('b1'), task('b2'), task('b3')
], {});

test('moveCursor: j/k walk a column and stop at its ends', () => {
  const cols = board();
  assert.deepEqual(moveCursor(cols, { column: 'needs-you', id: 'a1' }, 'down'), { column: 'needs-you', id: 'a2' });
  // The bottom holds rather than wrapping: a list that wraps loses your place.
  assert.deepEqual(moveCursor(cols, { column: 'needs-you', id: 'a2' }, 'down'), { column: 'needs-you', id: 'a2' });
  assert.deepEqual(moveCursor(cols, { column: 'needs-you', id: 'a2' }, 'up'), { column: 'needs-you', id: 'a1' });
  assert.deepEqual(moveCursor(cols, { column: 'needs-you', id: 'a1' }, 'up'), { column: 'needs-you', id: 'a1' });
});

test('moveCursor: h/l skip empty columns and keep your depth where they can', () => {
  const cols = board();
  // Blocked/working/review are empty here, so `l` lands in Queued.
  assert.deepEqual(moveCursor(cols, { column: 'needs-you', id: 'a2' }, 'right'), { column: 'queued', id: 'b2' });
  assert.deepEqual(moveCursor(cols, { column: 'queued', id: 'b3' }, 'left'), { column: 'needs-you', id: 'a2' },
    'a shorter neighbour clamps to its last card');
  assert.deepEqual(moveCursor(cols, { column: 'queued', id: 'b1' }, 'right'), { column: 'queued', id: 'b1' });
});

test('moveCursor: an empty board has nowhere to go, and says so with null', () => {
  assert.equal(moveCursor(columnsOf([], {}), null, 'down'), null);
});

test('moveCursor: the first press lands ON the first card, not past it', () => {
  // With no cursor there is nowhere to move FROM, so any direction means
  // "start here" — and stepping past a1 would skip the very card the "Needs
  // you" column exists to put first.
  for (const dir of ['down', 'up', 'left', 'right']) {
    assert.deepEqual(moveCursor(board(), null, dir), { column: 'needs-you', id: 'a1' }, dir);
  }
  // A cursor pointing at a card that has since been filtered away is the same
  // situation: re-place it rather than moving relative to nothing.
  assert.deepEqual(moveCursor(board(), { column: 'needs-you', id: 'gone' }, 'down'), { column: 'needs-you', id: 'a1' });
});

// --- the column table itself ----------------------------------------------

test('the columns are the six the plan names, in the order work flows', () => {
  assert.deepEqual(COLUMNS.map(c => c.id), ['needs-you', 'queued', 'blocked', 'working', 'review', 'done']);
});
