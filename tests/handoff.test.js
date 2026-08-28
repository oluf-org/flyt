// The handoff test (t-0063): `loop-task` end to end on the new kernel.
//
// The gate on everything after Phase 1. The app cannot build itself on a
// runtime that cannot run the stack defining how it builds things, so this
// walks the whole chain with nothing faked except the provider at the far end:
//
//   the stack file -> the parser -> ctx.agents -> the block registry ->
//   the work block -> the shared agent loop -> ctx.llm -> the adapter bridge
//     ... and back out through ctx.tools, the permission gate, the session
//     log, the projection, and the trace a person reads.
//
// What is faked is `callModel`, because a test must not call a provider. Every
// other seam is the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKernel, parseStack, LOOP_CEILING, workBlock,
  flytBlocks, flytBlocksCore, flytTools, flytApprovals, flytAdapters,
  flytStackRunner, flytRunProjection, sessionJsonl,
} from '#kernel';
import { foldTrace } from '../src/traceModel.js';
import { traceView } from '../src/v2/traceView.js';
import { runView } from '../src/v2/runView.js';

const STACK_FILE = fileURLToPath(new URL('../stacks/loop-task.stack.yaml', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-handoff-'));

/** A model that reads a file, writes one, and reports. Scripted, in order. */
function scriptedProvider(workspace) {
  const turns = [
    {
      text: 'Reading the file the task names.',
      message: { tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src.js' }) } }] },
      finishReason: 'tool_calls',
    },
    {
      text: 'Writing the change.',
      message: { tool_calls: [{ id: 'c2', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src.js', content: 'export const version = 2;\n' }) } }] },
      finishReason: 'tool_calls',
    },
    {
      // A tool the ceiling does not name. It must come back as a refusal the
      // model reads, not as an exception that ends the run.
      text: 'Trying the web.',
      message: { tool_calls: [{ id: 'c3', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.test' }) } }] },
      finishReason: 'tool_calls',
    },
    { text: 'Refused the web, and the change is written. Done.', finishReason: 'stop' },
  ];
  let i = 0;
  const seen = [];
  return {
    seen,
    async callModel(request) {
      seen.push(request);
      const turn = turns[Math.min(i++, turns.length - 1)];
      return {
        ...turn,
        provider: 'fake', model: request.model,
        usage: { prompt_tokens: 1000 + i, completion_tokens: 40, cost: 0.001 },
      };
    },
    workspace,
  };
}

/** The whole tree, composed the way a Loop worker's profile would. */
async function bootHandoff(root, workspace) {
  const provider = scriptedProvider(workspace);
  const kernel = createKernel();
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin(flytRunProjection, { root });
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(flytApprovals, { mode: 'always' });
  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin(flytAdapters, {
    callModel: provider.callModel,
    resolve: model => ({ provider: 'fake', model }),
  });
  // These stand in for Flyt's composed built-in definitions, registered by the
  // kernel rather than an external plugin. The gate they pass is still real.
  {
      const ctx = kernel.ctx;
      const classified = effect => ({ effect, destructive: false, untrustedInput: false, source: 'confirmed' });
      ctx.tools.register({
        name: 'read_file', description: 'Read a file.', parameters: { type: 'object' },
        classification: classified('read'),
        async execute(args) {
          return { content: fs.readFileSync(path.join(workspace, args.path), 'utf8') };
        },
      });
      ctx.tools.register({
        name: 'write_file', description: 'Write a file.', parameters: { type: 'object' },
        classification: classified('write'),
        async execute(args, execution) {
          fs.writeFileSync(path.join(workspace, args.path), args.content, 'utf8');
          const session = await kernel.ctx.sessions.open(execution.runId);
          await session.append({
            type: 'workspace.observed',
            data: { changed: true, kind: 'test-workspace', tool: 'write_file' },
          });
          return { content: `wrote ${args.path}` };
        },
      });
      // Registered but NOT in the loop ceiling. Whether the gate holds is the
      // point of having one.
      ctx.tools.register({
        name: 'web_fetch', description: 'Fetch a URL.', parameters: { type: 'object' },
        classification: { effect: 'read', destructive: false, untrustedInput: true, source: 'confirmed' },
        async execute() { throw new Error('the ceiling should have stopped this'); },
      });
  }
  await kernel.ctx.plugin(flytBlocksCore);

  const stack = parseStack(fs.readFileSync(STACK_FILE, 'utf8'));
  await kernel.ctx.plugin(flytStackRunner, {
    stacks: { resolve: id => (id === stack.id ? stack.root : null) },
    ceiling: LOOP_CEILING,
  });
  return { kernel, provider, stack };
}

test('the loop-task stack file parses, and names a block a plugin contributes', () => {
  const stack = parseStack(fs.readFileSync(STACK_FILE, 'utf8'));
  assert.equal(stack.id, 'loop-task');
  assert.equal(stack.root.children.length, 1, 'one block, which is the whole point of this stack');
  const block = stack.root.children[0];
  assert.equal(block.use, 'flyt-blocks-core:work');
  assert.equal(block.config.effect, 'workspace-change',
    'the deliverable contract, so the block fails where the work was');
  // The block is a PLUGIN's, not loose JSON in `nodes/`.
  assert.equal(workBlock.use, block.use);
});

test('its ceiling is explicit on the canonical Loop stack — asserted, not assumed', () => {
  // D45. The repository, the shell, the queue, the failed run, and a way to ask
  // a human. Not the web: a task that needs it asks for it.
  assert.ok(LOOP_CEILING.includes('bash'), 'a task judged by `npm test` must be able to run it');
  assert.ok(LOOP_CEILING.includes('run_gate'));
  assert.ok(LOOP_CEILING.includes('edit_file'));
  assert.ok(LOOP_CEILING.includes('ask_human'));
  assert.ok(!LOOP_CEILING.includes('web_fetch'), 'the web is not in an unattended worker’s ceiling');
  assert.ok(!LOOP_CEILING.includes('web_search'));
  assert.equal(workBlock.ceiling, LOOP_CEILING, 'and it is named on the block, not left to a template');
});

test('loop-task runs end to end on the v2 kernel', async () => {
  const root = tmp();
  const workspace = tmp();
  fs.writeFileSync(path.join(workspace, 'src.js'), 'export const version = 1;\n');
  const { kernel, provider } = await bootHandoff(root, workspace);

  const run = await kernel.ctx.agents.start({ id: 'loop-task', runId: 'handoff-1' }, 'Bump the version in src.js.');
  const outcome = await run.settled();

  assert.equal(outcome.status, 'done', `it must finish: ${outcome.error ?? outcome.reason ?? ''}`);
  // It CHANGED THE WORKSPACE, which is the whole contract of this stack.
  assert.equal(fs.readFileSync(path.join(workspace, 'src.js'), 'utf8'), 'export const version = 2;\n');
  assert.equal(provider.seen.length, 4, 'four model turns, in the order the script wrote them');
  await kernel.dispose();
});

test('the ceiling holds: a tool it does not name comes back as a refusal the model reads', async () => {
  const root = tmp();
  const workspace = tmp();
  fs.writeFileSync(path.join(workspace, 'src.js'), 'export const version = 1;\n');
  const { kernel, provider } = await bootHandoff(root, workspace);
  await (await kernel.ctx.agents.start({ id: 'loop-task', runId: 'handoff-2' }, 'Bump it.')).settled();

  // The fourth request is the one made after the refusal, so its message list
  // holds the refusal the model was answering.
  const answered = provider.seen.at(-1).messages.filter(m => m.role === 'tool');
  const refusal = answered.find(m => /Refused/.test(m.content));
  assert.ok(refusal, `a denied call must reach the model as a result: ${JSON.stringify(answered.map(m => m.content.slice(0, 60)))}`);
  assert.match(refusal.content, /not in this block's ceiling/);
  await kernel.dispose();
});

test('the run is watchable in Work and reopens in Trace, from its log', async () => {
  const root = tmp();
  const workspace = tmp();
  fs.writeFileSync(path.join(workspace, 'src.js'), 'export const version = 1;\n');
  const { kernel } = await bootHandoff(root, workspace);
  await (await kernel.ctx.agents.start({ id: 'loop-task', runId: 'handoff-3' }, 'Bump it.')).settled();
  await kernel.dispose();

  // A NEW kernel, reading the log off disk. No live process anywhere.
  const reader = createKernel();
  await reader.ctx.plugin(sessionJsonl, { root });
  const session = await reader.ctx.sessions.read('handoff-3');
  const events = [];
  for await (const e of session.read()) events.push(e);
  const trace = foldTrace(events);

  const detail = traceView(trace);
  assert.equal(detail.turns.length, 1, 'one block, one turn');
  assert.equal(detail.turns[0].steps.length, 4, 'and its four steps');
  assert.ok(detail.turns[0].steps.some(s => s.tools.some(t => t.name === 'write_file')),
    'the write is in the record');
  assert.ok(detail.turns[0].steps.some(s => s.tools.some(t => /Refused/.test(String(t.result ?? '')))),
    'and so is the refusal');
  assert.equal(detail.unfinished, false);

  const work = runView(trace);
  assert.equal(work.blocks.work.status, 'done');
  assert.equal(work.stage, 'done');
  assert.match(work.blocks.work.showing, /Done\./, 'Work shows what the block produced');

  await reader.dispose();
});

test('the run folder is beside the log, projected as it went', async () => {
  const root = tmp();
  const workspace = tmp();
  fs.writeFileSync(path.join(workspace, 'src.js'), 'export const version = 1;\n');
  const { kernel } = await bootHandoff(root, workspace);
  await (await kernel.ctx.agents.start({ id: 'loop-task', runId: 'handoff-4' }, 'Bump it.')).settled();
  await new Promise(r => setTimeout(r, 80)); // the projection settles a beat behind
  await kernel.dispose();

  const dir = path.join(root, 'handoff-4');
  assert.ok(fs.existsSync(path.join(dir, 'session.jsonl')), 'the record');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.stage, 'done');
  assert.match(fs.readFileSync(path.join(dir, 'blocks', 'work.md'), 'utf8'), /Done\./);
  const tools = fs.readdirSync(path.join(dir, 'tools'));
  assert.ok(tools.length >= 2, `the tool results are projected in full: ${tools.join(', ')}`);
});

test('the same stack is what the editor’s commands produce', async () => {
  // "Authored in the new editor" is a claim about the COMMANDS, because that is
  // what the editor invokes — a drag works out a slot and calls
  // `stack:insert-block`, and a model calls the same one (D63). So the check
  // that means something is that driving those commands produces the stack the
  // file holds, rather than a screenshot of somebody dragging.
  const { flytApi, registerStackCommands } = await import('#kernel');
  const kernel = createKernel();
  await kernel.ctx.plugin(flytApi);

  let root = { kind: 'sequence', id: 'loop-task', children: [], position: { line: 0, path: '' } };
  registerStackCommands(kernel.ctx, { get: () => root, set: next => { root = next; } });

  const onDisk = parseStack(fs.readFileSync(STACK_FILE, 'utf8'));
  const authored = onDisk.root.children[0];
  await kernel.ctx.commands.invoke('stack:insert-block', {
    block: { id: authored.id, use: authored.use, title: authored.title, config: authored.config },
    at: { container: 'loop-task', index: 0 },
  }, 'human');

  const shape = node => ({
    kind: node.kind, id: node.id, use: node.use ?? null,
    title: node.title ?? null, config: node.config ?? null,
  });
  assert.deepEqual(root.children.map(shape), onDisk.root.children.map(shape),
    'the file and the commands describe the same stack');

  // And an agent gets the identical result, because there is one path.
  let byAgent = { kind: 'sequence', id: 'loop-task', children: [], position: { line: 0, path: '' } };
  const second = createKernel();
  await second.ctx.plugin(flytApi);
  registerStackCommands(second.ctx, { get: () => byAgent, set: next => { byAgent = next; } });
  await second.ctx.commands.invoke('stack:insert-block', {
    block: { id: authored.id, use: authored.use, title: authored.title, config: authored.config },
    at: { container: 'loop-task', index: 0 },
  }, 'agent');
  assert.deepEqual(byAgent.children.map(shape), root.children.map(shape));

  await kernel.dispose();
  await second.dispose();
});
