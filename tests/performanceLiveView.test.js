import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTrace, feed, copyTraceChanges } from '../src/traceModel.js';
import { createRunView, runView } from '../src/v2/runView.js';
test('incremental Work matches full projection through streams, settlement, skipped batches and replacement traces', () => {
  let trace = emptyTrace(), seq = 0;
  const view = createRunView();
  const event = (type, data) => ({ seq: ++seq, at: new Date(1700000000000 + seq).toISOString(), type, data });
  const apply = events => {
    feed(trace, events);
    trace = copyTraceChanges(trace, { ...trace, turns: [...trace.turns], others: [...trace.others] });
    const actual = view(trace, { meta: { lifecycle: { phase: 'running' } } });
    assert.deepEqual(actual, runView(trace, { meta: { lifecycle: { phase: 'running' } } }));
    return actual;
  };
  apply([event('run.stage', { stage: 'execution' }), event('block.status', { blockId: 'work', status: 'active' }), event('turn.start', { turn: 1, runId: 'r' }), event('step.start', { blockId: 'work', step: 1 }), event('llm.request', { model: 'mock', callId: 'call' })]);
  for (let i = 0; i < 80; i++) apply([event('llm.stream', { text: i % 3 ? 'hello' : '', reasoning: i % 5 ? '' : 'thinking' })]);
  const before = view(trace);
  const next = apply([event('llm.stream', { text: 'more' })]);
  assert.equal(before.blocks.work.activity[0], next.blocks.work.activity[0], 'unchanged request row keeps its identity');
  feed(trace, [event('llm.stream', { text: 'skipped rendering' })]);
  apply([event('llm.stream', { reasoning: 'caught up' })]);
  apply([event('llm.response', { content: 'Final', usage: { promptTokens: 2, completionTokens: 1 } }), event('step.end', {}), event('turn.end', {}), event('block.status', { blockId: 'work', status: 'done' }), event('run.stage', { stage: 'done' })]);
  assert.deepEqual(view(trace, { meta: { actions: ['resume'] } }), runView(trace, { meta: { actions: ['resume'] } }));
  trace = emptyTrace();
  apply([event('run.stage', { stage: 'execution' }), event('block.status', { blockId: 'parent', status: 'active' }), event('step.start', { blockId: 'parent.planner', step: 1 }), event('llm.request', { model: 'mock' })]);
  apply([event('llm.stream', { text: 'planning' })]);
});
