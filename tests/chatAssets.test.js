import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AssetStore, chatSubmission, projectAssets } from '../core/assets.js';
import { anthropicMessages } from '../core/adapters/transforms/anthropic.js';
import { catalogFromOpenRouter, modelFactsOf } from '../core/modelSource.js';
import { createKernel, flytBlocks, flytBlocksCore, flytTools, flytApprovals, flytStackRunner, sessionJsonl, flytAdapters, unknownCapability, projectRun } from '#kernel';
import { createEngine } from '../core/engine.js';
import { buildCodexArgs, stageCodexImages } from '../core/adapters/codexCli.js';
import { createApi } from '../core/api.js';
import { RunStore } from '../core/state.js';

const temp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-assets-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const png = () => sharp({ create: { width: 32, height: 24, channels: 4, background: '#2244ff' } }).png().toBuffer();
const ref = (letter = 'a') => ({ assetId: letter.repeat(64), kind: 'image', name: `${letter}.png`, mimeType: 'image/png', byteLength: 100, width: 32, height: 24 });
const block = id => ({ kind: 'block', id, use: 'test:asset', config: {}, outputs: [], position: { line: 1, column: 1 } });
const seq = (id, children) => ({ kind: 'sequence', id, children });

test('image import validates decoding, derives metadata, deduplicates atomically, and survives reopening', async t => {
  const root = temp(t); const store = new AssetStore(root); const bytes = await png();
  const imported = await Promise.all(Array.from({ length: 3 }, () => store.import({ name: 'screenshot.jpg', bytes })));
  assert.equal(new Set(imported.map(r => r.assetId)).size, 1);
  const asset = imported[0]; assert.equal(asset.mimeType, 'image/png'); assert.equal(asset.width, 32);
  assert.equal((await new AssetStore(root).read(asset, 'original')).bytes.equals(bytes), true);
  assert.equal((await store.references([{ ...asset, width: 999, byteLength: 0 }]))[0].width, 32);
  assert.deepEqual(fs.readdirSync(root), [asset.assetId]);
  await assert.rejects(store.import({ name: 'fake.png', bytes: Buffer.from('not an image') }), /fake.png/);
  await assert.rejects(store.import({ name: 'vector.png', bytes: Buffer.from('<svg width="10" height="10"></svg>') }), /Use PNG|unsupported/i);
  await assert.rejects(store.import({ bytes: Buffer.alloc(20 * 1024 ** 2 + 1) }), /20 MiB/);
  await assert.rejects(store.read({ assetId: '../outside' }), /Invalid asset ID/);
  await assert.rejects(new AssetStore(path.join(root, 'other-project')).read(asset), /missing or corrupt/);
  await assert.rejects(store.references(Array(11).fill(asset)), /10 images/);
  fs.writeFileSync(path.join(root, asset.assetId, 'original'), 'corrupt');
  await assert.rejects(store.read(asset, 'original'), /integrity/);
  await assert.rejects(store.import({ bytes }), /integrity/);
});

test('static GIF works; animated and oversized decoded images are rejected', async t => {
  const store = new AssetStore(temp(t));
  const staticGif = await sharp(await png()).gif().toBuffer();
  assert.equal((await store.import({ bytes: staticGif })).mimeType, 'image/gif');
  const animated = await sharp(Buffer.concat([Buffer.alloc(16, 80), Buffer.alloc(16, 220)]), { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } }).gif({ delay: [100, 100] }).toBuffer();
  await assert.rejects(store.import({ bytes: animated }), /Animated/);
  const huge = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(store.import({ bytes: huge }), /pixel limit/i);
});

test('asset scopes survive text steps, bounded parallel lanes, joins, iterations, and resume', async t => {
  const root = temp(t); const kernel = createKernel(); t.after(() => kernel.dispose());
  await kernel.ctx.plugin(flytBlocks); await kernel.ctx.plugin(sessionJsonl, { root });
  const seen = []; let fail = true;
  kernel.ctx.blocks.register({ use: 'test:asset', title: 'Assets', description: '', category: 'utility', settings: {}, ceiling: [], async execute(run) {
    seen.push({ id: run.blockId, executionId: run.context.executionId, assets: run.attachments.map(a => a.assetId) });
    if (run.blockId === 'after' && fail) { fail = false; await (await kernel.ctx.sessions.open(run.runId)).append({ type: 'run.stage', data: { stage: 'stopping' } }); await kernel.ctx.agents.stop(run.runId, 'test'); return { status: 'failed', output: '', error: 'stop' }; }
    return { status: 'done', output: `text from ${run.blockId}`, ...(run.blockId === 'left' ? { attachments: [ref('b')] } : {}) };
  } });
  const tree = seq('root', [block('plan'), { kind: 'parallel', id: 'fork', maxParallel: 1, children: [seq('leftLane', [block('left'), block('leftNext')]), seq('rightLane', [block('right')])] }, block('join'), { kind: 'repeat', id: 'repeat', count: 2, children: [block('repeatWork')] }, block('after')]);
  await kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => tree } });
  const run = await kernel.ctx.agents.start({ id: 'assets', runId: 'asset-run', metadata: { attachments: [ref()] } }, '');
  await run.settled();
  assert.deepEqual(seen.find(r => r.id === 'right').assets, [ref().assetId]);
  assert.deepEqual(seen.find(r => r.id === 'leftNext').assets, [ref().assetId, ref('b').assetId]);
  assert.deepEqual(seen.find(r => r.id === 'join').assets, [ref().assetId, ref('b').assetId]);
  assert.equal(new Set(seen.filter(r => r.id === 'repeatWork').map(r => r.executionId)).size, 2);
  const resumed = await kernel.ctx.agents.resume('asset-run'); assert.equal((await resumed.settled()).status, 'done');
  assert.deepEqual(seen.filter(r => r.id === 'after').at(-1).assets, [ref().assetId, ref('b').assetId]);
  assert.equal(seen.filter(r => r.id === 'plan').length, 1);
  const session = await kernel.ctx.sessions.read('asset-run'); const events = []; for await (const event of session.read()) events.push(event);
  const projection = projectRun(events, 'asset-run'); assert.deepEqual(projection.meta.contextAssets.right, [ref()]);
});

test('native image requests and replay preserve pixels, text, tool results, signed reasoning, and fallback budgets', async t => {
  const root = temp(t); const kernel = createKernel(); t.after(() => kernel.dispose());
  await kernel.ctx.plugin(flytBlocks); await kernel.ctx.plugin(flytTools); await kernel.ctx.plugin(flytApprovals, { mode: 'always' }); await kernel.ctx.plugin(sessionJsonl, { root }); await kernel.ctx.plugin(flytBlocksCore);
  const calls = [], budgets = [], attempts = []; const dataUrl = `data:image/png;base64,${(await png()).toString('base64')}`;
  await kernel.ctx.plugin(flytAdapters, {
    resolve: model => ({ provider: model === 'unknown' ? 'other' : 'openai', model }),
    capability: (model, provider) => { const profile = unknownCapability(model, provider); profile.modalities.image.value = model === 'vision'; return profile; },
    resolveAsset: async id => { assert.equal(id, ref().assetId); return { dataUrl, estimatedTokens: 4096, byteLength: 100 }; },
    callModel: async request => { calls.push(request); return { text: 'understood', finishReason: 'stop' }; },
  });
  const session = await kernel.ctx.sessions.open('replay');
  const parts = [{ type: 'text', text: 'inspect' }, { type: 'image', assetId: ref().assetId }];
  await session.append({ type: 'message.user', data: { blockId: 'node', content: 'inspect', parts } });
  const messages = await session.deriveMessages(); assert.deepEqual(messages[0].parts, parts);
  const request = { model: 'unknown', fallbackModels: ['vision'], messages, onBudget: b => budgets.push(b), onAttempt: a => attempts.push(a) };
  const stream = kernel.ctx.llm.stream(request); for await (const _ of stream) {} await stream.settled();
  assert.equal(calls.length, 1); assert.equal(calls[0].messages[0].content[1].image_url.url, dataUrl);
  assert.equal(budgets[0].effective.attachments, 4096); assert.equal(attempts.some(a => a.model === 'unknown' && a.status === 'failed'), true);
  const replay = { provider: 'anthropic', items: [{ type: 'thinking', thinking: 'signed', signature: 'sig' }] };
  const converted = anthropicMessages([...calls[0].messages, { role: 'assistant', content: 'ok', replay, tool_calls: [{ id: 't', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', content: 'read result', tool_call_id: 't' }]);
  assert.equal(converted[0].content[1].source.data, dataUrl.split(',')[1]); assert.deepEqual(converted[1].content[0], replay.items[0]); assert.equal(converted[2].content[0].type, 'tool_result');
  const refused = kernel.ctx.llm.stream({ model: 'unknown', messages });
  await assert.rejects(async () => { for await (const _ of refused) {} await refused.settled(); }, /Image transport/);
  assert.equal(calls.length, 1);
  await kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => seq('root', [{ ...block('visionNode'), use: 'flyt-blocks-core:general-analysis', config: { model: 'vision' } }]) } });
  const run = await kernel.ctx.agents.start({ id: 'image-workflow', runId: 'image-loop', metadata: { attachments: [ref()] } }, '');
  assert.equal((await run.settled()).status, 'done');
  assert.equal(calls.at(-1).messages.find(message => message.role === 'user').content[1].image_url.url, dataUrl);
  assert.equal(fs.readFileSync(path.join(root, 'image-loop', 'session.jsonl'), 'utf8').includes('data:image'), false);
});

test('catalog retains attributed image modalities and unknown remains unknown', () => {
  const rows = catalogFromOpenRouter({ data: [{ id: 'vision', architecture: { input_modalities: ['text', 'image'] } }, { id: 'unknown' }] });
  assert.deepEqual(modelFactsOf(rows[0]).inputModalities, ['text', 'image']);
  assert.equal(modelFactsOf(rows[1]).inputModalities, undefined);
  assert.deepEqual(chatSubmission('hello').attachments, []); assert.equal(chatSubmission({ text: '', attachments: [ref()] }).text, '');
  assert.throws(() => chatSubmission({ text: [], attachments: [] }), /Invalid/);
});

test('API claims projectless images, launches image-only requests once, and retains originals across immutable replies', { timeout: 30000 }, async t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-assets-api-')); const engine = createEngine({ projectRoot: path.resolve('.'), dataRoot, userDataDir: dataRoot });
  engine.settings.workers = { executor: { provider: 'mock', model: 'mock-large' } }; engine.rebuildRuntimeConfig();
  engine.resolveModelSource = model => ({ provider: 'mock', model });
  let api = createApi(engine); t.after(async () => { await api.shutdown(); engine.telemetry?.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const entry = engine.registry.createAppdata('Image test').project; const projectId = entry.id;
  const asset = await api.invoke('asset:import', { name: 'Screenshot.png', base64: (await png()).toString('base64') });
  const workflows = await api.invoke('workflow:list'); const workflowId = workflows.find(w => w.id === 'research')?.id ?? workflows[0].id;
  const input = { requestId: 'images-request-0001', text: '', attachments: [asset] };
  const [first, second] = await Promise.all([api.invoke('workflow:run', { projectId, workflowId, input }), api.invoke('workflow:run', { projectId, workflowId, input })]);
  assert.equal(first.runId, second.runId);
  assert.ok((await projectAssets(entry.store.rootDir).read(asset, 'original')).bytes.length);
  const again = await api.invoke('workflow:run', { projectId, workflowId, input }); assert.equal(again.runId, first.runId);
  const readSnapshot = async runId => {
    for (let attempt = 0; ; attempt++) {
      try { return await api.invoke('run:snapshot', { projectId, runId }); }
      catch (error) { if (error.code !== 'session_read_changed' || attempt >= 10) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  };
  const snapshot = await readSnapshot(first.runId);
  assert.equal(snapshot.meta.userMessage, ''); assert.equal(snapshot.meta.attachments[0].assetId, asset.assetId);
  assert.equal(JSON.stringify(snapshot).includes('data:image'), false);
  let settled = snapshot;
  for (let attempt = 0; !['done', 'failed'].includes(settled.meta.stage) && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100)); settled = await readSnapshot(first.runId);
  }
  assert.equal(settled.meta.stage, 'done', settled.meta.error ?? 'Image workflow must finish');
  await api.shutdown(); api = createApi(engine);
  assert.equal((await api.invoke('workflow:run', { projectId, workflowId, input })).runId, first.runId, 'restart cannot duplicate the accepted request');
  const reply = await api.invoke('workflow:reply', { projectId, runId: first.runId, text: { text: 'Use the screenshot above', requestId: 'reply-request-0001', attachments: [] } });
  assert.notEqual(reply.runId, first.runId);
  const continued = await readSnapshot(reply.runId);
  assert.equal(continued.meta.attachments[0].assetId, asset.assetId);
  assert.equal(continued.meta.parentRunId, first.runId);
  const other = engine.registry.createAppdata('Other').project;
  await assert.rejects(api.invoke('asset:preview', { projectId: other.id, asset: { assetId: asset.assetId } }), /missing or corrupt/);
});

test('Codex transports multiple native image flags in isolated files and removes staged copies', async () => {
  const bytes = await png(); const messages = [{ role: 'user', content: [
    { type: 'text', text: 'compare' }, ...[1, 2].map(() => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } })),
  ] }];
  const stage = stageCodexImages(messages);
  try {
    assert.equal(stage.imagePaths.length, 2);
    assert.ok(stage.imagePaths.every(file => path.dirname(file) === stage.cwd && fs.readFileSync(file).equals(bytes)));
    const args = buildCodexArgs({ model: 'gpt-5.2', cwd: stage.cwd, lastMessageFile: path.join(stage.cwd, 'result'), imagePaths: stage.imagePaths });
    assert.equal(args.filter(arg => arg === '--image').length, 2);
    assert.equal(args.at(-1), '-'); assert.ok(args.includes('read-only'));
    assert.throws(() => stageCodexImages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///private' } }] }]), /validated inline/);
  } finally { stage.cleanup(); }
  assert.equal(fs.existsSync(stage.cwd), false);
});

test('a node answer adds image evidence to that invocation and the next node', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-assets-answer-'));
  const { bootRunKernel, startStackRun } = await import('../core/kernelHost.js');
  const runsRoot = path.join(root, 'runs'); const workspaceDir = path.join(root, 'workspace'); fs.mkdirSync(workspaceDir);
  const asset = await projectAssets(runsRoot).import({ name: 'answer.png', bytes: await png() });
  const requests = [];
  const host = await bootRunKernel({ runsRoot, workspaceDir, store: new RunStore(runsRoot), sandboxMode: 'danger-full-access', stackRoot: path.resolve('stacks'), profile: 'flyt-desktop',
    worker: { model: 'vision', provider: 'mock' }, resolveModelSource: model => ({ model, provider: 'mock' }),
    askBlock: async () => ({ text: 'Use this reference', attachments: [asset] }),
    stackSource: 'version: 2\nid: image-question\nname: Image question\nblocks:\n  - id: refine\n    use: flyt-blocks-judgement:prompt-refiner\n  - id: inspect\n    use: flyt-blocks-core:general-analysis\n',
    call: async request => {
      requests.push(request);
      return requests.length === 1 ? { text: '', finishReason: 'tool_calls', message: { tool_calls: [{ id: 'question-1', function: { name: 'ask_human', arguments: JSON.stringify({ question: 'Which reference should I use?' }) } }] } } : { text: 'Use the attached reference.', finishReason: 'stop' };
    },
  });
  t.after(async () => { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const { run } = await startStackRun({ host, stackId: 'image-question', input: 'Prepare a brief' });
  const outcome = await run.settled(); assert.equal(outcome.status, 'done', outcome.error);
  assert.ok(requests.length >= 3);
  for (const request of requests.slice(1)) assert.ok(request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')), 'answer image must reach the next request and downstream node');
});
