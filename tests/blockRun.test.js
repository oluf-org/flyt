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
import { InterceptionRegistry } from '../kernel/dist/plugins/interceptions.js';
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
        seen.push({
          model: request.model,
          fallbackModels: [...(request.fallbackModels ?? [])],
          messages: request.messages,
          tools: (request.tools ?? []).map(t => t.name),
          maxTokens: request.maxTokens ?? null,
          temperature: request.temperature ?? null,
        });
        const answer = answerFor();
        const chunks = answer.chunks ?? [
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
              ...(answer.unparsedToolCall ? { unparsedToolCall: answer.unparsedToolCall } : {}),
              finishReason: answer.finishReason ?? (answer.toolCalls?.length ? 'tool_calls' : 'stop'),
              usage: { inputTokens: 10, outputTokens: 3 },
              route: answer.route ?? { requested: request.model, effective: 'fake', reason: 'the fake answered', degraded: false },
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
    await flytTools.installPlugin(kernel.ctx, {
      name: 'some-tools',
      inject: ['tools'],
      apply(ctx) { for (const t of tools) ctx.tools.register(t); },
    }, {
      attended: true,
      decide: (_pluginName, proposals) => Object.fromEntries(proposals.map(p => [p.name, p])),
    });
  }
  const session = await kernel.ctx.sessions.open('run-1');
  return { kernel, llm, session, root, ceiling, tools };
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
  tools: boot.tools,
  ceiling: boot.ceiling,
  ...over,
});

const typesIn = async session => {
  const out = [];
  for await (const e of session.read()) out.push(e.type);
  return out;
};

test('a word ceiling allows exactly one tool-free correction, including at the step bound', async t => {
  const boot = await bootFor([{ content: 'one two three four' }, { content: 'one two' }]);
  t.after(() => boot.kernel.dispose());
  const result = await loopIn(boot, { maxSteps: 1, maxOutputWords: 2 });
  assert.equal(result.stopped, 'answered');
  assert.equal(result.content, 'one two');
  assert.equal(boot.llm.seen.length, 2);
  assert.deepEqual(boot.llm.seen[1].tools, []);
  const checks = boot.session.readSync().filter(e => e.type === 'block.output.validation');
  assert.deepEqual(checks.map(e => e.data.valid), [false, true]);
});

for (const correction of [{ content: 'still too many words' }, { content: 'partial', finishReason: 'length' }, { content: '' },
  { content: '', toolCalls: [{ id: 'forbidden', name: 'never_execute', args: {} }] }]) {
  test(`word contract fails visibly after unusable correction: ${JSON.stringify(correction)}`, async t => {
    const boot = await bootFor([{ content: 'one two three' }, correction]);
    t.after(() => boot.kernel.dispose());
    const result = await loopIn(boot, { maxOutputWords: 2, continueOnLength: true });
    assert.equal(result.stopped, 'bound');
    assert.match(result.reason, /Output contract failed/);
    assert.equal(boot.llm.seen.length, 2);
    assert.deepEqual(boot.llm.seen[1].tools, []);
    if (correction.toolCalls) assert.ok(boot.session.readSync().some(e => e.type === 'tool.state' && e.data.callId === 'forbidden' && e.data.state === 'failed'));
  });
}

for (const point of ['context.assembled', 'model.request.prepared']) {
  test(`${point} cannot inject another transcript into a scoped request`, async t => {
    const boot = await bootFor([{ content: 'never sent' }]);
    t.after(() => boot.kernel.dispose());
    const registry = new InterceptionRegistry(boot.kernel.ctx, () => true);
    registry.register({ plugin: 'test', point, order: 0, mutates: true,
      run: value => ({ ...value, messages: [...value.messages, { role: 'system', content: 'sibling secret' }] }) });
    await assert.rejects(loopIn(boot, { context: { mode: 'block-input', after: 0 } }), /cannot replace a scoped transcript/);
    assert.equal(boot.llm.seen.length, 0);
    assert.ok(boot.session.readSync().some(e => e.type === 'plugin.interception' && e.data.mutated));
  });
}

test('an explicitly shared request logs the exact messages produced by a mutating plugin', async t => {
  const boot = await bootFor([{ content: 'done' }]);
  t.after(() => boot.kernel.dispose());
  const registry = new InterceptionRegistry(boot.kernel.ctx, () => true);
  registry.register({ plugin: 'test', point: 'model.request.prepared', order: 0, mutates: true,
    run: value => ({ ...value, messages: [{ role: 'user', content: 'replacement' }] }) });
  assert.equal((await loopIn(boot, { isolated: false })).stopped, 'answered');
  const prompt = boot.session.readSync().find(e => e.type === 'step.prompt').data.content;
  assert.equal(prompt.source, 'effective-messages');
  assert.deepEqual(prompt.messages, boot.llm.seen[0].messages);
});

test('fresh scoped requests do not adopt untagged global history as legacy block context', async t => {
  const boot = await bootFor([{ content: 'done' }]);
  t.after(() => boot.kernel.dispose());
  await boot.session.append({ type: 'message.system', data: { content: 'UNRELATED_GLOBAL_HISTORY' } });
  await loopIn(boot, { context: { mode: 'block-input', after: 0 } });
  assert.doesNotMatch(JSON.stringify(boot.llm.seen[0].messages), /UNRELATED_GLOBAL_HISTORY/);
});

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
    'step.start', 'step.prompt', 'llm.request', 'llm.stream', 'llm.response', 'step.end',
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
  assert.match(result.reason, /all 3 of its hard-bounded steps/);
  assert.equal(boot.llm.seen.length, 3, 'three steps, not four and not forever');
  const types = await typesIn(boot.session);
  assert.equal(types.filter(t => t === 'step.start').length, 3);
  assert.equal(types.at(-1), 'turn.end', 'and the turn is closed, so the log is not left open');
  await boot.kernel.dispose();
});

test('a narrated call to an offered tool is repaired into a native call, never executed from prose', async () => {
  let ran = 0;
  const boot = await bootFor([
    { content: '→ peek()' },
    { content: '', toolCalls: [{ id: 'c1', name: 'peek', args: { at: 'workspace' } }] },
    { content: 'Native call completed.' },
  ], {
    tools: [{
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute(args) { ran += 1; assert.deepEqual(args, { at: 'workspace' }); return { content: 'ok' }; },
    }],
    ceiling: ['peek'],
  });

  const result = await loopIn(boot);
  assert.equal(result.stopped, 'answered');
  assert.equal(result.content, 'Native call completed.');
  assert.equal(ran, 1, 'the visible peek() text never bypasses native parsing and the gate');
  assert.equal(boot.llm.seen.length, 3);
  assert.match(boot.llm.seen[1].messages.at(-1).content, /No tool ran/);
  const events = boot.session.readSync();
  const warning = events.find(event => event.type === 'block.warning' && event.data.code === 'tool_call_repair');
  assert.equal(warning.data.detail, 'peek');
  assert.equal(events.filter(event => event.type === 'tool.call').length, 1);
  await boot.kernel.dispose();
});

test('a bounded tool preview and its complete durable result take separate paths', async () => {
  const complete = { stdout: 'x'.repeat(20_000), exitCode: 0 };
  const boot = await bootFor([
    { content: '', toolCalls: [{ id: 'large', name: 'peek', args: {} }] },
    { content: 'The preview was enough.' },
  ], {
    tools: [{
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: '{"stdout":"preview"}', durableResult: complete }; },
    }],
    ceiling: ['peek'],
  });
  await loopIn(boot);
  assert.equal(boot.llm.seen[1].messages.at(-1).content, '{"stdout":"preview"}');
  const logged = boot.session.readSync().find(event => event.type === 'tool.result' && event.data.callId === 'large');
  assert.deepEqual(logged.data.result, complete);
  await boot.kernel.dispose();
});

test('all schema errors from one tool call reach the model in one logged result', async () => {
  let ran = 0;
  const boot = await bootFor([
    {
      content: '',
      toolCalls: [{ id: 'bad-args', name: 'peek', args: { path: 7, extra: true } }],
    },
    { content: 'I corrected both arguments from the validation result.' },
  ], {
    tools: [{
      name: 'peek', description: 'Look.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path', 'depth'],
        properties: { path: { type: 'string' }, depth: { type: 'integer', minimum: 1 } },
      },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { ran += 1; return { content: 'must not run' }; },
    }],
    ceiling: ['peek'],
  });

  const result = await loopIn(boot);
  const received = boot.llm.seen[1].messages.filter(message => message.role === 'tool');
  assert.equal(received.length, 1, 'one invalid call becomes one model-visible tool result');
  assert.match(received[0].content, /3 argument errors/);
  assert.match(received[0].content, /args\.depth/);
  assert.match(received[0].content, /args\.extra/);
  assert.match(received[0].content, /args\.path/);
  assert.equal(ran, 0);
  assert.equal(result.content, 'I corrected both arguments from the validation result.');

  const logged = boot.session.readSync().filter(event =>
    event.type === 'tool.result' && event.data.callId === 'bad-args');
  assert.equal(logged.length, 1, 'the aggregate result is durable as one event too');
  assert.match(logged[0].data.error, /args\.depth.*args\.extra.*args\.path/);
  await boot.kernel.dispose();
});

test('tool input start/delta/end fragments are durable before the settled response', async () => {
  const boot = await bootFor([
    {
      content: '',
      chunks: [
        { toolInput: { inputId: 'input-1', index: 0, phase: 'start', toolCallId: 'c1', name: 'peek' } },
        { toolInput: { inputId: 'input-1', index: 0, phase: 'delta', toolCallId: 'c1', name: 'peek', delta: '{"at":' } },
        { toolInput: { inputId: 'input-1', index: 0, phase: 'delta', toolCallId: 'c1', name: 'peek', delta: '"x"}' } },
        { toolInput: { inputId: 'input-1', index: 0, phase: 'end', toolCallId: 'c1', name: 'peek', arguments: '{"at":"x"}' } },
      ],
      toolCalls: [{ id: 'c1', name: 'peek', args: { at: 'x' } }],
    },
    { content: 'done' },
  ], {
    tools: [{
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: 'ok' }; },
    }],
    ceiling: ['peek'],
  });

  await loopIn(boot);
  const events = boot.session.readSync();
  const lifecycle = events.filter(event => event.type.startsWith('tool.input.'));
  assert.deepEqual(lifecycle.map(event => event.type), [
    'tool.input.start', 'tool.input.delta', 'tool.input.delta', 'tool.input.end',
  ]);
  assert.equal(lifecycle.map(event => event.data.delta ?? '').join(''), '{"at":"x"}');
  assert.equal(lifecycle.at(-1).data.arguments, '{"at":"x"}');
  assert.ok(lifecycle.at(-1).seq < events.find(event => event.type === 'llm.response').seq,
    'the complete input is durable before the response can commit the call');
  await boot.kernel.dispose();
});

test('a reasoning-only worker turn is retained and prompted for an actionable next turn', async () => {
  const boot = await bootFor([
    { content: '', reasoning: 'I worked through the task.', finishReason: 'stop' },
    { content: 'Here is the answer.' },
  ], {
    tools: [{
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: 'unused' }; },
    }],
    ceiling: ['peek'],
  });

  const result = await loopIn(boot);
  assert.equal(result.stopped, 'answered');
  assert.equal(result.content, 'Here is the answer.');
  assert.equal(boot.llm.seen.length, 2);
  assert.match(boot.llm.seen[1].messages.at(-1).content, /internal reasoning was recorded/i);
  const events = boot.session.readSync();
  assert.ok(events.some(event => event.type === 'llm.response' && event.data.reasoning === 'I worked through the task.'));
  assert.ok(events.some(event => event.type === 'block.warning' && event.data.code === 'empty_turn_repair'));
  await boot.kernel.dispose();
});

test('a burst of provider chunks is persisted as one durable stream batch', async () => {
  const content = Array.from({ length: 200 }, (_, index) => `${index},`).join('');
  const boot = await bootFor([{ content, chunks: Array.from(content, text => ({ text })) }]);
  try {
    await runAgentLoop({
      ctx: boot.kernel.ctx, session: boot.session, runId: 'run-1', blockId: 'work',
      turn: 1, model: 'fake', system: 'system', input: 'go',
    });
    const stream = boot.session.readSync().filter(event => event.type === 'llm.stream');
    assert.equal(stream.length, 1, 'synchronous token bursts do not become hundreds of fs appends');
    assert.equal(stream.map(event => event.data.text ?? '').join(''), content);
  } finally { await boot.kernel.dispose(); fs.rmSync(boot.root, { recursive: true, force: true }); }
});

test('a query records a compact canonical prompt reference and carries structural call controls', async () => {
  const boot = await bootFor([{ content: 'Done.' }]);
  await loopIn(boot, { maxTokens: 12_288, temperature: 0.1 });
  assert.equal(boot.llm.seen[0].maxTokens, 12_288);
  assert.equal(boot.llm.seen[0].temperature, 0.1);
  const events = [];
  for await (const event of boot.session.read()) events.push(event);
  const prompt = events.find(event => event.type === 'step.prompt');
  assert.deepEqual(prompt.data.content, {
    source: 'canonical-session', throughSeq: 4, afterSeq: 0, blockId: 'work', messageCount: 2, tools: [],
  });
  assert.deepEqual(boot.llm.seen[0].messages.map(message => [message.role, message.content]), [
    ['system', 'You are a block.'], ['user', 'Do the thing.'],
  ], 'the lossless messages still come from the canonical events');
  assert.equal(events.find(event => event.type === 'llm.request').data.maxTokens, 12_288);
  await boot.kernel.dispose();
});

test('a working agent warns at its soft step threshold and keeps going', async () => {
  const calls = [1, 2, 3].map(index => ({
    content: '', toolCalls: [{ id: `c${index}`, name: 'peek', args: { index } }],
  }));
  const boot = await bootFor([...calls, { content: 'Finished after the warning.' }], {
    tools: [{
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: 'useful context' }; },
    }],
    ceiling: ['peek'],
  });

  const result = await loopIn(boot, { softMaxSteps: 3 });
  assert.equal(result.stopped, 'answered');
  assert.equal(result.steps, 4);
  assert.equal(result.content, 'Finished after the warning.');
  const events = [];
  for await (const event of boot.session.read()) events.push(event);
  const warning = events.find(event => event.type === 'block.warning' && event.data.code === 'soft_step_limit');
  assert.match(warning.data.reason, /soft limit.*continue/i);
  assert.equal(warning.data.transient, true);
  assert.equal(boot.llm.seen.length, 4, 'the warning did not stop the next query');
  await boot.kernel.dispose();
});

test('a token-truncated worker warns and continues in another query', async () => {
  const boot = await bootFor([
    { content: 'partial work', finishReason: 'length' },
    { content: 'finished work', finishReason: 'stop' },
  ]);

  const result = await loopIn(boot, { maxTokens: 32_768, continueOnLength: true });
  assert.equal(result.stopped, 'answered');
  assert.equal(result.steps, 2);
  assert.equal(result.content, 'partial workfinished work', 'the continued deliverable retains the truncated prefix');
  assert.equal(boot.llm.seen.length, 2);
  assert.match(boot.llm.seen[1].messages.at(-1).content, /Continue from where it stopped/);
  const events = [];
  for await (const event of boot.session.read()) events.push(event);
  assert.ok(events.some(event => event.type === 'block.warning' && event.data.code === 'soft_token_limit'));
  await boot.kernel.dispose();
});

test('reasoning-only length stops use bounded turn repair instead of an unbounded continuation', async () => {
  const boot = await bootFor([
    { content: '', reasoning: 'thinking', finishReason: 'length' },
  ], {
    tools: [{
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: 'unused' }; },
    }],
    ceiling: ['peek'],
  });

  const result = await loopIn(boot, { continueOnLength: true, maxTurnRepairs: 2, maxTokens: 6000 });
  assert.equal(result.stopped, 'bound');
  assert.equal(boot.llm.seen.length, 3, 'the initial turn plus two repairs is a hard bound');
  assert.match(result.reason, /6,000-token completion allowance on reasoning/);
  assert.match(boot.llm.seen[1].messages.at(-1).content, /do not restart the analysis/);
  assert.ok(boot.llm.seen.every(request => request.maxTokens === 6000), 'recovery respects the configured ceiling');
  const events = boot.session.readSync();
  assert.equal(events.filter(event => event.type === 'block.warning'
    && event.data.code === 'empty_turn_repair').length, 2);
  assert.equal(events.filter(event => event.type === 'block.warning'
    && event.data.code === 'soft_token_limit').length, 0,
  'reasoning without visible output is not mislabeled as a partial deliverable');
  await boot.kernel.dispose();
});

test('visible length continuations have an explicit hard bound', async () => {
  const boot = await bootFor([{ content: 'part', finishReason: 'length' }]);
  const result = await loopIn(boot, {
    continueOnLength: true, maxLengthContinuations: 2,
  });
  assert.equal(result.stopped, 'bound');
  assert.equal(result.steps, 3);
  assert.equal(result.content, 'partpartpart', 'partial output is preserved when the safety bound stops the loop');
  assert.match(result.reason, /continuation limit is 2/i);
  assert.equal(boot.llm.seen.length, 3);
  await boot.kernel.dispose();
});

test('a fallback that answered is preferred for the remaining tool steps', async () => {
  const boot = await bootFor([
    {
      content: '',
      toolCalls: [{ id: 'c1', name: 'peek', args: {} }],
      route: {
        requested: 'free-primary', effective: 'openrouter/free-backup',
        reason: 'the configured fallback answered', degraded: true,
      },
    },
    { content: 'done' },
  ], {
    tools: [{
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: 'ok' }; },
    }],
    ceiling: ['peek'],
  });

  await loopIn(boot, { model: 'free-primary', fallbackModels: ['free-backup', 'free-last'] });
  assert.deepEqual(boot.llm.seen.map(call => [call.model, call.fallbackModels]), [
    ['free-primary', ['free-backup', 'free-last']],
    ['free-backup', ['free-last', 'free-primary']],
  ]);
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

const peekTool = () => {
  let ran = 0;
  return {
    get ran() { return ran; },
    definition: {
      name: 'peek', description: 'Look.', parameters: { type: 'object' },
      classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { ran += 1; return { content: 'useful context' }; },
    },
  };
};

test('a hard-bounded worker with boundedAnswer loses its tools at the bound and still delivers', async () => {
  const peek = peekTool();
  const boot = await bootFor([
    { content: '', toolCalls: [{ id: 'c1', name: 'peek', args: { at: 1 } }] },
    { content: '', toolCalls: [{ id: 'c2', name: 'peek', args: { at: 2 } }] },
    // The bound has passed: this call is refused, not executed.
    { content: '', toolCalls: [{ id: 'c3', name: 'peek', args: { at: 3 } }] },
    { content: 'What I found so far, with the coverage limit stated.' },
  ], { tools: [peek.definition], ceiling: ['peek'] });

  const result = await loopIn(boot, { maxSteps: 2, boundedAnswer: true });
  assert.equal(result.stopped, 'answered', 'the deliverable is kept instead of discarded at the bound');
  assert.equal(result.toolsWithdrawn, 'step_bound',
    'and the caller is told the answer came after the tools were taken away');
  assert.equal(result.content, 'What I found so far, with the coverage limit stated.');
  assert.equal(result.steps, 4);
  assert.equal(peek.ran, 2, 'no tool runs after the bound');
  assert.deepEqual(boot.llm.seen.map(request => request.tools), [['peek'], ['peek'], [], []],
    'every turn after the bound offers no tools');
  const events = [];
  for await (const event of boot.session.read()) events.push(event);
  const hard = events.filter(event => event.type === 'block.warning' && event.data.code === 'hard_step_limit');
  assert.equal(hard.length, 1);
  assert.equal(hard[0].data.transient, false);
  assert.match(hard[0].data.reason, /all 2 of its hard-bounded tool rounds/);
  const refused = events.find(event => event.type === 'tool.result' && event.data.callId === 'c3');
  assert.match(refused.data.error, /used all 2 of its tool rounds/);
  assert.equal(refused.data.durableProgress, false);
  assert.equal(events.at(-1).type, 'turn.end');
  await boot.kernel.dispose();
});

test('a worker that keeps requesting tools through every answer-only turn ends bound, not forever', async () => {
  const peek = peekTool();
  const boot = await bootFor([
    { content: '', toolCalls: [{ id: 'c1', name: 'peek', args: {} }] },
  ], { tools: [peek.definition], ceiling: ['peek'] });

  const result = await loopIn(boot, { maxSteps: 2, boundedAnswer: true });
  assert.equal(result.stopped, 'bound');
  assert.match(result.reason, /all 3 answer-only turns after using its 2-round hard bound/);
  assert.equal(boot.llm.seen.length, 5, 'two bounded rounds plus three answer-only turns');
  assert.equal(peek.ran, 2);
  await boot.kernel.dispose();
});

test('without boundedAnswer the hard bound still stops the loop outright', async () => {
  const peek = peekTool();
  const boot = await bootFor([
    { content: '', toolCalls: [{ id: 'c1', name: 'peek', args: {} }] },
  ], { tools: [peek.definition], ceiling: ['peek'] });
  const result = await loopIn(boot, { maxSteps: 2 });
  assert.equal(result.stopped, 'bound');
  assert.equal(boot.llm.seen.length, 2);
  await boot.kernel.dispose();
});
