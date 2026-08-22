// One block runs: the agent loop through the seams, every step logged (t-0065).
//
// The test that matters most is the last one. "Model-visible means logged"
// (D55) is not a rule the loop follows — it is a property of how the request is
// built, since `deriveMessages()` reads the log back and that list IS what goes
// to the model. So the assertion is that rebuilding from the log alone gives
// exactly what was sent, and it cannot pass for a loop that keeps a message
// list of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createKernel, flytTools, flytApprovals, sessionJsonl, runAgentLoop, provideSeam, KERNEL_EVENTS,
} from '#kernel';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-blockrun-'));

/** An `ctx.llm` that answers from a script, and records what it was asked. */
function scriptedLlm(script) {
  const seen = [];
  let turn = 0;
  const answerFor = () => script[Math.min(turn++, script.length - 1)];
  return {
    seen,
    seam: {
      stream(request) {
        seen.push({ model: request.model, messages: request.messages, tools: (request.tools ?? []).map(t => t.name) });
        const answer = answerFor();
        const chunks = [
          ...(answer.reasoning ? [{ reasoning: answer.reasoning }] : []),
          ...(answer.content ? [{ text: answer.content }] : []),
          ...(answer.toolCalls ?? []).map(toolCall => ({ toolCall })),
        ];
        return {
          async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
          async settled() {
            return {
              content: answer.content ?? '',
              ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
              ...(answer.toolCalls ? { toolCalls: answer.toolCalls } : {}),
              finishReason: answer.toolCalls?.length ? 'tool_calls' : 'stop',
              usage: { inputTokens: 10, outputTokens: 3 },
              route: { requested: request.model, effective: 'fake', reason: 'the fake answered', degraded: false },
            };
          },
        };
      },
      async complete() { throw new Error('this test streams'); },
      async models() { return []; },
    },
  };
}

async function bootFor(script, { tools = [], ceiling = [] } = {}) {
  const root = tmp();
  const kernel = createKernel();
  const llm = scriptedLlm(script);
  await kernel.ctx.plugin(flytTools);
  // The permission bridge, because the ceiling is only a ceiling if something
  // binds it. Without this a block reaches every registered tool, which is the
  // one thing a test about tools must not quietly do.
  await kernel.ctx.plugin(flytApprovals, { mode: 'always' });
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({
    name: 'a-fake-llm',
    apply(ctx) { return provideSeam(ctx, 'llm', llm.seam); },
  });
  if (tools.length) {
    await kernel.ctx.plugin({
      name: 'some-tools',
      inject: ['tools'],
      apply(ctx) { for (const t of tools) ctx.tools.register(t); },
    });
  }
  const session = await kernel.ctx.sessions.open('run-1');
  return { kernel, llm, session, root, ceiling };
}

const loopIn = (boot, over = {}) => runAgentLoop({
  ctx: boot.kernel.ctx,
  session: boot.session,
  runId: 'run-1',
  blockId: 'work',
  turn: 1,
  model: 'a/model',
  system: 'You are a block.',
  input: 'Do the thing.',
  ceiling: boot.ceiling,
  ...over,
});

const typesIn = async session => {
  const out = [];
  for await (const e of session.read()) out.push(e.type);
  return out;
};

test('a block with no tool calls runs, and its events fire in the documented order', async () => {
  const boot = await bootFor([{ content: 'Done.' }]);
  const fired = [];
  for (const name of KERNEL_EVENTS) {
    if (name.includes('pre-execute') || name.includes('post-execute')) continue;
    boot.kernel.ctx.on(name, () => { fired.push(name); });
  }

  const result = await loopIn(boot);
  assert.equal(result.content, 'Done.');
  assert.equal(result.stopped, 'answered');
  assert.equal(result.steps, 1);
  assert.equal(result.finishReason, 'stop');

  assert.deepEqual(fired.filter(n => n !== 'session/append'),
    ['turn/start', 'agent/pre-step', 'step/start', 'llm/stream', 'step/end', 'turn/end'],
    'the order in kernel/src/events.ts is the contract, not a suggestion');

  assert.deepEqual(await typesIn(boot.session), [
    'turn.start', 'message.system', 'message.user',
    'step.start', 'llm.request', 'llm.response', 'step.end',
    'turn.end',
  ]);
  await boot.kernel.dispose();
});

test('the message list rebuilt from the log alone is what was sent to the model', async () => {
  // The whole of D55, as an assertion. It cannot pass for a loop that keeps its
  // own message list beside the log, because the list it sent IS the one the
  // log gives back.
  const boot = await bootFor([
    { content: 'Looking.', toolCalls: [{ id: 'c1', name: 'peek', args: { at: 'x' } }] },
    { content: 'Three.' },
  ], {
    tools: [{
      name: 'peek', description: 'Look at something.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: '3 files' }; },
    }],
    ceiling: ['peek'],
  });

  const result = await loopIn(boot);
  assert.equal(result.stopped, 'answered');
  assert.equal(result.steps, 2);

  // What the model was handed on its second call, and what the log says it was.
  const sentSecond = boot.llm.seen[1].messages;
  const rebuilt = await boot.session.deriveMessages();
  assert.deepEqual(sentSecond.map(m => [m.role, m.content]), [
    ['system', 'You are a block.'],
    ['user', 'Do the thing.'],
    ['assistant', 'Looking.'],
    ['tool', '3 files'],
  ]);
  assert.deepEqual(rebuilt.slice(0, sentSecond.length).map(m => [m.role, m.content]),
    sentSecond.map(m => [m.role, m.content]),
    'the log holds every message the model saw, in order');
  await boot.kernel.dispose();
});

test('a tool call reaches the gate before the tool runs, once per call', async () => {
  let ran = 0;
  const gated = [];
  const boot = await bootFor([
    { content: '', toolCalls: [{ id: 'c1', name: 'peek', args: {} }] },
    { content: 'done' },
  ], {
    tools: [{
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { ran += 1; return { content: 'ok' }; },
    }],
    ceiling: ['peek'],
  });
  boot.kernel.ctx.on('tools/pre-execute', (exec, next) => {
    gated.push({ name: exec.call.name, ceiling: [...exec.ceiling], step: exec.step });
    return next();
  });

  await loopIn(boot);
  assert.equal(ran, 1, 'the body ran once');
  assert.deepEqual(gated, [{ name: 'peek', ceiling: ['peek'], step: 1 }],
    'and the gate saw it once, carrying the ceiling the block was given');
  await boot.kernel.dispose();
});

test('a denied tool call becomes a result the model can read, not a thrown error', async () => {
  const boot = await bootFor([
    { content: '', toolCalls: [{ id: 'c1', name: 'wreck', args: {} }] },
    { content: 'I was refused, so here is what I know.' },
  ], {
    tools: [{
      name: 'wreck', description: 'Break things.', parameters: { type: 'object' },
      classification: { effect: 'shell', destructive: true, untrustedInput: false, source: 'confirmed' },
      async execute() { throw new Error('this must never run'); },
    }],
    // The ceiling does not name it, so the permission bridge refuses it.
    ceiling: ['peek'],
  });

  const result = await loopIn(boot);
  assert.equal(result.stopped, 'answered', 'a refusal is not a failed run');
  const toolMessage = result.messages.find(m => m.role === 'tool');
  assert.match(toolMessage.content, /Refused/);
  assert.equal(boot.llm.seen.length, 2, 'and the model got another turn to react to it');
  await boot.kernel.dispose();
});

test('the loop is bounded, and hitting the bound says so rather than looking finished', async () => {
  const boot = await bootFor([
    { content: 'again', toolCalls: [{ id: 'c1', name: 'peek', args: {} }] },
  ], {
    tools: [{
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: 'same' }; },
    }],
    ceiling: ['peek'],
  });

  // The script never stops asking for the tool, which is exactly the shape of
  // the failure a bound exists for.
  const result = await loopIn(boot, { maxSteps: 3 });
  assert.equal(result.stopped, 'bound');
  assert.match(result.reason, /all 3 of its steps/);
  assert.equal(boot.llm.seen.length, 3, 'three steps, not four and not forever');
  const types = await typesIn(boot.session);
  assert.equal(types.filter(t => t === 'step.start').length, 3);
  assert.equal(types.at(-1), 'turn.end', 'and the turn is closed, so the log is not left open');
  await boot.kernel.dispose();
});

test('a listener may veto a step, and the log says the turn was vetoed', async () => {
  const boot = await bootFor([{ content: 'never asked' }]);
  boot.kernel.ctx.on('agent/pre-step', () => 'this block is not allowed to run here');

  const result = await loopIn(boot);
  assert.equal(result.stopped, 'vetoed');
  assert.equal(result.reason, 'this block is not allowed to run here');
  assert.equal(boot.llm.seen.length, 0, 'the model was never asked');
  const types = await typesIn(boot.session);
  assert.ok(!types.includes('llm.request'), 'and nothing pretends a request was made');
  assert.equal(types.at(-1), 'turn.end');
  await boot.kernel.dispose();
});

test('every type the loop writes is in the log’s declared vocabulary', async () => {
  const { SESSION_EVENTS } = await import('#kernel');
  const boot = await bootFor([
    { content: 'Looking.', reasoning: 'thinking', toolCalls: [{ id: 'c1', name: 'peek', args: {} }] },
    { content: 'Done.' },
  ], {
    tools: [{
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: 'ok' }; },
    }],
    ceiling: ['peek'],
  });
  await loopIn(boot);
  const unknown = [...new Set(await typesIn(boot.session))].filter(t => !SESSION_EVENTS.includes(t));
  assert.deepEqual(unknown, [],
    'a type the writer invents is a type the projection and Trace will not fold');
  await boot.kernel.dispose();
});
