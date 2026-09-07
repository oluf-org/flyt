import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { registerProvider } from '../core/adapters/index.js';
import { parseGoalReply } from '../core/goalController.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipe = `version: 2
id: goal-test
name: Goal test
blocks:
  - id: improve
    use: flyt-blocks-core:general-analysis
    config: {}
`;
const response = (text, extra = {}) => JSON.stringify({ candidate: { text }, ...extra });
test('a single delimited JSON artifact is valid; ambiguous multiple objects and prose are not', () => {
  assert.equal(parseGoalReply('Current result:\n```json\n{"candidate":{"text":"ALPHA"}}\n```').candidate.text, 'ALPHA');
  assert.equal(parseGoalReply('{"candidate":{"text":"ALPHA"}}\n{"candidate":{"text":"BETA"}}'), null);
  assert.equal(parseGoalReply('ALPHA BETA success'), null);
  assert.equal(parseGoalReply('```json\n{}\n```\n```json\n{}\n```'), null);
});
async function waitFor(fn) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Goal did not settle in 60 seconds');
}
async function fixture(t, call) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-goal-test-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const seen = [];
  const adapter = async request => {
    seen.push(request);
    const result = await call(request, seen.length);
    return { finishReason: 'stop', usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.001 }, ...(typeof result === 'string' ? { text: result } : result) };
  };
  adapter.canServe = model => model === 'mock-goal'; registerProvider('mock', adapter);
  const engine = createEngine({ projectRoot, dataRoot: path.join(root, 'data'), userDataDir: path.join(root, 'user') });
  const api = createApi(engine);
  const project = await api.invoke('project:open', { folder: workspace });
  const args = { projectId: project.id };
  const invoke = (action, payload = {}) => api.invoke(`goal:${action}`, { ...args, ...payload });
  const definition = {
    name: 'Acceptance goal', objective: 'Produce ALPHA and BETA', constraints: 'Preserve the fixed checks', folder: workspace,
    recipe, criteria: [{ type: 'output_contains', value: 'ALPHA' }, { type: 'output_contains', value: 'BETA' }],
    limits: { iterations: 5, calls: 20, minutes: 1 }, worker: { provider: 'mock', model: 'mock-goal' }, selfRedesign: true,
  };
  t.after(async () => {
    for (const goal of await invoke('list')) if (goal.live) await invoke('control', { goalId: goal.id, action: 'stop' });
    await waitFor(async () => (await invoke('list')).every(goal => !goal.live));
    // Close what the engine opened before deleting its userData. Windows
    // refuses to unlink an open file, so a live SQLite telemetry index fails
    // this hook — and only where node:sqlite exists, which is why a Node
    // without it (< 22.13) reports a green suite for the same leak.
    await api.shutdown('test teardown');
    engine.telemetry.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { invoke, definition, seen, engine, api, workspace, root, projectId: project.id };
}
const finish = (invoke, goalId) => waitFor(async () => { const state = await invoke('get', { goalId }); return !state.live && state.status !== 'ready' ? state : null; });

test('shared library API starts a fresh destination run despite advisory missing project paths', async t => {
  const f = await fixture(t, () => response('ALPHA BETA'));
  const source = await f.invoke('author-open', { definition: { ...f.definition, requiredPaths: ['missing-input.md'] } });
  const folder = path.join(f.root, 'destination'); fs.mkdirSync(folder);
  const target = await f.api.invoke('project:open', { folder });
  const library = await f.invoke('library');
  const entry = library.find(item => item.draftId === source.id);
  const next = await f.invoke('reuse', { projectId: target.id, libraryId: entry.id });
  const invoke = (action, args = {}) => f.invoke(action, { ...args, projectId: target.id });
  const report = await invoke('requirements', { draftId: next.id });
  assert.equal(report.paths[0].status, 'missing');
  const published = await invoke('author-publish', { draftId: next.id, baseRevision: 1 });
  await invoke('start', { goalId: published.goalId });
  const done = await finish(invoke, published.goalId);
  assert.equal(done.status, 'achieved'); assert.equal(done.contract.folder, folder);
  assert.equal(done.iteration, 1); assert.equal(done.calls, 1);
  assert.equal((await f.invoke('list')).length, 0);
  assert.equal((await f.invoke('author-read', { draftId: source.id })).goalId, null);
});

test('human result review survives reload and cannot approve failed checks as achieved', async t => {
  const f = await fixture(t, (_, count) => response(count === 1 ? 'ALPHA' : 'ALPHA BETA'));
  const state = await f.invoke('create', { definition: { ...f.definition, reviewResults: true } });
  await f.invoke('start', { goalId: state.id });
  const first = await finish(f.invoke, state.id);
  assert.equal(first.status, 'paused'); assert.equal(first.iteration, 1);
  await assert.rejects(f.invoke('start', { goalId: state.id }), /Review the pending result/);
  await assert.rejects(f.invoke('review-result', { goalId: state.id, ...first.pendingResult, digest: 'wrong', decision: 'approve' }), /Stale/);
  const reviewed = await f.invoke('review-result', { goalId: state.id, ...first.pendingResult, decision: 'approve' });
  assert.equal(reviewed.status, 'paused');
  await f.invoke('start', { goalId: state.id });
  const second = await finish(f.invoke, state.id);
  assert.equal(second.status, 'paused'); assert.equal(second.iteration, 2);
  const args = { goalId: state.id, ...second.pendingResult, decision: 'approve' };
  assert.equal((await f.invoke('review-result', args)).status, 'achieved');
  assert.equal((await f.invoke('review-result', args)).status, 'achieved');
  assert.equal((await f.invoke('get', { goalId: state.id })).calls, 2);
});

test('new authoring Goals pause for runtime proposals and activate only after human review', async t => {
  const f = await fixture(t, (_, count) => response(count === 1 ? 'ALPHA' : 'ALPHA BETA', count === 1 ? { proposal: { baseRevision: 1, rationale: 'Include missing BETA', commands: [{ name: 'stack:configure-block', args: { nodeId: 'improve', config: { instructions: 'Include BETA' } } }] } } : {}));
  const draft = await f.invoke('author-open', { definition: f.definition });
  const published = await f.invoke('author-publish', { draftId: draft.id, baseRevision: 1 });
  await f.invoke('start', { goalId: published.goalId });
  const paused = await finish(f.invoke, published.goalId);
  assert.equal(paused.status, 'paused'); assert.equal(paused.iteration, 1); assert.equal(paused.activeRevision, 1);
  const pending = await f.invoke('author-read', { draftId: draft.id });
  assert.equal(pending.proposals[0].status, 'pending');
  await assert.rejects(f.invoke('start', { goalId: published.goalId }), /REVIEW_REQUIRED/);
  const accepted = await f.invoke('author-review', { draftId: draft.id, proposalId: pending.proposals[0].id, decision: 'accept' });
  await f.invoke('author-publish', { draftId: draft.id, baseRevision: accepted.revision });
  await f.invoke('start', { goalId: published.goalId });
  const done = await finish(f.invoke, published.goalId);
  assert.equal(done.status, 'achieved'); assert.deepEqual(done.history.map(item => item.revision), [1, 2]);
  const clone = await f.invoke('clone', { goalId: published.goalId });
  assert.notEqual(clone.contract.authoringId, published.id);
  const cloneDraft = await f.invoke('author-open', { goalId: clone.id });
  assert.equal(cloneDraft.goalId, clone.id); assert.equal(clone.iteration, 0);
});

test('canonical Goal runs setup once, improves across two iterations and preserves verified best', async t => {
  const f = await fixture(t, (_, count) => count === 1 ? 'Baseline established' : response(count === 2 ? 'ALPHA' : 'ALPHA BETA', { findings: ['Observed a missing BETA in the first attempt'] }));
  const state = await f.invoke('create', { definition: { ...f.definition, setup: recipe, createFolder: true } });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'achieved', done.reason);
  assert.equal(done.iteration, 2); assert.equal(done.calls, 3); assert.equal(done.setupDone, true);
  assert.deepEqual(done.history.map(item => item.score), [0.5, 1]);
  assert.equal((await f.invoke('inspect', { goalId: state.id, record: done.best.artifact })).candidate.text, 'ALPHA BETA');
  assert.equal(fs.readdirSync(f.workspace).filter(name => name.startsWith('goal-')).length, 1);
  assert(f.seen.every(request => JSON.stringify(request.messages).includes('Preserve the fixed checks')));
});

test('self proposed shared editor command activates only at the next iteration boundary', async t => {
  const f = await fixture(t, (_, count) => response(count === 1 ? 'ALPHA' : 'ALPHA BETA', count === 1 ? {
    proposal: { baseRevision: 1, rationale: 'Require the missing term', commands: [{ name: 'stack:configure-block', args: { nodeId: 'improve', config: { instructions: 'Include BETA now' } } }] },
  } : {}));
  const state = await f.invoke('create', { definition: f.definition });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'achieved', done.reason); assert.equal(done.activeRevision, 2);
  assert.deepEqual(done.history.map(item => item.revision), [1, 2]);
  assert(JSON.stringify(f.seen[1].messages).includes('Include BETA now'));
  await assert.rejects(f.invoke('revise', { goalId: state.id, baseRevision: 1, source: recipe }), /Stale/);
});

test('fixed candidate tests use owned canonical child runs and share model call budget', async t => {
  const f = await fixture(t, (_, count) => count === 1 ? response('ALPHA BETA', { candidate: { text: 'ALPHA BETA', source: recipe } }) : '4');
  const state = await f.invoke('create', { definition: { ...f.definition, tests: [{ input: '2 + 2?', contains: '4' }] } });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'achieved', done.reason); assert.equal(done.calls, 2);
  const evidence = await f.invoke('inspect', { goalId: state.id, record: done.best.artifact });
  assert.equal(evidence.tests[0].passed, true);
  assert(evidence.tests[0].runId.includes('candidate-1-0'));
});

test('limit reached retains a partial best and never says achieved', async t => {
  const f = await fixture(t, () => response('ALPHA'));
  const state = await f.invoke('create', { definition: { ...f.definition, limits: { iterations: 2, calls: 20, minutes: 1 } } });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'limit_reached'); assert.equal(done.best.score, 0.5); assert.equal(done.best.verified, false);
});

test('malformed output cannot pass acceptance even when prose contains every keyword', async t => {
  const f = await fixture(t, () => 'ALPHA BETA success!');
  const state = await f.invoke('create', { definition: f.definition });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'failed'); assert.equal(done.best, null);
});

test('strict isolation refuses launch without writing a goal; unavailable block and path escape fail', async t => {
  const f = await fixture(t, () => response('ALPHA BETA'));
  await assert.rejects(f.invoke('create', { definition: { ...f.definition, folderMode: 'strict' } }), /Strict folder isolation is unavailable/);
  await assert.rejects(f.invoke('create', { definition: { ...f.definition, recipe: recipe.replace('flyt-blocks-core:general-analysis', 'unknown:block') } }), /Unavailable block/);
  await assert.rejects(f.invoke('create', { definition: { ...f.definition, criteria: [{ type: 'file_contains', path: '../secret', value: 'a' }] } }), /escapes/);
  assert.equal((await f.invoke('list')).length, 0);
});

test('active model call ceiling stops before another iteration', async t => {
  const f = await fixture(t, () => response('ALPHA'));
  const state = await f.invoke('create', { definition: { ...f.definition, limits: { iterations: 5, calls: 1, minutes: 1 } } });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'limit_reached'); assert.equal(f.seen.length, 1); assert.equal(done.calls, 1);
});

test('a model can retrieve one earlier result through the scoped history tool', async t => {
  const f = await fixture(t, (_, count) => count === 1 ? response('ALPHA', { findings: ['Early failure lacked BETA'] }) : count === 2 ? {
    text: '', finishReason: 'tool_calls', message: { tool_calls: [{ id: 'history-1', function: { name: 'goal_history', arguments: '{"iteration":1}' } }] },
  } : response('ALPHA BETA'));
  const state = await f.invoke('create', { definition: f.definition });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'achieved', done.reason);
  const tool = f.seen[2].messages.find(message => message.role === 'tool');
  assert(tool); assert.match(tool.content, /Early failure lacked BETA/); assert.match(tool.content, /ALPHA/);
});

test('a failed recipe trial can restore an earlier version without losing best evidence or resetting budget', async t => {
  const f = await fixture(t, (_, count) => count === 1 ? response('ALPHA', { proposal: { baseRevision: 1, rationale: 'Try another instruction', commands: [{ name: 'stack:configure-block', args: { nodeId: 'improve', config: { instructions: 'A recipe trial' } } }] } }) : count === 2 ? 'malformed trial' : response('ALPHA BETA'));
  const state = await f.invoke('create', { definition: f.definition });
  await f.invoke('start', { goalId: state.id });
  const failed = await finish(f.invoke, state.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.best.score, 0.5); assert.equal(failed.activeRevision, 2);
  await f.invoke('restore', { goalId: state.id, revision: 1, baseRevision: 2 });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'achieved', done.reason); assert.equal(done.calls, 3);
  assert.deepEqual(done.history.map(item => item.revision), [1, 3]);
  assert.equal(done.repairs.length, 1);
  assert.equal((await f.invoke('inspect', { goalId: state.id, record: 'iteration-1' })).candidate.text, 'ALPHA');
});

test('parallel blocks reserve the shared call budget before invoking a provider', async t => {
  const f = await fixture(t, async () => { await new Promise(resolve => setTimeout(resolve, 25)); return response('ALPHA BETA'); });
  const parallel = `version: 2
id: parallel-goal
blocks:
  - id: lanes
    kind: parallel
    maxParallel: 2
    lanes:
      - id: first
        kind: sequence
        blocks:
          - id: first-step
            use: flyt-blocks-core:general-analysis
      - id: second
        kind: sequence
        blocks:
          - id: second-step
            use: flyt-blocks-core:general-analysis
`;
  const state = await f.invoke('create', { definition: { ...f.definition, recipe: parallel, maxParallel: 2, limits: { iterations: 2, calls: 1, minutes: 1 } } });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'limit_reached', done.reason); assert.equal(f.seen.length, 1); assert.equal(done.calls, 1);
});

test('folder checks reject an escaping junction even when its final target does not exist', async t => {
  const f = await fixture(t, () => response('ALPHA BETA'));
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.invoke('create', { definition: { ...f.definition, criteria: [{ type: 'file_contains', path: 'escape/not-yet-created.txt', value: 'secret' }] } }), /Link escapes/);
});

test('fifty iterations keep bounded memory and searchable earlier evidence', async t => {
  const f = await fixture(t, (_, count) => response('ALPHA', { findings: [`Attempt ${count} lacks BETA`] }));
  const state = await f.invoke('create', { definition: { ...f.definition, plateau: 100, limits: { iterations: 50, calls: 60, minutes: 1 } } });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'limit_reached', done.reason); assert.equal(done.iteration, 50);
  assert.equal(done.memory.length, 10);
  assert(f.seen.every(request => JSON.stringify(request.messages).length < 15000));
  assert.equal((await f.invoke('history', { goalId: state.id, query: 'ALPHA', limit: 1 }))[0].iteration, 1);
});

test('pause/resume preserves completed setup and pins the interrupted iteration ahead of a pending edit', async t => {
  let entered; const active = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, (request, count) => {
    if (count === 1) return 'Baseline';
    if (count === 2) return 'Intermediate';
    if (count === 3) return new Promise((resolve, reject) => {
      entered(); request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', aborted: true })), { once: true });
    });
    return response('ALPHA BETA');
  });
  const twoSteps = recipe + '  - id: finish\n    use: flyt-blocks-core:general-analysis\n    config: {}\n';
  const state = await f.invoke('create', { definition: { ...f.definition, recipe: twoSteps, setup: recipe, createFolder: true } });
  await f.invoke('start', { goalId: state.id }); await active;
  await f.invoke('control', { goalId: state.id, action: 'pause' });
  const paused = await finish(f.invoke, state.id);
  assert.equal(paused.status, 'paused', paused.reason); assert.equal(paused.setupDone, true);
  await f.invoke('revise', { goalId: state.id, baseRevision: 1, source: twoSteps.replace('id: finish', 'id: replacement') });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'achieved', done.reason); assert.equal(done.activeRevision, 1); assert.equal(done.pendingRevision, 2);
  assert.equal(done.calls, 4); assert.deepEqual(done.workspace, paused.workspace);
});

test('simultaneous human edits use compare-and-swap even before a goal starts', async t => {
  const f = await fixture(t, () => response('ALPHA BETA'));
  const state = await f.invoke('create', { definition: f.definition });
  const results = await Promise.allSettled([1, 2].map(number => f.invoke('revise', { goalId: state.id, baseRevision: 1, source: recipe, rationale: `Edit ${number}` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /Stale/);
});

test('a proposal cannot change the fixed contract or bypass evaluation', async t => {
  const f = await fixture(t, () => response('ALPHA', { proposal: { baseRevision: 1, rationale: 'Remove criteria', commands: [{ name: 'goal:configure', args: { criteria: [] } }] } }));
  const state = await f.invoke('create', { definition: { ...f.definition, limits: { iterations: 2, calls: 10, minutes: 1 } } });
  await f.invoke('start', { goalId: state.id });
  const done = await finish(f.invoke, state.id);
  assert.equal(done.status, 'limit_reached'); assert.match(done.lastRevisionError, /Unsupported recipe command/);
  assert.equal(done.contract.criteria.length, 2); assert.equal(done.activeRevision, 1);
});
