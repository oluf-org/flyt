import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ABSENT_HASH, ProgressDetector, SessionProjectionIndex, WorkerProfileRegistry,
  applyMutationBatch, childSessionIdentity, compileContract, contentHash,
  evaluatePermission, executeCompatibleCalls, generateTypescriptClient,
  resolveConfiguration, InterceptionRegistry, Context,
} from '#kernel';

test('resource policy keeps hard denies and external directories inside the static ceiling layer', () => {
  const root = path.resolve('project');
  const base = { projectId: 'p1', projectRoot: root };
  assert.equal(evaluatePermission({ ...base, protectedSecrets: ['*/.env*'], savedApprovals: [{
    id: 'saved', projectId: 'p1', action: 'read_file', resource: '*', createdAt: new Date().toISOString(),
  }] }, { action: 'read_file', effect: 'read', args: { path: '.env.local' } }).decision, 'deny');

  assert.equal(evaluatePermission({ ...base, rules: [{
    id: 'outside', action: 'read_file', resource: '*outside*', effect: 'read', decision: 'allow',
  }] }, { action: 'read_file', effect: 'read', args: { path: '../outside/a.txt' } }).decision, 'deny');

  assert.equal(evaluatePermission({ ...base, rules: [{
    id: 'outside', action: 'read_file', resource: '*outside*', effect: 'read', decision: 'allow', externalDirectory: true,
  }] }, { action: 'read_file', effect: 'read', args: { path: '../outside/a.txt' } }).decision, 'allow');
});

test('worker profiles validate once and child sessions are stable and linked', () => {
  const ctx = new Context();
  const registry = new WorkerProfileRegistry(ctx);
  registry.register({
    id: 'reviewer', purpose: 'review', description: 'read changes', systemPrompt: 'Review.',
    preferredModel: 'm1', fallbacks: ['m2'], reasoning: 'high', toolCeiling: ['read_file'],
    permissionRules: [], context: { mode: 'isolated' }, warnings: { repeatedCalls: 3 },
  });
  assert.equal(registry.get('reviewer').preferredModel, 'm1');
  const input = { parentRunId: 'run-1', parentBlockId: 'graph', taskId: 'review', profileId: 'reviewer', contextBoundary: 'isolated' };
  assert.deepEqual(childSessionIdentity(input), childSessionIdentity(input));
  assert.match(childSessionIdentity(input).sessionId, /^run-1--child-[a-f0-9]{16}$/);
});

test('compatible reads run concurrently while output order stays deterministic', async () => {
  const events = [];
  const calls = ['slow', 'fast'].map(name => ({
    call: { id: name, name, args: {} },
    tool: { name, description: '', parameters: {}, classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' } },
  }));
  const results = await executeCompatibleCalls(calls, async item => {
    await new Promise(resolve => setTimeout(resolve, item.call.name === 'slow' ? 20 : 1));
    events.push(item.call.name);
    return { content: item.call.name };
  }, 2);
  assert.deepEqual(events, ['fast', 'slow']);
  assert.deepEqual(results.map(item => item.content), ['slow', 'fast']);
});

test('duplicate calls are evidence until a clear no-progress loop requires permission', () => {
  const detector = new ProgressDetector(3, 2, 5, 3);
  const call = { id: '1', name: 'read_file', args: { path: 'a' } };
  assert.equal(detector.record(call, false, 10).warning, false);
  assert.equal(detector.record(call, false, 20).warning, false);
  assert.equal(detector.record(call, false, 30).warning, true);
  assert.equal(detector.record(call, false, 40).clearLoop, false);
  assert.equal(detector.record(call, false, 50).clearLoop, true);
  detector.durableProgress();
  const afterProgress = detector.record(call, false, 0);
  assert.equal(afterProgress.durableStateChanged, true);
  assert.equal(afterProgress.count, 1);
});

test('mutation batches enforce hashes, return diagnostics, and revert once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-patch-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
  const batch = await applyMutationBatch(root, [{
    path: 'a.ts', expectedHash: contentHash('const a = 1;\n'), content: 'const a = 2;\n',
  }, { path: 'b.ts', expectedHash: ABSENT_HASH, content: 'export {};\n' }], async files => [{
    source: 'test', severity: 'info', message: files.join(','),
  }]);
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'const a = 2;\n');
  assert.equal(batch.diagnostics.length, 1);
  assert.equal(batch.diffs[0].beforeHash, contentHash('const a = 1;\n'));
  await batch.revert();
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'const a = 1;\n');
  assert.equal(fs.existsSync(path.join(root, 'b.ts')), false);
  await assert.rejects(batch.revert, /already reverted/);
});

test('one API contract validates payloads and generates the client surface', () => {
  const contract = { ping: {
    description: 'Ping', request: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    response: { type: 'string' }, error: { type: 'object' }, events: { pong: { type: 'string' } },
  } };
  const compiled = compileContract(contract);
  assert.equal(compiled.ping.request({ text: 'yes' }).length, 0);
  assert.ok(compiled.ping.request({}).length);
  assert.match(generateTypescriptClient(contract), /"ping"\(request/);
});

test('configuration precedence explains every effective leaf', () => {
  const result = resolveConfiguration([
    { source: 'global', values: { model: 'a', nested: { effort: 'low' } } },
    { source: 'project', values: { model: 'b' } },
    { source: 'run', values: { nested: { effort: 'high' } } },
  ]);
  assert.deepEqual(result.effective, { model: 'b', nested: { effort: 'high' } });
  assert.equal(result.provenance.find(item => item.path === 'model').source, 'project');
  assert.equal(result.provenance.find(item => item.path === 'nested.effort').source, 'run');
});

test('mutating interceptions are trusted, ordered, and traced', async () => {
  const registry = new InterceptionRegistry(new Context(), plugin => plugin === 'trusted');
  assert.throws(() => registry.register({
    plugin: 'unknown', point: 'model.request.prepared', order: 1, mutates: true, run: () => ({ model: 'x' }),
  }), /untrusted/);
  registry.register({ plugin: 'trusted', point: 'model.request.prepared', order: 2, mutates: true, run: value => ({ ...value, model: 'b' }) });
  registry.register({ plugin: 'observer', point: 'model.request.prepared', order: 1, mutates: false, run: () => ({ model: 'ignored' }) });
  const applied = await registry.apply('model.request.prepared', { model: 'a' });
  assert.deepEqual(applied.payload, { model: 'b' });
  assert.deepEqual(applied.trace.map(item => [item.plugin, item.mutated]), [['observer', false], ['trusted', true]]);
});

test('SQLite projection is rebuildable from canonical events and queryable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-index-'));
  let index;
  try { index = new SessionProjectionIndex(path.join(root, 'index.sqlite')); }
  catch (error) {
    assert.match(error.message, /node:sqlite/);
    return;
  }
  index.rebuild([
    { runId: 'r1', seq: 1, at: '2026-01-01T00:00:00Z', type: 'run.created', data: {} },
    { runId: 'r1', seq: 2, at: '2026-01-01T00:00:01Z', type: 'llm.response', data: { blockId: 'b', usage: { promptTokens: 3, reasoningTokens: 2 } } },
    { runId: 'r1', seq: 3, at: '2026-01-01T00:00:02Z', type: 'tool.result', data: { blockId: 'b', callId: 'c', name: 'read_file' } },
  ]);
  assert.equal(index.query({ runId: 'r1' }).length, 3);
  assert.equal(index.query({ kinds: ['tool.result'] }).length, 1);
  index.close();
});
