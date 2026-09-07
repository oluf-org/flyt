import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createKernel, flytBlocks, flytBlocksCore, flytBlocksJudgement, flytTools, flytApprovals,
  flytStackRunner, sessionJsonl, provideSeam,
} from '#kernel';

const block = (id, work = false) => ({
  kind: 'block', id, use: `flyt-blocks-core:${work ? 'work' : 'general-analysis'}`,
  config: { model: 'fake', systemPrompt: `ROLE_${id}`, ...(work ? { isolated: false } : {}) },
  outputs: [], position: { line: 1, column: 1 },
});
const sequence = (id, children) => ({ kind: 'sequence', id, children });
const parallel = (id, children, maxParallel = 1) => ({ kind: 'parallel', id, children, maxParallel });

async function boot(t, children, { overlap = false, failModel = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-context-'));
  const kernel = createKernel();
  t.after(async () => { await kernel.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(flytApprovals, { mode: 'always' });
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin(flytBlocksCore);
  const seen = [];
  let arrivals = 0;
  let release;
  const bothLanes = new Promise(resolve => { release = resolve; });
  await kernel.ctx.plugin({
    name: 'context-test-model',
    apply(ctx) {
      return provideSeam(ctx, 'llm', {
        stream(request) {
          if (failModel) throw new Error('test provider unavailable');
          const role = request.messages.filter(m => m.role === 'system').at(-1).content.match(/ROLE_(\w+)/)[1];
          seen.push({ role, messages: structuredClone(request.messages) });
          const tools = request.tools?.length && !request.messages.some(m => m.role === 'tool');
          const toolCalls = tools ? [{ id: `call_${role}`, name: 'read_file', args: {} }] : [];
          const result = {
            content: tools ? `private_thought_${role}` : `artifact_${role}`,
            toolCalls, finishReason: tools ? 'tool_calls' : 'stop',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
          const gated = overlap && tools && ['left', 'right'].includes(role);
          if (gated && ++arrivals === 2) release();
          return {
            async *[Symbol.asyncIterator]() {
              if (gated) await bothLanes;
              yield { text: result.content };
              for (const toolCall of toolCalls) yield { toolCall };
            },
            async settled() { return result; },
          };
        },
        async models() { return []; },
      });
    },
  });
  await flytTools.installPlugin(kernel.ctx, {
    name: 'context-test-tools', inject: ['tools'],
    apply(ctx) {
      ctx.tools.register({
        name: 'read_file', description: 'Read evidence', parameters: { type: 'object' },
        classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
        async execute() { return { content: 'private_tool_evidence' }; },
      });
    },
  }, { attended: true, decide: (_name, proposals) => Object.fromEntries(proposals.map(p => [p.name, p])) });
  await kernel.ctx.plugin(flytStackRunner, {
    stacks: { resolve: () => sequence('root', children) }, ceiling: ['read_file'],
  });
  const session = await kernel.ctx.sessions.open('context-run');
  const start = async () => (await kernel.ctx.agents.start({ id: 'context', runId: 'context-run' }, 'original_input')).settled();
  return { kernel, session, seen, start };
}

for (const maxParallel of [1, 2]) {
  test(`model requests isolate lanes with maxParallel=${maxParallel}, retaining only own tool rounds`, { timeout: 10000 }, async t => {
    const b = await boot(t, [
      block('before'),
      parallel('fan', [sequence('lane_left', [block('left', true), block('left_final')]),
        sequence('lane_right', [block('right', true), block('right_final')])], maxParallel),
      block('join'), block('after'),
    ], { overlap: maxParallel === 2 });
    assert.equal((await b.start()).status, 'done');
    for (const role of ['left', 'right']) {
      const requests = b.seen.filter(r => r.role === role);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0].messages.map(m => m.role), ['system', 'user']);
      assert.equal(requests[0].messages[1].content, 'artifact_before');
      assert.deepEqual(requests[1].messages.map(m => m.role), ['system', 'user', 'assistant', 'tool']);
      assert.equal(requests[1].messages[2].content, `private_thought_${role}`);
      assert.equal(requests[1].messages[3].content, 'private_tool_evidence');
      const next = b.seen.find(r => r.role === `${role}_final`);
      assert.deepEqual(next.messages, [
        { role: 'system', content: `ROLE_${role}_final` },
        { role: 'user', content: `artifact_${role}` },
      ]);
    }
    const join = b.seen.find(r => r.role === 'join');
    assert.deepEqual(join.messages, [
      { role: 'system', content: 'ROLE_join' },
      { role: 'user', content: '## lane_left\nartifact_left_final\n\n## lane_right\nartifact_right_final' },
    ]);
    assert.deepEqual(b.seen.find(r => r.role === 'after').messages, [
      { role: 'system', content: 'ROLE_after' }, { role: 'user', content: 'artifact_join' },
    ]);
    const log = [];
    for await (const event of b.session.read()) log.push(event);
    for (const role of ['left', 'right']) {
      const active = log.find(e => e.type === 'block.status' && e.data.blockId === role);
      assert.equal(active.data.context.mode, 'block-input');
      const firstCall = log.find(e => e.type === 'llm.request' && e.data.blockId === role);
      assert.deepEqual(await b.session.deriveMessages(firstCall.seq, role, active.data.context.after),
        b.seen.find(r => r.role === role).messages, 'request is reconstructable from the parent log');
    }
  });
}

test('nested joins expose only the selected inner artifacts to the outer join', async t => {
  const b = await boot(t, [parallel('outer', [
    sequence('outer_left', [block('seed'), parallel('inner', [
      sequence('inner_left', [block('a')]), sequence('inner_right', [block('b')]),
    ]), block('inner_join')]),
    sequence('outer_right', [block('independent')]),
  ]), block('outer_join')]);
  assert.equal((await b.start()).status, 'done');
  assert.equal(b.seen.find(r => r.role === 'independent').messages[1].content, 'original_input');
  assert.equal(b.seen.find(r => r.role === 'inner_join').messages[1].content,
    '## inner_left\nartifact_a\n\n## inner_right\nartifact_b');
  assert.equal(b.seen.find(r => r.role === 'outer_join').messages[1].content,
    '## outer_left\nartifact_inner_join\n\n## outer_right\nartifact_independent');
});

test('resume retains unfinished own tool history but excludes completed siblings and older invocations', async t => {
  const b = await boot(t, [parallel('fan', [
    sequence('lane_left', [block('left')]), sequence('lane_right', [block('right', true)]),
  ])]);
  const append = (type, data) => b.session.append({ type, data });
  await append('run.created', { stackId: 'context', input: 'original_input' });
  await append('message.system', { blockId: 'right', content: 'OLD_INVOCATION' });
  await append('block.status', { blockId: 'right', status: 'done' });
  const boundary = await b.session.head();
  await append('block.status', { blockId: 'right', status: 'active', context: { mode: 'block-input', after: boundary } });
  await append('message.system', { blockId: 'right', content: 'ROLE_right' });
  await append('llm.response', {
    blockId: 'right', content: 'own_unfinished_thought',
    toolCalls: [{ id: 'unfinished', name: 'read_file', args: {} }],
  });
  await append('message.system', { blockId: 'left', content: 'PRIVATE_SIBLING_SYSTEM' });
  await append('llm.response', { blockId: 'left', content: 'PRIVATE_SIBLING_THOUGHT' });
  await append('block.output', { blockId: 'left', content: 'artifact_left' });
  await append('block.status', { blockId: 'left', status: 'done' });
  await append('block.status', { blockId: 'right', status: 'pending', reason: 'interrupted before this block settled' });
  assert.equal((await (await b.kernel.ctx.agents.resume('context-run')).settled()).status, 'done');
  assert.deepEqual(b.seen.map(r => r.role), ['right']);
  const messages = b.seen[0].messages;
  assert.ok(messages.some(m => m.content === 'own_unfinished_thought'));
  assert.ok(messages.some(m => m.role === 'tool' && m.toolCallId === 'unfinished'));
  assert.doesNotMatch(JSON.stringify(messages), /OLD_INVOCATION|PRIVATE_SIBLING/);
});

test('each foreach item gets a fresh transcript even when the block id is reused', async t => {
  const b = await boot(t, [
    { ...block('roster'), use: 'test:roster' },
    { kind: 'foreach', id: 'items', roster: 'roster.items', max: 2, children: [block('item', true)] },
  ]);
  b.kernel.ctx.blocks.register({
    use: 'test:roster', title: 'Roster', description: '', category: 'utility',
    settings: {}, ceiling: [],
    async execute() { return { status: 'done', output: 'roster', structured: { items: ['first_item', 'second_item'] } }; },
  });
  assert.equal((await b.start()).status, 'done');
  assert.equal(b.seen.length, 4, 'both items run their own tool round');
  assert.deepEqual(b.seen[2].messages.map(m => m.role), ['system', 'user']);
  assert.equal(b.seen[2].messages[1].content, 'second_item');
  assert.doesNotMatch(JSON.stringify(b.seen[3].messages), /first_item/);
});

test('resumed sibling structured outputs are hidden until the explicit join', async t => {
  const condition = id => ({
    kind: 'if', id, predicate: { source: 'left.analysis', operator: 'is not empty' },
    children: [block(`${id}_yes`)], else: [block(`${id}_no`)],
  });
  const b = await boot(t, [parallel('fan', [
    sequence('lane_left', [block('left')]), sequence('lane_right', [condition('inside')]),
  ]), condition('outside')]);
  await b.session.append({ type: 'run.created', data: { stackId: 'context', input: 'original_input' } });
  await b.session.append({ type: 'block.output', data: { blockId: 'left', content: 'artifact_left' } });
  await b.session.append({ type: 'block.status', data: {
    blockId: 'left', status: 'done', structured: { analysis: 'artifact_left' },
  } });
  assert.equal((await (await b.kernel.ctx.agents.resume('context-run')).settled()).status, 'done');
  assert.deepEqual(b.seen.filter(r => !r.messages.some(m => m.role === 'tool')).map(r => r.role), ['inside_no', 'outside_yes']);
});

test('a degraded refiner carries only its own clarification from the current execution', async t => {
  const b = await boot(t, [], { failModel: true });
  const answer = (blockId, text) => b.session.append({ type: 'tool.result', data: {
    blockId, name: 'ask_human', content: JSON.stringify({ answer: text }),
  } });
  await answer('refiner', 'OLD_CLARIFICATION');
  const after = await b.session.head();
  await answer('refiner', 'OWN_CLARIFICATION');
  await answer('sibling', 'SIBLING_CLARIFICATION');
  const result = await flytBlocksJudgement.promptRefinerBlock.execute({
    ctx: b.kernel.ctx, runId: 'context-run', blockId: 'refiner',
    context: { mode: 'block-input', after }, input: 'original_input', ceiling: [], config: {},
  });
  assert.equal(result.status, 'done');
  assert.match(result.output, /OWN_CLARIFICATION/);
  assert.doesNotMatch(result.output, /OLD_CLARIFICATION|SIBLING_CLARIFICATION/);
});
