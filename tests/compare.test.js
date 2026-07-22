// MODES-COMPARE Phase 5 — comparison logic (T11/T12). Pure over run snapshots:
// pane state, composer channels, broadcast targets, the pair record shape, and
// judge prep. The React split-view (CompareRun.jsx) is a thin view over this.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePair, paneLabel, paneStatus, paneChannel,
  broadcastTargets, canBroadcast, sendPlan, judgeAlternatives
} from '../src/compareRun.js';

// A minimal snapshot for a run at a given stage. finalAnswer reads the output
// node, so include one when a text is given.
const snap = (runId, stage, answer = null) => ({
  meta: { runId, stage, nodeStatus: {} },
  flow: { id: 'f', name: 'F', nodes: answer == null ? [] : [{ id: 'out', type: 'output', data: {} }], edges: [] },
  nodeOutputs: answer == null ? {} : { out: answer }
});

// --- comparePair -----------------------------------------------------------

test('comparePair normalizes arrays and the wrapped object, rejects junk', () => {
  assert.deepEqual(comparePair(['a', 'b']), ['a', 'b']);
  assert.deepEqual(comparePair({ compare: ['a', 'b'] }), ['a', 'b']);
  assert.equal(comparePair(null), null);
  assert.equal(comparePair(['a']), null);          // wrong arity
  assert.equal(comparePair(['a', 'b', 'c']), null);
  assert.equal(comparePair(['a', '']), null);       // empty id
  assert.equal(comparePair(['a', 'a']), null);      // two panes must differ
  assert.equal(comparePair({ compare: 'a' }), null);
});

test('paneLabel maps index to A/B/C', () => {
  assert.equal(paneLabel(0), 'A');
  assert.equal(paneLabel(1), 'B');
});

// --- paneStatus ------------------------------------------------------------

test('paneStatus is empty until the expected run lands', () => {
  assert.deepEqual(paneStatus(null, 'r1'), {
    loaded: false, stage: null, live: false, gated: false,
    awaitingInput: false, parked: false, settled: false
  });
  // A snapshot for a DIFFERENT run does not count as loaded.
  const s = paneStatus(snap('other', 'done'), 'r1');
  assert.equal(s.loaded, false);
  assert.equal(s.settled, false);
});

test('paneStatus reads live / gated / input / settled from the stage', () => {
  assert.equal(paneStatus(snap('r', 'execution'), 'r').live, true);
  assert.equal(paneStatus(snap('r', 'execution'), 'r').settled, false);

  const gated = paneStatus(snap('r', 'awaiting_approval'), 'r');
  assert.equal(gated.gated, true);
  assert.equal(gated.parked, true);
  assert.equal(gated.live, true); // an approval gate is not a terminal state

  const input = paneStatus(snap('r', 'awaiting_input'), 'r');
  assert.equal(input.awaitingInput, true);
  assert.equal(input.parked, true);

  const done = paneStatus(snap('r', 'done'), 'r');
  assert.equal(done.settled, true);
  assert.equal(done.live, false);
});

// --- paneChannel -----------------------------------------------------------

test('paneChannel: settled -> followup, input gate -> answer, else null', () => {
  assert.equal(paneChannel(paneStatus(snap('r', 'done'), 'r')), 'followup');
  assert.equal(paneChannel(paneStatus(snap('r', 'awaiting_input'), 'r')), 'answer');
  assert.equal(paneChannel(paneStatus(snap('r', 'execution'), 'r')), null);
  assert.equal(paneChannel(paneStatus(snap('r', 'awaiting_approval'), 'r')), null);
  assert.equal(paneChannel(paneStatus(null, 'r')), null);
});

// --- broadcast -------------------------------------------------------------

test('broadcastTargets are the settled panes only; input gates excluded', () => {
  const statuses = [
    paneStatus(snap('a', 'done'), 'a'),
    paneStatus(snap('b', 'awaiting_input'), 'b')
  ];
  assert.deepEqual(broadcastTargets(statuses), [0]);
  assert.equal(canBroadcast(statuses), true);

  const bothLive = [paneStatus(snap('a', 'execution'), 'a'), paneStatus(snap('b', 'execution'), 'b')];
  assert.deepEqual(broadcastTargets(bothLive), []);
  assert.equal(canBroadcast(bothLive), false);

  const bothDone = [paneStatus(snap('a', 'done'), 'a'), paneStatus(snap('b', 'done'), 'b')];
  assert.deepEqual(broadcastTargets(bothDone), [0, 1]);
});

// --- sendPlan --------------------------------------------------------------

test('sendPlan(both) fans out to settled panes as follow-ups', () => {
  const statuses = [paneStatus(snap('a', 'done'), 'a'), paneStatus(snap('b', 'done'), 'b')];
  assert.deepEqual(sendPlan(statuses, 'both'), [
    { index: 0, channel: 'followup' },
    { index: 1, channel: 'followup' }
  ]);
});

test('sendPlan(both) skips a pane that cannot take a follow-up', () => {
  const statuses = [paneStatus(snap('a', 'done'), 'a'), paneStatus(snap('b', 'awaiting_input'), 'b')];
  assert.deepEqual(sendPlan(statuses, 'both'), [{ index: 0, channel: 'followup' }]);
});

test('sendPlan(paneIndex) routes to that pane on its live channel', () => {
  const statuses = [paneStatus(snap('a', 'done'), 'a'), paneStatus(snap('b', 'awaiting_input'), 'b')];
  assert.deepEqual(sendPlan(statuses, 0), [{ index: 0, channel: 'followup' }]);
  assert.deepEqual(sendPlan(statuses, 1), [{ index: 1, channel: 'answer' }]);

  // A busy pane accepts nothing — empty plan, so the composer disables.
  const live = [paneStatus(snap('a', 'execution'), 'a'), paneStatus(snap('b', 'done'), 'b')];
  assert.deepEqual(sendPlan(live, 0), []);
});

// --- judgeAlternatives -----------------------------------------------------

test('judgeAlternatives needs both answers, then labels them A/B', () => {
  const a = snap('a', 'done', 'answer from A');
  const b = snap('b', 'done', 'answer from B');
  assert.deepEqual(judgeAlternatives([a, b]), [
    { label: 'Run A', text: 'answer from A' },
    { label: 'Run B', text: 'answer from B' }
  ]);
  // One side without an answer yet -> nothing to compare.
  assert.equal(judgeAlternatives([a, snap('b', 'execution')]), null);
});
