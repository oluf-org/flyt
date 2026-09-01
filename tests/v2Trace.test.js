// Trace: the session log rendered for a person (t-0071, t-0072).
//
// The view model is pure, so what Trace SAYS about a run is testable without a
// DOM. Which is the half that matters: the claim is not that it renders, it is
// that it does not soften anything — a degraded route reads as degraded, a tool
// call with no result reads as unfinished rather than as empty, and a result is
// whole rather than previewed. The one time a preview is not enough is the time
// somebody opened this surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldTrace, feed, emptyTrace } from '../src/traceModel.js';
import { traceView, requestView, routeView, duration, between } from '../src/v2/traceView.js';
import { createKernel, sessionJsonl } from '#kernel';

const src = p => fs.readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8');

const RUN = [
  { seq: 1, at: '2026-08-22T10:00:00.000Z', type: 'run.created', data: { runId: 'r1', stackId: 'demo' } },
  { seq: 2, at: '2026-08-22T10:00:01.000Z', type: 'turn.start', data: { runId: 'r1', turn: 1, blockId: 'work' } },
  { seq: 3, at: '2026-08-22T10:00:01.100Z', type: 'step.start', data: { runId: 'r1', blockId: 'work', step: 1 } },
  { seq: 4, at: '2026-08-22T10:00:01.200Z', type: 'step.prompt', data: { content: 'You are a block.\n\nDo the thing.' } },
  { seq: 5, at: '2026-08-22T10:00:01.300Z', type: 'llm.request', data: { callId: 'q1', model: 'a/model', configuredModel: 'preferred/model', maxTokens: 12288 } },
  { seq: 5.1, at: '2026-08-22T10:00:01.400Z', type: 'llm.attempt', data: { callId: 'q1', index: 0, model: 'a/model', provider: 'openrouter', resolvedModel: 'a/model', status: 'started' } },
  { seq: 5.2, at: '2026-08-22T10:00:02.000Z', type: 'llm.attempt', data: { callId: 'q1', index: 0, model: 'a/model', provider: 'openrouter', resolvedModel: 'a/model', status: 'failed', error: 'rate limited' } },
  { seq: 5.3, at: '2026-08-22T10:00:02.100Z', type: 'llm.attempt', data: { callId: 'q1', index: 1, model: 'b/other', provider: 'openrouter', resolvedModel: 'b/other', status: 'started' } },
  { seq: 5.4, at: '2026-08-22T10:00:04.200Z', type: 'llm.attempt', data: { callId: 'q1', index: 1, model: 'b/other', provider: 'openrouter', resolvedModel: 'b/other', status: 'succeeded' } },
  {
    seq: 6, at: '2026-08-22T10:00:04.300Z', type: 'llm.response',
    data: {
      callId: 'q1', content: 'Let me look.', reasoning: 'thinking about it',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'ls' } }],
      usage: { promptTokens: 900, completionTokens: 120, reasoningTokens: 80, costUsd: 0.004 },
      route: { requested: 'a/model', effective: 'openrouter/b/other', reason: 'a/model was rate-limited', degraded: true },
    },
  },
  { seq: 7, at: '2026-08-22T10:00:04.400Z', type: 'permission.decision', data: { callId: 'c1', decision: 'allow', reason: 'it only reads' } },
  { seq: 8, at: '2026-08-22T10:00:04.900Z', type: 'tool.result', data: { callId: 'c1', name: 'bash', content: 'x'.repeat(40_000) } },
  { seq: 9, at: '2026-08-22T10:00:05.000Z', type: 'step.end', data: { runId: 'r1', blockId: 'work', step: 1 } },
  { seq: 10, at: '2026-08-22T10:00:05.100Z', type: 'turn.end', data: { runId: 'r1', turn: 1 } },
];

test('a finished run becomes turns holding steps holding what they did', () => {
  const view = traceView(foldTrace(RUN));
  assert.equal(view.turns.length, 1);
  const turn = view.turns[0];
  assert.equal(turn.finished, true);
  assert.equal(turn.blockId, 'work');
  assert.equal(turn.toolCount, 1);
  assert.equal(turn.costUsd, 0.004);
  assert.equal(turn.ms, 4100);

  const step = turn.steps[0];
  assert.equal(step.step, 1);
  assert.match(step.prompt, /You are a block/, 'the prompt assembly is there to be expanded');
  assert.equal(step.request.finishReason, 'tool_calls');
  assert.equal(step.request.tokens, '900 in · 120 out · 80 reasoning');
  assert.equal(step.request.costUsd, 0.004);
  assert.equal(step.request.configuredModel, 'preferred/model');
  assert.equal(step.request.maxTokens, 12288);
  assert.equal(step.request.attempts[0].status, 'failed');
  assert.equal(step.request.attempts[0].error, 'rate limited');
  assert.equal(step.request.attempts[1].effective, 'openrouter/b/other');
  assert.ok(step.request.tokensPerSecond > 50 && step.request.tokensPerSecond < 60);
});

test('reasoning is kept apart from content, which is the whole of D40 here', () => {
  const step = traceView(foldTrace(RUN)).turns[0].steps[0];
  assert.equal(step.request.content, 'Let me look.');
  assert.equal(step.request.reasoning, 'thinking about it');
  assert.notEqual(step.request.content, step.request.reasoning);
  // A surface that concatenated them could not answer "how much of what I paid
  // for was thinking", which is the question the split exists for.
  assert.doesNotMatch(step.request.content, /thinking about it/);
});

test('a degraded route reads as degraded, and a missing one is not reassurance', () => {
  const route = traceView(foldTrace(RUN)).turns[0].steps[0].request.route;
  assert.equal(route.degraded, true);
  assert.match(route.line, /asked for a\/model, answered by openrouter\/b\/other/);
  assert.match(route.line, /rate-limited/, 'and why that rung won');

  const plain = routeView({ requested: 'x', effective: 'p/x', reason: '', degraded: false });
  assert.equal(plain.degraded, false);
  assert.equal(plain.line, 'p/x');

  assert.equal(routeView(null), null,
    'a run that recorded no route says nothing, rather than saying nothing went wrong');
});

test('a tool call shows its arguments and its complete result, not a preview', () => {
  const call = traceView(foldTrace(RUN)).turns[0].steps[0].tools[0];
  assert.deepEqual(call.args, { command: 'ls' });
  assert.equal(call.result.length, 40_000, 'the whole thing — a preview is what you came here to get past');
  assert.equal(call.hasResult, true);
  assert.equal(call.unfinished, false);
  assert.deepEqual(call.decision, { decision: 'allow', reason: 'it only reads', at: '2026-08-22T10:00:04.400Z' });
});

test('a call that never returned is unfinished, not empty', () => {
  const cut = RUN.slice(0, 11); // tool.result is next, and it never arrived
  const step = traceView(foldTrace(cut)).turns[0].steps[0];
  const call = step.tools[0];
  assert.equal(call.unfinished, true);
  assert.equal(call.hasResult, false);
  assert.equal(call.result, null);
  // And the step and turn say they did not finish, rather than looking done.
  assert.equal(step.finished, false);
  assert.equal(traceView(foldTrace(cut)).unfinished, true);
});

test('partial tool input is shown separately and never claims the tool ran', () => {
  const partial = [
    RUN[1], RUN[2], RUN[4],
    { seq: 6, at: '2026-08-22T10:00:02.000Z', type: 'tool.input.start', data: {
      requestCallId: 'q1', inputId: 'input-1', index: 0, toolCallId: 'c1', name: 'write_file',
    } },
    { seq: 7, at: '2026-08-22T10:00:02.100Z', type: 'tool.input.delta', data: {
      inputId: 'input-1', index: 0, delta: '{"path":"half',
    } },
  ];
  const step = traceView(foldTrace(partial)).turns[0].steps[0];
  assert.equal(step.toolInputs.length, 1);
  assert.equal(step.toolInputs[0].name, 'write_file');
  assert.equal(step.toolInputs[0].arguments, '{"path":"half');
  assert.equal(step.toolInputs[0].complete, false);
  assert.equal(step.tools.length, 0, 'no llm.response/tool.call means no execution claim');
});

test('a request with nothing back yet is unsettled, and shows no finish reason', () => {
  const midflight = traceView(foldTrace(RUN.slice(0, 5))).turns[0].steps[0];
  assert.equal(midflight.request.settled, false);
  assert.equal(midflight.request.finishReason, null,
    '"stop" invented for a request that never came back would be a lie with a reassuring shape');
});

test('a denial is shown even though it produced no call', () => {
  const denied = [
    RUN[0], RUN[1], RUN[2],
    { seq: 4, at: 't', type: 'permission.decision', data: { callId: 'c9', decision: 'deny', reason: 'not in this block’s ceiling' } },
  ];
  const step = traceView(foldTrace(denied)).turns[0].steps[0];
  assert.equal(step.tools.length, 0);
  assert.equal(step.orphanDecisions.length, 1, 'a denial can be the reason there is no call');
  assert.equal(step.orphanDecisions[0].decision, 'deny');
});

test('events this surface has no shape for are kept, not hidden', () => {
  const view = traceView(foldTrace([...RUN, { seq: 11, at: 't', type: 'plugin/thing', data: { n: 1 } }]));
  // Two: the plugin's event, and `run.created`, which this fold has no shape
  // for either — it is the run's lifecycle rather than a turn, and Work is
  // where a run's stage belongs.
  assert.equal(view.others.length, 2);
  assert.equal(view.others.at(-1).type, 'plugin/thing',
    'a surface that hides a plugin’s events stops being the record');
});

test('a finished run’s trace opens from its log alone, with no live process', async () => {
  // Which is the whole of "Trace persists as that run's record" (D60): write a
  // log, throw the kernel away, open a new one, read the file, render it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-trace-'));
  const writer = createKernel();
  await writer.ctx.plugin(sessionJsonl, { root });
  const session = await writer.ctx.sessions.open('r1');
  for (const event of RUN) await session.append({ type: event.type, data: event.data, at: event.at });
  await writer.dispose();

  const reader = createKernel();
  await reader.ctx.plugin(sessionJsonl, { root });
  const past = await reader.ctx.sessions.read('r1');
  const events = [];
  for await (const e of past.read()) events.push(e);
  const view = traceView(foldTrace(events));
  assert.equal(view.turns.length, 1);
  assert.equal(view.turns[0].steps[0].request.route.degraded, true,
    'and it still tells the truth about the route, hours later');
  await reader.dispose();
});

test('a live trace grows from a cursor instead of being re-read whole', () => {
  const live = emptyTrace();
  feed(live, RUN.slice(0, 10));
  assert.equal(traceView(live).turns[0].steps[0].request.settled, true);
  assert.equal(traceView(live).unfinished, true);

  feed(live, RUN.slice(10));
  const done = traceView(live);
  assert.equal(done.unfinished, false);
  assert.deepEqual(done, traceView(foldTrace(RUN)),
    'feeding the tail equals folding the whole thing — or a watched run and a reopened one disagree');
});

test('durations read as a person would say them', () => {
  assert.equal(duration(412), '412ms');
  assert.equal(duration(4100), '4.1s');
  assert.equal(duration(185_000), '3m 5s');
  assert.equal(duration(null), null);
  assert.equal(between('2026-08-22T10:00:00.000Z', '2026-08-22T10:00:02.500Z'), 2500);
  assert.equal(between('nonsense', 'also nonsense'), null);
});

test('a request that was never made says so instead of rendering an empty one', () => {
  assert.equal(requestView(null), null);
});


