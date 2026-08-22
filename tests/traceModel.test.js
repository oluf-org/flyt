// The trace read model: a pure fold from a session event list to the shape a
// surface renders — turns holding steps holding requests, tool calls and
// permission decisions. No React, no kernel import, no files: it is tested on
// plain event arrays, and the rendering slice that follows only has to render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTrace, feed, foldTrace, FOLDED_EVENTS } from '../src/traceModel.js';

// A finished single-turn run with two steps. Step 1 assembles the prompt, asks
// the model (a request that routes), gets a response that calls a tool, the
// permission decision, and the tool result. Step 2 asks again and gets the
// final answer. turn/end closes the turn.
const finishedTurn = [
  { seq: 1, at: 't0', type: 'turn.start', data: { runId: 'run-1', turn: 1 } },

  { seq: 2, at: 't1', type: 'step.start', data: { runId: 'run-1', blockId: 'work', step: 1 } },
  { seq: 3, at: 't2', type: 'step.prompt', data: { content: 'assemble the answer' } },
  { seq: 4, at: 't3', type: 'llm.request', data: { callId: 'req-1', model: 'grok', prompt: 'the question' } },
  {
    seq: 5, at: 't4', type: 'llm.response',
    data: {
      finishReason: 'tool_calls', content: 'Let me look.',
      toolCalls: [{ id: 'call-1', name: 'glob', args: { pattern: '*' } }],
      route: { requested: 'grok', effective: 'grok-2', reason: 'grok was rate-limited', degraded: true },
    },
  },
  { seq: 6, at: 't5', type: 'permission.decision', data: { callId: 'call-1', decision: 'allow' } },
  { seq: 7, at: 't6', type: 'tool.result', data: { callId: 'call-1', name: 'glob', content: '3 files' } },
  { seq: 8, at: 't7', type: 'step.end', data: { runId: 'run-1', blockId: 'work', step: 1 } },

  { seq: 9, at: 't8', type: 'step.start', data: { runId: 'run-1', blockId: 'work', step: 2 } },
  { seq: 10, at: 't9', type: 'llm.request', data: { callId: 'req-2', model: 'grok', prompt: 'now answer' } },
  { seq: 11, at: 't10', type: 'llm.response', data: { finishReason: 'stop', content: 'Three.' } },
  { seq: 12, at: 't11', type: 'step.end', data: { runId: 'run-1', blockId: 'work', step: 2 } },

  { seq: 13, at: 't12', type: 'turn.end', data: { runId: 'run-1', turn: 1 } },
];

test('a finished log becomes turns holding steps, requests, tool calls and decisions', () => {
  const trace = foldTrace(finishedTurn);
  assert.equal(trace.turns.length, 1);
  const turn = trace.turns[0];
  assert.equal(turn.finished, true);
  assert.equal(turn.id, 1);
  assert.equal(turn.steps.length, 2);

  const step = turn.steps[0];
  assert.equal(step.finished, true);
  assert.equal(step.prompt, 'assemble the answer');
  assert.equal(step.request.finishReason, 'tool_calls');
  assert.equal(step.request.settled, true);
  assert.equal(step.request.model, 'grok');
  assert.equal(step.toolCalls.length, 1);
  assert.equal(step.toolCalls[0].callId, 'call-1');
  assert.equal(step.toolCalls[0].name, 'glob');
  assert.equal(step.toolCalls[0].result, '3 files');
  assert.equal(step.toolCalls[0].hasResult, true);
  assert.equal(step.decisions.length, 1);
  assert.equal(step.decisions[0].decision, 'allow');

  // step 2 is a plain settled request with no tool work.
  assert.equal(turn.steps[1].request.finishReason, 'stop');
  assert.equal(turn.steps[1].toolCalls.length, 0);
});

test('a route record attaches to the request it describes', () => {
  const trace = foldTrace(finishedTurn);
  const step = trace.turns[0].steps[0];
  assert.ok(step.request.route, 'the route is on the request');
  assert.equal(step.request.route.requested, 'grok');
  assert.equal(step.request.route.effective, 'grok-2');
  assert.equal(step.request.route.degraded, true);
});

test('a log that stops before the model answered still builds', () => {
  // Cut off after the request went out and before anything came back: no
  // response, no step/end, no turn/end. This is what a live run looks like for
  // the whole time a model is thinking, so it is the common case rather than
  // an edge one.
  const trace = foldTrace(finishedTurn.slice(0, 4));
  const turn = trace.turns[0];
  assert.equal(turn.finished, false, 'no turn/end yet');
  const step = turn.steps[0];
  assert.equal(step.finished, false, 'no step/end yet');
  assert.ok(step.request, 'the request that was made is still there');
  assert.equal(step.request.settled, false, 'nothing came back, so it is unsettled');
  assert.equal(step.request.finishReason, null, 'and there is no finish reason to show');
  assert.equal(step.toolCalls.length, 0, 'nothing has asked for a tool yet');
});

test('a log that stops mid-step keeps the tool call the answer asked for', () => {
  // One event further on than it looks: the tool call EXISTS because the
  // response asked for it, so a cut that has a tool call in it necessarily has
  // the response too. What is unfinished here is the step and the turn.
  const trace = foldTrace(finishedTurn.slice(0, 6));
  const turn = trace.turns[0];
  assert.equal(turn.finished, false);
  const step = turn.steps[0];
  assert.equal(step.finished, false, 'no step/end yet');
  assert.equal(step.request.settled, true, 'the response arrived — that is what asked for the tool');
  assert.equal(step.request.finishReason, 'tool_calls');
  assert.equal(step.toolCalls.length, 1, 'the tool call is present');
  assert.equal(step.toolCalls[0].hasResult, false, 'and marked as having no result');
  assert.equal(step.toolCalls[0].result, null);
});

test('a tool call with no result is present and marked as having none', () => {
  // A response asked for a tool, the permission was given, and the process died
  // before any tool.result arrived.
  const events = [
    { seq: 1, at: 't0', type: 'turn.start', data: { runId: 'r', turn: 1 } },
    { seq: 2, at: 't1', type: 'step.start', data: { runId: 'r', blockId: 'work', step: 1 } },
    { seq: 3, at: 't2', type: 'llm.request', data: { callId: 'req-1', model: 'grok' } },
    {
      seq: 4, at: 't3', type: 'llm.response',
      data: { finishReason: 'tool_calls', toolCalls: [{ id: 'call-9', name: 'bash', args: { command: 'rm -rf tmp' } }] },
    },
    { seq: 5, at: 't4', type: 'permission.decision', data: { callId: 'call-9', decision: 'allow' } },
    // ...and the process dies here, mid-tool.
  ];
  const trace = foldTrace(events);
  const step = trace.turns[0].steps[0];
  const call = step.toolCalls.find(c => c.callId === 'call-9');
  assert.ok(call, 'the tool call survives');
  assert.equal(call.hasResult, false);
  assert.equal(call.result, null);
});

test('feeding events in two batches gives the same result as feeding them in one', () => {
  const one = foldTrace(finishedTurn);
  const two = emptyTrace();
  const mid = Math.floor(finishedTurn.length / 2);
  feed(two, finishedTurn.slice(0, mid));
  feed(two, finishedTurn.slice(mid));
  assert.deepEqual(two, one, 'an incremental fold equals a single fold');
});

test('an unknown event type is kept, not discarded', () => {
  const trace = foldTrace([
    { seq: 1, at: 't0', type: 'turn.start', data: { runId: 'r', turn: 1 } },
    { seq: 2, at: 't1', type: 'plugin/thing', data: { custom: 42 } },
  ]);
  assert.equal(trace.others.length, 1, 'the plugin event is kept as part of the record');
  assert.equal(trace.others[0].type, 'plugin/thing');
  assert.equal(trace.others[0].data.custom, 42);
});
test('the fold speaks the log’s vocabulary, not the kernel’s event names', async () => {
  // It did not, once. This file matched `turn/start` and `step/start` —
  // the SLASH names from `kernel/src/events.ts`, which are cordis events
  // dispatched inside a process, not the dotted types a session log holds. The
  // fold read a real log and matched nothing in it, and every test passed
  // because every fixture used the invented names too.
  const { SESSION_EVENTS } = await import('#kernel');
  const unknown = FOLDED_EVENTS.filter(t => !SESSION_EVENTS.includes(t));
  assert.deepEqual(unknown, [],
    'a type this fold matches that the log never writes is a branch that can never run');
});
