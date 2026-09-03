import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKernel, flytTools, sessionJsonl, runAgentLoop } from '#kernel';
import { provideSeam } from '../kernel/dist/seams/index.js';

const streamOf = answer => ({
  async *[Symbol.asyncIterator]() {},
  async settled() { return answer; },
});

test('tool calls persist the canonical lifecycle and an invalid original settles before repair', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-tool-state-'));
  const kernel = createKernel();
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(sessionJsonl, { root });
  kernel.ctx.tools.register({
    name: 'read_file', description: 'Read',
    parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } },
    classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
    async execute(args) { return { content: `read ${args.path}` }; },
  });
  let call = 0;
  const seam = {
    stream() {
      call += 1;
      if (call === 1) return streamOf({
        content: '', finishReason: 'tool_calls', route: { requested: 'm', effective: 'm', reason: '', degraded: false },
        toolCalls: [{ id: 'original', name: 'Read_File', args: {} }],
      });
      if (call === 2) return streamOf({
        content: '', finishReason: 'tool_calls', route: { requested: 'm', effective: 'm', reason: '', degraded: false },
        toolCalls: [{ id: 'repair', name: 'read_file', args: '{"path":"README.md"}' }],
      });
      return streamOf({ content: 'done', finishReason: 'stop', route: { requested: 'm', effective: 'm', reason: '', degraded: false } });
    },
    async complete() { throw new Error('unused'); }, async models() { return []; },
  };
  await kernel.ctx.plugin({ name: 'state-llm', apply(ctx) { return provideSeam(ctx, 'llm', seam); } });
  try {
    const session = await kernel.ctx.sessions.open('run');
    const result = await runAgentLoop({
      ctx: kernel.ctx, session, runId: 'run', blockId: 'work', turn: 1,
      model: 'm', system: 'system', input: 'read', tools: [kernel.ctx.tools.get('read_file')],
      ceiling: ['read_file'], maxSteps: 4,
    });
    assert.equal(result.content, 'done');
    const events = [];
    for await (const event of session.read()) events.push(event);
    const states = id => events.filter(event => event.type === 'tool.state' && event.data.callId === id).map(event => event.data.state);
    assert.deepEqual(states('original'), ['received', 'normalized', 'failed']);
    assert.deepEqual(states('repair'), ['received', 'normalized', 'validated', 'authorized', 'running', 'completed']);
    const normalized = events.find(event => event.type === 'tool.state' && event.data.callId === 'original' && event.data.state === 'normalized');
    assert.equal(normalized.data.name, 'read_file');
    assert.deepEqual(normalized.data.args, {});
  } finally {
    await kernel.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restart reconciliation explicitly interrupts every nonterminal call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-tool-reconcile-'));
  const kernel = createKernel();
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(sessionJsonl, { root });
  const seam = {
    stream: () => streamOf({ content: 'recovered', finishReason: 'stop', route: { requested: 'm', effective: 'm', reason: '', degraded: false } }),
    async complete() { throw new Error('unused'); }, async models() { return []; },
  };
  await kernel.ctx.plugin({ name: 'reconcile-llm', apply(ctx) { return provideSeam(ctx, 'llm', seam); } });
  try {
    const session = await kernel.ctx.sessions.open('run');
    await session.append({ type: 'tool.state', data: { blockId: 'work', callId: 'orphan', state: 'running' } });
    await runAgentLoop({ ctx: kernel.ctx, session, runId: 'run', blockId: 'work', turn: 2, model: 'm', system: 's', input: 'resume' });
    const events = [];
    for await (const event of session.read()) events.push(event);
    const reconciled = events.find(event => event.type === 'tool.state' && event.data.callId === 'orphan' && event.data.reconciled);
    assert.equal(reconciled.data.state, 'interrupted');
  } finally {
    await kernel.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('identical successful globs are cached and answer-only recovery tolerates unoffered tool calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-tool-repeat-'));
  const kernel = createKernel();
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(sessionJsonl, { root });
  let executions = 0;
  kernel.ctx.tools.register({
    name: 'glob', description: 'List files',
    parameters: {
      type: 'object', additionalProperties: false, required: ['pattern'],
      properties: { pattern: { type: 'string' } },
    },
    classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
    async execute() {
      executions += 1;
      return { content: JSON.stringify({ count: 2, truncated: true, nextOffset: 2, paths: ['a', 'b'] }) };
    },
  });
  const requests = [];
  let modelCall = 0;
  const seam = {
    stream(request) {
      requests.push(request);
      modelCall += 1;
      if (modelCall <= 7) return streamOf({
        content: '', finishReason: 'tool_calls', route: { requested: 'm', effective: 'm', reason: '', degraded: false },
        toolCalls: [{ id: `glob-${modelCall}`, name: 'glob', args: { pattern: '**/*' } }],
      });
      return streamOf({
        content: 'Completed from the files already listed; the listing was truncated.',
        finishReason: 'stop', route: { requested: 'm', effective: 'm', reason: '', degraded: false },
      });
    },
    async complete() { throw new Error('unused'); }, async models() { return []; },
  };
  await kernel.ctx.plugin({ name: 'repeat-llm', apply(ctx) { return provideSeam(ctx, 'llm', seam); } });
  try {
    const session = await kernel.ctx.sessions.open('run');
    const result = await runAgentLoop({
      ctx: kernel.ctx, session, runId: 'run', blockId: 'worker', turn: 1,
      model: 'm', system: 'system', input: 'inventory', tools: [kernel.ctx.tools.get('glob')],
      ceiling: ['glob'], maxSteps: 8,
    });
    assert.equal(result.stopped, 'answered');
    assert.equal(result.toolsWithdrawn, 'repeated_read',
      'the answer is reported as one produced without tools, not as an ordinary finish');
    assert.match(result.content, /Completed from the files already listed/);
    assert.equal(executions, 1, 'four byte-identical reads reuse the first result');
    assert.equal(requests[5].tools, undefined, 'the recovery request offers no tools');
    assert.equal(requests[6].tools, undefined, 'a provider violation retries without restoring tools');
    assert.equal(requests[7].tools, undefined, 'the eventual answer is still requested without tools');

    const events = [];
    for await (const event of session.read()) events.push(event);
    assert.equal(events.filter(event => event.type === 'tool.result' && event.data.cached === true).length, 4);
    assert.ok(events.some(event => event.type === 'block.warning' && event.data.code === 'repeated_read_recovery'));
    assert.equal(events.filter(event => event.type === 'block.warning' && event.data.code === 'answer_only_tool_refused').length, 2);
    assert.equal(events.filter(event => event.type === 'tool.result' && event.data.error?.includes('answer-only recovery')).length, 2,
      'unoffered recovery calls are refused and protocol-balanced without execution');
    assert.equal(events.some(event => event.type === 'permission.decision'), false,
      'an unattended recovery is not misreported as a denied human decision');
  } finally {
    await kernel.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
