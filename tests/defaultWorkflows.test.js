import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RunStore } from '../core/state.js';
import { bootRunKernel, startStackRun, resumeStackRun, restartStackBlock, stopStackRun, pauseStackRun, continueStackRun } from '../core/kernelHost.js';
import { createWorkflowSupport } from '../core/workflowSupport.js';
import { snapshotStackRun } from '../core/runProjection.js';
import { captureRepoFiles } from '../core/repoChanges.js';
import { captureWorkspaceSignature } from '../core/effect.js';
import { DEFAULT_WORKFLOW_CASES } from '../benchmark/default-workflows/cases.js';
import { initialFlowId } from '../src/v2/dailyWorkModel.js';
import { galleryRows } from '../src/v2/workflowGalleryModel.js';
import { DEFAULT_WORKFLOW_IDS, workflowRecommendation } from '../src/defaultWorkflows.js';
import { parseStack } from '#kernel';

const stackRoot = fileURLToPath(new URL('../stacks', import.meta.url));
const finished = value => ({ text: typeof value === 'string' ? value : JSON.stringify(value), finishReason: 'stop' });
const tool = (name, args, id = 'effect') => ({ text: '', finishReason: 'tool_calls',
  message: { tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] } });
const completion = (overrides = {}) => ({ status: 'implemented', summary: 'Changed target to after.',
  criteria: ['Target contains after'], files: ['target.txt'], verificationCommands: [], evidence: ['target.txt:1'], reproduction: '', remaining: [], ...overrides });
const review = (overrides = {}) => ({ verdict: 'pass', summary: 'The requested content is present.',
  criteria: [{ criterion: 'Target contains after', passed: true, evidence: 'The current first line contains after.',
    references: [{ file: 'target.txt', line: 1, quote: 'after' }] }], findings: [], coverage: ['target.txt'], ...overrides });
const specReview = (overrides = {}) => ({ verdict: 'pass', summary: 'Interfaces, examples and recovery ordering agree.',
  checks: { interfaces: 'Declared fields agree.', examples: 'Examples match the declared fields.', failureOrdering: 'No destructive operations are specified.', decisions: 'The supplied decisions are preserved.' },
  issues: [], blockingDecisions: [], ...overrides });

async function fixture(t, respond, { files = { 'target.txt': 'before\n' }, configure = '', stack = 'make-change', git = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-defaults-'));
  const workspace = path.join(root, 'workspace'), runsRoot = path.join(root, 'runs');
  fs.mkdirSync(workspace);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    fs.writeFileSync(path.join(workspace, name), content);
  }
  if (git) {
    const run = args => execFileSync('git', args, { cwd: workspace, windowsHide: true, stdio: 'pipe' });
    run(['init']); run(['add', '.']);
    run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']);
    fs.writeFileSync(path.join(workspace, 'target.txt'), 'after\n');
  }
  const store = new RunStore(runsRoot);
  const seen = [], counts = new Map();
  const call = async request => {
    const id = request.executionContext?.blockId ?? '';
    const count = counts.get(id) ?? 0; counts.set(id, count + 1);
    seen.push(request);
    return { ...await respond({ request, id, count, workspace }), provider: 'script', model: request.model,
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 } };
  };
  let definitions = stackRoot;
  if (configure) {
    definitions = path.join(root, 'stacks'); fs.mkdirSync(definitions);
    const source = fs.readFileSync(path.join(stackRoot, `${stack}.stack.yaml`), 'utf8');
    fs.writeFileSync(path.join(definitions, `${stack}.stack.yaml`), source + configure);
  }
  const host = await bootRunKernel({ workspaceDir: workspace, runsRoot, store, stackRoot: definitions,
    sandboxMode: 'danger-full-access', approvalMode: 'always', profile: 'flyt-desktop',
    worker: { provider: 'script', model: 'script' }, resolveModelSource: model => ({ provider: 'script', model }), call });
  t.after(async () => { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, store, host, seen, counts, async run(input = 'Change target.txt to after.') {
    const started = await startStackRun({ host, stackId: stack, input });
    return { ...started, outcome: await started.run.settled() };
  }, async events(runId) { return [...await (async () => { const out = []; for await (const event of (await host.ctx.sessions.open(runId)).read()) out.push(event); return out; })()]; } };
}
const happy = ({ id, count }) => id.includes('work-')
  ? count === 0 ? tool('write_file', { path: 'target.txt', content: 'after\n' }) : finished(completion())
  : finished(review());

test('new defaults resolve, preserve legacy access, and select Make a change without replacing a saved choice', () => {
  for (const id of DEFAULT_WORKFLOW_IDS) {
    const stack = parseStack(fs.readFileSync(path.join(stackRoot, `${id}.stack.yaml`), 'utf8'));
    assert.equal(stack.launchable, true); assert.equal(stack.root.children.length, 1);
  }
  assert.equal(workflowRecommendation('fable-at-home'), 'legacy');
  assert.equal(workflowRecommendation('my-stack'), 'custom');
  const flows = [{ id: 'pipeline' }, { id: 'make-change' }, { id: 'research-question' }];
  assert.equal(initialFlowId(flows), 'make-change');
  assert.equal(initialFlowId(flows, 'pipeline'), 'pipeline');
  assert.equal(galleryRows(flows)[0].id, 'make-change');
});

test('Make a change records actual effects, independent source evidence and provider attempts', async t => {
  const f = await fixture(t, happy);
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  const events = await f.events(runId);
  assert.equal(events.filter(e => e.type === 'workflow.call').length, 3);
  assert.equal(events.filter(e => e.type === 'workflow.acceptance').length, 1);
  const reviewer = f.seen.find(r => r.executionContext.blockId.includes('review'));
  assert.ok(reviewer.tools.every(tool => !['write_file', 'bash', 'run_gate', 'create_task'].includes(tool.function?.name ?? tool.name)));
  assert.match(JSON.stringify(reviewer.messages), /BEFORE.*before.*AFTER.*after/s);
  const snapshot = await snapshotStackRun(f.host.ctx, runId, f.host.kernelModule);
  const stages = snapshot.stack.root.children[0].generated;
  assert.deepEqual(stages.map(stage => stage.taskId), ['change-work-0', 'change-review-0']);
  assert.deepEqual(stages[1].dependsOn, ['change-work-0']);
});

test('a worker claiming a change without making it fails', async t => {
  const f = await fixture(t, () => finished(completion()));
  const { outcome } = await f.run();
  assert.equal(outcome.status, 'failed'); assert.match(outcome.error, /no workspace change/);
  assert.equal(f.seen.length, 2, 'one read-only report correction cannot manufacture a missing effect');
});

test('already-satisfied work can pass without a cosmetic edit', async t => {
  const f = await fixture(t, ({ id }) => finished(id.includes('work-') ? completion({ status: 'already-satisfied', files: [] }) : review()), { files: { 'target.txt': 'after\n' } });
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal((await f.events(runId)).filter(e => e.type === 'tool.call').length, 0);
});

test('pre-existing work misreported as implementation is rechecked without a cosmetic write', async t => {
  const f = await fixture(t, ({ id, request }) => {
    if (id.endsWith('report-repair')) {
      const input = JSON.parse(request.messages.findLast(item => item.role === 'user').content);
      assert.deepEqual(input.observedChange.files, []);
      assert.ok(request.tools.every(item => !/write|edit|create|bash|run_gate/.test(item.function?.name ?? item.name)));
      return finished(completion({ status: 'already-satisfied', files: [] }));
    }
    return finished(id.includes('work-') ? completion() : review());
  }, { files: { 'target.txt': 'after\n' } });
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  const accepted = (await f.events(runId)).find(e => e.type === 'workflow.acceptance');
  assert.equal(accepted.data.report.status, 'already-satisfied');
  assert.deepEqual(accepted.data.report.files, []);
  assert.equal((await f.events(runId)).filter(e => e.type === 'tool.call').length, 0);
  assert.equal(f.counts.has('deliver.change-work-1'), false);
});

test('source drift during report correction remains rejected on Retry', async t => {
  const f = await fixture(t, ({ id, workspace }) => {
    if (id.endsWith('report-repair')) {
      fs.writeFileSync(path.join(workspace, 'external.txt'), 'external source change\n');
      return finished(completion({ status: 'already-satisfied', files: [] }));
    }
    return finished(completion());
  }, { files: { 'target.txt': 'after\n' } });
  const first = await f.run();
  assert.equal(first.outcome.status, 'failed');
  assert.match(first.outcome.error, /changed during completion-report correction/);
  const calls = f.seen.length;
  const retry = await restartStackBlock(f.host, first.runId, 'deliver');
  assert.match((await retry.run.settled()).error, /Workspace changed since/);
  assert.equal(f.seen.length, calls);
});

for (const legacy of [false, true]) test(`Retry only repeats failed formatting, retaining completed work (${legacy ? 'legacy log recovery' : 'saved candidate'})`, async t => {
  const f = await fixture(t, args => {
    if (args.id.endsWith('.format')) {
      if (args.count === 0) throw new Error('Provider stalled during format-only completion');
      return finished(completion());
    }
    if (args.id.includes('work-')) {
      if (args.count === 0) return tool('write_file', { path: 'target.txt', content: 'after\n' });
      const malformed = completion(); delete malformed.criteria;
      return finished(malformed);
    }
    return finished(review());
  });
  const first = await f.run();
  assert.equal(first.outcome.status, 'failed');
  if (legacy) {
    const saved = (await f.events(first.runId)).findLast(e => e.type === 'block.output' && e.data.port === 'workflow-state');
    const state = JSON.parse(saved.data.content); delete state.pendingStages;
    await (await f.host.ctx.sessions.open(first.runId)).append({ type: 'block.output', data: { ...saved.data, content: JSON.stringify(state) } });
  }
  const retry = await restartStackBlock(f.host, first.runId, 'deliver');
  assert.equal((await retry.run.settled()).status, 'done');
  assert.equal(f.counts.get('deliver.change-work-0'), 2, 'the writing turn is not repeated');
  assert.equal(f.counts.get('deliver.change-work-0.format'), 2);
  const events = await f.events(first.runId);
  assert.equal(events.filter(e => e.type === 'tool.call' && e.data.name === 'write_file').length, 1);
  assert.equal(events.filter(e => e.type === 'workflow.budget').length, 1);
});

test('a pre-existing unrelated dirty file cannot satisfy the requested effect', async t => {
  const f = await fixture(t, () => finished(completion()), { files: { 'target.txt': 'before\n', 'dirty.txt': 'user change' } });
  const { outcome } = await f.run();
  assert.equal(outcome.status, 'failed'); assert.match(outcome.error, /no workspace change/);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'dirty.txt'), 'utf8'), 'user change');
});

test('a green reviewer cannot override a failing runtime command', async t => {
  const f = await fixture(t, args => args.id.includes('work-') && args.count > 0
    ? finished(completion({ verificationCommands: ['node -e "process.exit(1)"'] })) : happy(args));
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'failed'); assert.match(outcome.error, /Repair allowance exhausted/);
  const checks = (await f.events(runId)).filter(e => e.type === 'workflow.verification');
  assert.equal(checks.length, 3); assert.ok(checks.every(e => e.data.receipt.passed === false));
});

test('a focused repair is rechecked and accepted against the new content', async t => {
  const f = await fixture(t, args => {
    if (args.id.endsWith('review-0')) return finished(review({ verdict: 'repair', findings: [{ file: 'target.txt', line: 1,
      trigger: 'Exact content check', consequence: 'Missing suffix', evidence: 'Needs newline suffix' }] }));
    return happy(args);
  });
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal((await f.events(runId)).filter(e => e.type === 'workflow.acceptance').length, 1);
  assert.equal(f.counts.get('deliver.change-review-1'), 1);
});

test('worker-discovered unmet requirements get a bounded repair before acceptance', async t => {
  const f = await fixture(t, args => args.id.endsWith('work-0') && args.count > 0
    ? finished(completion({ remaining: ['The requested suffix is still missing.'] })) : happy(args));
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal(f.counts.has('deliver.change-review-0'), false);
  assert.equal(f.counts.get('deliver.change-review-1'), 1);
  assert.match(JSON.stringify(f.seen.find(r => r.executionContext.blockId.endsWith('work-1')).messages), /requested suffix/);
  assert.equal((await f.events(runId)).filter(e => e.type === 'workflow.acceptance').length, 1);
});

test('persistent worker-discovered defects exhaust repairs without acceptance', async t => {
  const f = await fixture(t, args => args.id.includes('work-') && args.count > 0
    ? finished(completion({ remaining: ['Required CSV header is incorrect.'] })) : happy(args));
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Repair allowance exhausted.*Required CSV header/s);
  assert.equal((await f.events(runId)).filter(e => e.type === 'workflow.acceptance').length, 0);
  assert.equal([...f.counts.keys()].filter(id => /work-\d$/.test(id)).length, 3);
});

test('invented source quotations fail independent review', async t => {
  const f = await fixture(t, args => args.id.includes('review') ? finished(review({ criteria: [{ criterion: 'Target contains after', passed: true,
    evidence: 'invented', references: [{ file: 'target.txt', line: 9, quote: 'imaginary' }] }] })) : happy(args));
  const { outcome } = await f.run();
  assert.equal(outcome.status, 'failed'); assert.match(outcome.error, /citation does not match/);
});

test('required project gates cannot be dropped by the worker', async t => {
  const f = await fixture(t, happy, { files: { 'target.txt': 'before\n', '.flyt/config.json': JSON.stringify({ gates: ['node -e "process.exit(1)"'] }) } });
  const { outcome } = await f.run(); assert.equal(outcome.status, 'failed');
});

test('Review a change returns actionable findings without making edits', async t => {
  const f = await fixture(t, () => finished(review({ verdict: 'repair', findings: [{ file: 'target.txt', line: 1,
    trigger: 'Read the changed line', consequence: 'The requested behavior differs', evidence: 'after' }] })), { stack: 'review-change', git: true });
  const { outcome } = await f.run('Review the change.');
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'target.txt'), 'utf8'), 'after\n');
  assert.equal(f.seen.length, 1);
});

test('Research defaults to readers and never offers shell, web, or queue writers', async t => {
  const f = await fixture(t, () => finished({ status: 'answered', answer: 'The supplied question can be answered directly.', sources: [{ kind: 'input', source: 'input', quote: 'this supplied sentence' }], limitations: [] }), { stack: 'research-question' });
  const { outcome } = await f.run('Summarize this supplied sentence.'); assert.equal(outcome.status, 'done', outcome.error);
  const tools = f.seen[0].tools.map(item => item.function?.name ?? item.name);
  assert.ok(tools.includes('read_file')); assert.ok(!tools.includes('web_search')); assert.ok(!tools.includes('bash'));
});

test('Plan an idea never exposes queue or file mutation capabilities', async t => {
  const f = await fixture(t, ({ id }) => finished(id.includes('spec-review') ? specReview({ blockingDecisions: ['Target interaction'] }) : { status: 'draft', specification: 'Goal: improve the UI.', openDecisions: ['Target interaction'], assumptions: [] }), { stack: 'plan-idea' });
  const { outcome, runId } = await f.run('Plan a UI improvement.'); assert.equal(outcome.status, 'done', outcome.error);
  assert.ok(f.seen[0].tools.every(item => !['write_file', 'queue_backlog_tasks', 'bash'].includes(item.function?.name ?? item.name)));
  assert.ok((await f.events(runId)).some(e => e.type === 'block.status' && e.data.structured?.status === 'draft'));
});

test('Fix a bug refuses an unobserved reproduction claim', async t => {
  const f = await fixture(t, args => args.id.includes('work-') && args.count > 0 ? finished(completion({ reproduction: 'I reproduced it.' })) : happy(args), { stack: 'fix-bug' });
  const { outcome } = await f.run(); assert.equal(outcome.status, 'failed'); assert.match(outcome.error, /No observed failing reproduction/);
});

test('Fix a bug observes a repair to an already dirty tracked file and reruns verification', async t => {
  const command = 'node -e "if(require(\'fs\').readFileSync(\'target.txt\',\'utf8\').trim()!==\'after\')process.exit(1)"';
  const f = await fixture(t, ({ id, count }) => {
    if (id.includes('work-')) return count === 0 ? tool('bash', { command }, 'reproduce')
      : count === 1 ? tool('write_file', { path: 'target.txt', content: 'after\n' }, 'repair')
        : finished(completion({ verificationCommands: [command], reproduction: 'The command failed before the write and now passes.' }));
    return finished(review());
  }, { stack: 'fix-bug', git: true });
  fs.writeFileSync(path.join(f.workspace, 'target.txt'), 'user-edited before\n');
  const { outcome } = await f.run(); assert.equal(outcome.status, 'done', outcome.error);
});

test('complex delivery collapses a coherent milestone to full original-request acceptance', async t => {
  const f = await fixture(t, args => args.id.endsWith('discover') ? finished({ summary: 'One coherent change.', milestones: [{ id: 'target', title: 'Update target', goal: 'Change target to after', acceptance: ['Target contains after'] }] }) : happy(args), { stack: 'deliver-complex-task' });
  const { outcome, runId } = await f.run(); assert.equal(outcome.status, 'done', outcome.error);
  assert.ok(f.seen[0].tools.some(item => (item.function?.name ?? item.name) === 'read_file'));
  const state = (await f.events(runId)).filter(e => e.data.port === 'workflow-state').at(-1);
  assert.equal(JSON.parse(state.data.content).completed.length, 1);
  assert.equal(f.counts.get('delivery.integration-review'), undefined, 'the unchanged accepted result needs no duplicate review');
});

test('local acceptance cannot override failed complex-task integration', async t => {
  const f = await fixture(t, args => {
    if (args.id.endsWith('discover')) return finished({ summary: 'Plan', milestones: [
      { id: 'target', title: 'Target', goal: 'Update target', acceptance: ['Target contains after'] },
      { id: 'other', title: 'Other', goal: 'Update other', acceptance: ['Other contains after'] },
    ] });
    if (args.id.endsWith('integration-review')) return finished(review({ verdict: 'repair', coverage: ['target.txt', 'other.txt'], findings: [
      { file: 'target.txt', line: 1, trigger: 'Integration path', consequence: 'Missing connected behavior', evidence: 'after' }] }));
    if (args.id.includes('milestone-other')) return args.id.includes('work-')
      ? args.count === 0 ? tool('write_file', { path: 'other.txt', content: 'after\n' })
        : finished(completion({ files: ['other.txt'], criteria: ['Other contains after'] }))
      : finished(review({ coverage: ['other.txt'], criteria: [{ criterion: 'Other contains after', passed: true,
        evidence: 'Other is after', references: [{ file: 'other.txt', line: 1, quote: 'after' }] }] }));
    return happy(args);
  }, { stack: 'deliver-complex-task', files: { 'target.txt': 'before\n', 'other.txt': 'before\n' } });
  const { outcome, runId } = await f.run('Change both files to after and integrate them.');
  assert.equal((await f.events(runId)).filter(e => e.type === 'workflow.acceptance').length, 2);
  assert.equal(outcome.status, 'failed'); assert.match(outcome.error, /Final integration acceptance failed/);
});

test('budget accounting persists across host adapters and counts unknown costs honestly', async t => {
  const f = await fixture(t, happy);
  const support = createWorkflowSupport({ workspace: f.workspace, sessions: f.host.ctx.sessions, runsRoot: path.join(f.root, 'runs') });
  await support.bindBudget('budget-test', 'deliver', 0, { calls: 1, minutes: 10 });
  const request = { model: 'script', executionContext: { runId: 'budget-test', blockId: 'deliver.review', after: 0 } };
  const ticket = await support.beforeCall(request); await support.afterCall(ticket, { usage: { cost: 0.1 } });
  const reopened = createWorkflowSupport({ workspace: f.workspace, sessions: f.host.ctx.sessions, runsRoot: path.join(f.root, 'runs') });
  await assert.rejects(reopened.beforeCall(request), /model call limit/);
  await support.bindBudget('unknown-test', 'deliver', 0, { calls: 10, minutes: 10, usd: 1 });
  request.executionContext.runId = 'unknown-test';
  await support.beforeCall(request);
  await assert.rejects(reopened.beforeCall(request), /unknown cost/);
});

test('retrying complex delivery preserves accepted milestones and does not repeat their writes', async t => {
  let interrupted = false;
  const f = await fixture(t, ({ id, count }) => {
    if (id.endsWith('discover')) return finished({ summary: 'Two connected outcomes.', milestones: [
      { id: 'first', title: 'First', goal: 'Update target', acceptance: ['Target contains after'] },
      { id: 'second', title: 'Second', goal: 'Update other', acceptance: ['Other contains after'] },
    ] });
    const second = id.includes('second');
    if (id.includes('work-')) {
      if (second && !interrupted) { interrupted = true; throw Object.assign(new Error('Controlled process interruption'), { failure: { code: 'fixture_interrupted', retryable: false } }); }
      const file = second ? 'other.txt' : 'target.txt';
      if (count === (second ? 1 : 0)) return tool('write_file', { path: file, content: 'after\n' });
      return finished(completion({ files: [file], criteria: [second ? 'Other contains after' : 'Target contains after'] }));
    }
    if (id.endsWith('integration-review')) return finished(review({ coverage: ['target.txt', 'other.txt'] }));
    return finished(second ? review({ criteria: [{ criterion: 'Other contains after', passed: true, evidence: 'Other is after', references: [{ file: 'other.txt', line: 1, quote: 'after' }] }], coverage: ['other.txt'] }) : review());
  }, { stack: 'deliver-complex-task', files: { 'target.txt': 'before\n', 'other.txt': 'before\n' } });
  const first = await f.run(); assert.equal(first.outcome.status, 'failed');
  const callsBefore = f.counts.get('delivery.milestone-first-work-0');
  const resumed = await restartStackBlock(f.host, first.runId, 'delivery');
  const result = await resumed.run.settled();
  assert.equal(result.status, 'done', result.error);
  assert.equal(f.counts.get('delivery.milestone-first-work-0'), callsBefore);
  const accepted = (await f.events(first.runId)).filter(e => e.type === 'workflow.acceptance');
  assert.deepEqual(accepted.map(e => e.data.milestone), ['milestone-first', 'milestone-second']);
});

test('resume refuses external edits to an accepted workspace version', async t => {
  const f = await fixture(t, happy);
  const first = await f.run(); assert.equal(first.outcome.status, 'done', first.outcome.error);
  fs.writeFileSync(path.join(f.workspace, 'target.txt'), 'external change\n');
  const events = await f.events(first.runId);
  const state = JSON.parse(events.filter(e => e.data.port === 'workflow-state').at(-1).data.content);
  const definition = f.host.ctx.blocks.require('flyt-blocks-delivery:verified-change');
  const result = await definition.execute({ ctx: f.host.ctx, runId: first.runId, blockId: 'deliver', input: 'Change target.txt to after.',
    context: state.context, config: { model: 'script' }, ceiling: definition.ceiling });
  assert.equal(result.status, 'failed'); assert.match(result.error, /Workspace changed since/);
});

test('malformed completion is repaired once without repeating a write', async t => {
  const f = await fixture(t, args => {
    if (args.id.endsWith('.format')) {
      assert.match(JSON.stringify(args.request.messages), /observedTools.*write_file.*target.txt/s);
      assert.match(JSON.stringify(args.request.messages), /originalRequest/);
      return finished(completion());
    }
    return args.id.includes('work-') && args.count > 0 ? finished('I changed target.txt to after.') : happy(args);
  });
  const { outcome, runId } = await f.run(); assert.equal(outcome.status, 'done', outcome.error);
  assert.equal((await f.events(runId)).filter(e => e.type === 'tool.call' && e.data.name === 'write_file').length, 1);
  assert.equal(f.counts.get('deliver.change-work-0.format'), 1);
  const snapshot = await snapshotStackRun(f.host.ctx, runId, f.host.kernelModule);
  const format = snapshot.stack.root.children[0].generated.find(stage => stage.taskId === 'change-work-0-format');
  assert.equal(format.id, 'deliver.change-work-0.format');
  assert.match(format.title, /Format result/);
  assert.ok((await f.events(runId)).some(e => e.type === 'block.status' && e.data.blockId === format.id && e.data.status === 'active'));
});

test('concurrent reservations cannot exceed the workflow call allowance', async t => {
  const f = await fixture(t, happy);
  const support = f.host.ctx.workflowSupport;
  await support.bindBudget('parallel-budget', 'owner', 0, { calls: 1, minutes: 1 });
  const results = await Promise.allSettled([1, 2, 3].map(i => support.beforeCall({ model: 'script', executionContext: { runId: 'parallel-budget', blockId: `owner.${i}` } })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
});

test('workspace snapshots include files inside a nested ignored workspace', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-nested-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, '.gitignore'), 'fixtures/\n');
  const workspace = path.join(root, 'fixtures', 'project');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'actual content\n');
  const before = captureWorkspaceSignature(workspace);
  const snapshot = await captureRepoFiles(workspace);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.files.get('target.txt').content.toString(), 'actual content\n');
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'edited content\n');
  assert.notDeepEqual(captureWorkspaceSignature(workspace), before);
});

test('research accepts observed numbered file previews and derives their provenance', async t => {
  const f = await fixture(t, ({ count }) => count === 0 ? tool('read_file', { path: 'target.txt' })
    : finished({ status: 'answered', answer: 'The value is before (target.txt:1).', sources: [
      { kind: 'input', source: 'target.txt', quote: '1: before' }], limitations: [] }), { stack: 'research-question' });
  const { outcome } = await f.run('Read target.txt and report its value.');
  assert.equal(outcome.status, 'done', outcome.error);
});

test('research rejects quotations that were never opened', async t => {
  const f = await fixture(t, ({ id }) => finished(id.includes('evidence-repair')
    ? { status: 'answered', replacements: [{ index: 0, kind: 'file', source: 'target.txt', quote: 'before' }], replaceAnswer: false, answer: '', limitations: null }
    : { status: 'answered', answer: 'The value is before.', sources: [
    { kind: 'file', source: 'target.txt', quote: 'before' }], limitations: [] }), { stack: 'research-question' });
  const { outcome } = await f.run('Read target.txt and report its value.');
  assert.equal(outcome.status, 'failed'); assert.match(outcome.error, /not supported by opened results/);
});

test('planning repairs misaligned CSV totals and independently reviews the corrected specification', async t => {
  const bad = { status: 'ready', specification: 'Columns: month,count,currency,revenue,total. Example: TOTAL,3,NOK,450.', assumptions: [], openDecisions: [] };
  const corrected = { ...bad, specification: 'Columns: month,count,currency,revenue,total. Example: TOTAL,3,NOK,450,450.' };
  const f = await fixture(t, ({ id }) => finished(id.endsWith('specify') ? bad
    : id.endsWith('spec-review-0') ? specReview({ verdict: 'repair', issues: ['Five header columns but four TOTAL fields.'] })
      : id.includes('spec-repair') ? corrected : specReview()), { stack: 'plan-idea' });
  const { outcome, runId } = await f.run('Plan a five-column monthly export with matching totals.');
  assert.equal(outcome.status, 'done', outcome.error);
  const events = await f.events(runId);
  const final = events.filter(e => e.type === 'block.output' && e.data.blockId === 'specify' && !e.data.port).at(-1)?.data.content;
  assert.match(String(final), /450,450/); assert.match(String(final), /consistency reviewed/);
  assert.equal(f.seen.length, 4);
});

test('persistent backup ordering contradictions cannot become a ready or accepted draft plan', async t => {
  const f = await fixture(t, ({ id }) => finished(id.includes('spec-review')
    ? specReview({ verdict: 'repair', issues: ['Retention deletes the recoverable snapshot before the new backup is durable.'] })
    : { status: 'draft', specification: 'Prune old snapshots first. Keep seven successful backups and recover safely after disk-full.', assumptions: [], openDecisions: [] }), { stack: 'plan-idea' });
  const { outcome } = await f.run('Plan safe backups before overwriting order data.');
  assert.equal(outcome.status, 'failed'); assert.match(outcome.error, /consistency repair allowance exhausted/);
  assert.equal(f.seen.length, 6);
});

test('independent planning review keeps unresolved stakeholder decisions in a useful draft', async t => {
  const f = await fixture(t, ({ id }) => finished(id.includes('spec-review')
    ? specReview({ blockingDecisions: ['Choose manual list or outbound notifications.'] })
    : { status: 'ready', specification: 'Goal: follow up with customers; channel remains open.', assumptions: [], openDecisions: [] }), { stack: 'plan-idea' });
  const { outcome, runId } = await f.run('Plan customer follow-ups.');
  assert.equal(outcome.status, 'done', outcome.error);
  assert.ok((await f.events(runId)).some(e => e.type === 'workflow.specification-review' && e.data.status === 'draft'));
});

test('research repairs only unsupported excerpts without reconstructing the answer or rereading valid evidence', async t => {
  const f = await fixture(t, ({ id, count }) => id.includes('evidence-repair')
    ? finished({ status: 'answered', replacements: [{ index: 1, kind: 'file', source: 'target.txt', quote: 'before' }], replaceAnswer: false, answer: 'null', limitations: null })
    : count === 0 ? tool('read_file', { path: 'target.txt' })
      : finished({ status: 'answered', answer: 'The value is before (target.txt:1).', sources: [{ kind: 'input', source: 'input', quote: 'Read target.txt' }, { kind: 'file', source: 'target.txt', quote: 'before (invented explanation)' }], limitations: [] }), { stack: 'research-question' });
  const { outcome, runId } = await f.run('Read target.txt and report its value.');
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal((await f.events(runId)).filter(e => e.type === 'tool.call' && e.data.name === 'read_file').length, 1);
  const request = f.seen.find(r => r.executionContext.blockId.includes('evidence-repair'));
  assert.match(JSON.stringify(request.messages), /openedExcerpts/);
  const final = (await f.events(runId)).filter(e => e.type === 'block.output' && e.data.blockId === 'research' && !e.data.port).at(-1);
  assert.match(final.data.content, /^The value is before/);
});

test('research cannot accept a placeholder replacement answer', async t => {
  const f = await fixture(t, ({ id, count }) => id.includes('evidence-repair')
    ? finished({ status: 'answered', replacements: [{ index: 0, kind: 'file', source: 'target.txt', quote: 'before' }], replaceAnswer: true, answer: 'null', limitations: null })
    : count === 0 ? tool('read_file', { path: 'target.txt' })
      : finished({ status: 'answered', answer: 'The value is before.', sources: [{ kind: 'file', source: 'target.txt', quote: 'invented' }], limitations: [] }), { stack: 'research-question' });
  const { outcome } = await f.run('Read target.txt and report its value.');
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /placeholder instead of an answer/);
});

test('release evaluation has five fixed cases for every recommended workflow', () => {
  assert.equal(new Set(DEFAULT_WORKFLOW_CASES.map(item => item.id)).size, 30);
  for (const id of DEFAULT_WORKFLOW_IDS) assert.equal(DEFAULT_WORKFLOW_CASES.filter(item => item.workflow === id).length, 5);
});

test('a stopped worker resumes its transcript after a write without duplicating the write', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async args => {
    if (args.id.includes('work-') && args.count === 1) { enter(); await held; }
    return happy(args);
  });
  const started = await startStackRun({ host: f.host, stackId: 'make-change', input: 'Change target.txt to after.' });
  await entered;
  assert.equal(fs.readFileSync(path.join(f.workspace, 'target.txt'), 'utf8'), 'after\n');
  assert.equal((await stopStackRun(f.host.ctx, started.runId, 'fixture cancellation')).ok, true);
  release();
  assert.equal((await started.run.settled()).status, 'stopped');
  const resumed = await resumeStackRun(f.host, started.runId);
  const outcome = await resumed.run.settled();
  assert.equal(outcome.status, 'done', outcome.error);
  const events = await f.events(started.runId);
  assert.equal(events.filter(e => e.type === 'tool.call' && e.data.name === 'write_file').length, 1);
  assert.equal(events.filter(e => e.type === 'workflow.budget').length, 1);
});

for (const drift of [false, true]) test(`internal workflow pause ${drift ? 'rejects source drift before another call' : 'holds between stages and continues without duplicate writes'}`, async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async args => {
    if (args.id.includes('work-') && args.count === 1) { enter(); await held; }
    return happy(args);
  });
  const started = await startStackRun({ host: f.host, stackId: 'make-change', input: 'Change target.txt to after.' });
  await entered;
  assert.equal((await pauseStackRun(f.host.ctx, started.runId)).ok, true);
  release();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !(await f.events(started.runId)).some(e => e.type === 'run.stage' && e.data.stage === 'paused')) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok((await f.events(started.runId)).some(e => e.type === 'run.stage' && e.data.stage === 'paused'));
  assert.equal(f.seen.length, 2, 'the independent reviewer waits for Continue');
  if (drift) fs.writeFileSync(path.join(f.workspace, 'external.txt'), 'changed while paused\n');
  assert.equal((await continueStackRun(f.host.ctx, started.runId)).ok, true);
  const outcome = await started.run.settled();
  assert.equal(outcome.status, drift ? 'failed' : 'done', outcome.error);
  if (drift) { assert.match(outcome.error, /Workspace changed while paused/); assert.equal(f.seen.length, 2); }
  assert.equal((await f.events(started.runId)).filter(e => e.type === 'tool.call' && e.data.name === 'write_file').length, 1);
});

test('an interrupted writer cannot absorb external edits into its saved checkpoint', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async args => {
    if (args.id.includes('work-') && args.count === 1) { enter(); await held; }
    return happy(args);
  });
  const started = await startStackRun({ host: f.host, stackId: 'make-change', input: 'Change target.txt to after.' });
  await entered;
  await stopStackRun(f.host.ctx, started.runId, 'fixture cancellation');
  release();
  assert.equal((await started.run.settled()).status, 'stopped');
  fs.writeFileSync(path.join(f.workspace, 'target.txt'), 'external edit after interruption\n');
  const calls = f.seen.length;
  const resumed = await resumeStackRun(f.host, started.runId);
  const outcome = await resumed.run.settled();
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Workspace changed since/);
  assert.equal(f.seen.length, calls, 'stale work is rejected before another model call');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'target.txt'), 'utf8'), 'external edit after interruption\n');
});

test('complex integration reruns commands accepted by earlier milestones without configured gates', async t => {
  const command = 'node -e "process.exit(0)"';
  const f = await fixture(t, args => {
    if (args.id.endsWith('discover')) return finished({ summary: 'Two connected changes.', milestones: [
      { id: 'target', title: 'Target', goal: 'Update target', acceptance: ['Target contains after'] },
      { id: 'other', title: 'Other', goal: 'Update other', acceptance: ['Other contains after'] },
    ] });
    const second = args.id.includes('milestone-other');
    if (args.id.includes('work-')) return args.count === 0
      ? tool('write_file', { path: second ? 'other.txt' : 'target.txt', content: 'after\n' })
      : finished(completion({ files: [second ? 'other.txt' : 'target.txt'],
        criteria: [second ? 'Other contains after' : 'Target contains after'], verificationCommands: second ? [] : [command] }));
    if (args.id.endsWith('integration-review')) return finished(review({ coverage: ['target.txt', 'other.txt'] }));
    return finished(second ? review({ coverage: ['other.txt'], criteria: [{ criterion: 'Other contains after', passed: true,
      evidence: 'Current other file', references: [{ file: 'other.txt', line: 1, quote: 'after' }] }] }) : review());
  }, { stack: 'deliver-complex-task', files: { 'target.txt': 'before\n', 'other.txt': 'before\n' } });
  const { outcome, runId } = await f.run('Update both files and verify the integration.');
  assert.equal(outcome.status, 'done', outcome.error);
  const checks = (await f.events(runId)).filter(e => e.type === 'workflow.verification');
  assert.deepEqual(checks.map(e => [e.data.blockId, e.data.receipt.command, e.data.receipt.passed]), [
    ['delivery.milestone-target-check-0', command, true], ['delivery.integration-check', command, true],
  ]);
  const finalRequest = f.seen.find(request => request.executionContext?.blockId === 'delivery.integration-review');
  const input = JSON.parse(finalRequest.messages.findLast(message => message.role === 'user').content);
  assert.deepEqual(input.observedMilestoneChecks.map(check => check.receipt), [checks[0].data.receipt]);
  assert.deepEqual(input.observedChecks, [checks[1].data.receipt]);
  assert.notEqual(input.observedMilestoneChecks[0].receipt.version, input.observedChecks[0].version,
    'an earlier milestone receipt remains bound to its earlier source version');
});

test('a citation can be corrected once by readers without rerunning implementation', async t => {
  const f = await fixture(t, args => args.id.endsWith('review-0') ? finished(review({ criteria: [{ criterion: 'Target contains after', passed: true,
    evidence: 'Wrong line prefix', references: [{ file: 'target.txt', line: 1, quote: '1: after' }] }] })) : happy(args));
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal((await f.events(runId)).filter(e => e.type === 'tool.call' && e.data.name === 'write_file').length, 1);
  assert.equal(f.counts.get('deliver.change-review-0-evidence-repair'), 1);
});

test('an exact quote with one matching line is located without another model call', async t => {
  const f = await fixture(t, args => args.id.includes('review')
    ? finished(review({ criteria: [{ ...review().criteria[0], references: [{ file: 'target.txt', line: 2, quote: 'after' }] }] }))
    : happy(args));
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  const events = await f.events(runId);
  const correction = events.find(e => e.type === 'workflow.citation-correction');
  assert.equal(correction.data.requestedLine, 2);
  assert.equal(correction.data.actualLine, 1);
  assert.equal(events.find(e => e.type === 'workflow.acceptance').data.review.criteria[0].references[0].line, 1);
  assert.equal(f.counts.has('deliver.change-review-0-evidence-repair'), false);
});

test('an incorrectly located quote with multiple matching lines remains rejected', async t => {
  const f = await fixture(t, ({ id }) => finished(id.includes('work-') ? completion({ status: 'already-satisfied', files: [] })
    : review({ criteria: [{ ...review().criteria[0], references: [{ file: 'target.txt', line: 3, quote: 'after' }] }] })),
  { files: { 'target.txt': 'after\nafter\n' } });
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /citation does not match/);
  assert.ok(!(await f.events(runId)).some(e => ['workflow.citation-correction', 'workflow.acceptance'].includes(e.type)));
});

test('Retry resumes formatting of an interrupted evidence correction without redoing either review', async t => {
  const f = await fixture(t, args => {
    if (args.id.endsWith('.format')) {
      if (!args.count) throw new Error('Transient formatter failure');
      return finished(review());
    }
    if (args.id.endsWith('evidence-repair')) {
      const candidate = review(); delete candidate.criteria[0].passed;
      return finished(candidate);
    }
    if (args.id.endsWith('review-0')) return finished(review({ criteria: [{ ...review().criteria[0],
      references: [{ file: 'target.txt', line: 1, quote: '1: after' }] }] }));
    return happy(args);
  });
  const first = await f.run();
  assert.equal(first.outcome.status, 'failed');
  const retry = await restartStackBlock(f.host, first.runId, 'deliver');
  assert.equal((await retry.run.settled()).status, 'done');
  assert.equal(f.counts.get('deliver.change-review-0'), 1);
  assert.equal(f.counts.get('deliver.change-review-0-evidence-repair'), 1);
  assert.equal(f.counts.get('deliver.change-review-0-evidence-repair.format'), 2);
  assert.equal((await f.events(first.runId)).filter(e => e.type === 'tool.call' && e.data.name === 'write_file').length, 1);
});

test('paraphrased reviewer labels are corrected by formatting without rereading or redoing implementation', async t => {
  const f = await fixture(t, args => args.id.endsWith('review-0') ? finished(review({ criteria: [
    { criterion: 'The target now contains the requested text', passed: true, evidence: 'Current contents',
      references: [{ file: 'target.txt', line: 1, quote: 'after' }] },
  ] })) : happy(args));
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal((await f.events(runId)).filter(e => e.type === 'tool.call' && e.data.name === 'write_file').length, 1);
  assert.equal(f.counts.get('deliver.change-review-0.format'), 1);
  assert.equal(f.counts.has('deliver.change-review-0-evidence-repair'), false);
  assert.equal(f.counts.has('deliver.change-work-1'), false);
});

test('short review criterion identities retain the original requirement in accepted evidence', async t => {
  const f = await fixture(t, args => args.id.includes('review') ? finished(review({ criteria: [
    { criterion: 'c1', passed: true, evidence: 'Current contents', references: [{ file: 'target.txt', line: 1, quote: 'after' }] },
  ] })) : happy(args));
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  const accepted = (await f.events(runId)).find(e => e.type === 'workflow.acceptance');
  assert.equal(accepted.data.review.criteria[0].criterion, 'Target contains after');
  assert.equal(f.counts.has('deliver.change-work-1'), false);
});

test('retrying a failed review regenerates only the invalid review and retains the worker', async t => {
  let corrected = false;
  const f = await fixture(t, args => args.id.includes('review') ? finished(review({ criteria: [
    { criterion: corrected ? 'c1' : 'paraphrased requirement', passed: true, evidence: 'Current contents',
      references: [{ file: 'target.txt', line: 1, quote: 'after' }] },
  ] })) : happy(args));
  const first = await f.run();
  assert.equal(first.outcome.status, 'failed');
  corrected = true;
  const resumed = await restartStackBlock(f.host, first.runId, 'deliver');
  assert.equal((await resumed.run.settled()).status, 'done');
  const events = await f.events(first.runId);
  assert.equal(events.filter(e => e.type === 'tool.call' && e.data.name === 'write_file').length, 1);
  assert.equal(events.filter(e => e.type === 'workflow.budget').length, 1);
});

test('source drift during review cannot become a resumable accepted checkpoint', async t => {
  const f = await fixture(t, args => {
    if (args.id.includes('review')) fs.writeFileSync(path.join(args.workspace, 'external.txt'), 'external edit\n');
    return happy(args);
  });
  const first = await f.run();
  assert.equal(first.outcome.status, 'failed');
  assert.match(first.outcome.error, /review is stale/);
  const calls = f.seen.length;
  const resumed = await restartStackBlock(f.host, first.runId, 'deliver');
  const outcome = await resumed.run.settled();
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Workspace changed since/);
  assert.equal(f.seen.length, calls);
});

test('a clean review corrects a contradictory pass with optional test findings', async t => {
  const f = await fixture(t, ({ id }) => finished(id.endsWith('evidence-repair') ? review()
    : review({ findings: [{ file: 'target.txt', line: 1, trigger: 'A future change', consequence: 'Might break a test', evidence: 'Optional extra test suggested.' }] })), { stack: 'review-change', git: true });
  const { outcome, runId } = await f.run('Review the current change. Only report introduced behavior defects.');
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal(f.seen.length, 2);
  assert.ok(!(await f.events(runId)).some(e => e.type === 'tool.call' && /write|edit/.test(e.data.name)));
});

test('a pass verdict with false criteria gets one reader correction without implementation replay', async t => {
  const f = await fixture(t, args => args.id.endsWith('review-0')
    ? finished(review({ criteria: review().criteria.map(item => ({ ...item, passed: false })) })) : happy(args));
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  assert.equal(f.counts.get('deliver.change-review-0-evidence-repair'), 1);
  assert.equal(f.counts.has('deliver.change-work-1'), false);
  assert.equal((await f.events(runId)).filter(e => e.type === 'tool.call' && e.data.name === 'write_file').length, 1);
});

test('a repeated contradictory review cannot become acceptance and Retry retains the worker', async t => {
  let corrected = false;
  const f = await fixture(t, args => args.id.includes('review') && !corrected
    ? finished(review({ criteria: review().criteria.map(item => ({ ...item, passed: false })) })) : happy(args));
  const first = await f.run();
  assert.equal(first.outcome.status, 'failed');
  assert.match(first.outcome.error, /verdict contradicts/);
  assert.ok(!(await f.events(first.runId)).some(e => e.type === 'workflow.acceptance'));
  corrected = true;
  const retry = await restartStackBlock(f.host, first.runId, 'deliver');
  assert.equal((await retry.run.settled()).status, 'done');
  const events = await f.events(first.runId);
  assert.equal(events.filter(e => e.type === 'tool.call' && e.data.name === 'write_file').length, 1);
  assert.equal(events.filter(e => e.type === 'workflow.budget').length, 1);
});

test('workflow measurements attribute canonical session envelopes to their actual run', async t => {
  const { workflowMeasurements } = await import('../core/workflowMeasurements.js');
  const f = await fixture(t, happy);
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'done', outcome.error);
  const measured = workflowMeasurements(f.store, runId);
  assert.equal(measured.completed, true); assert.equal(measured.unresolved, 0);
  assert.ok(measured.latencyMs >= 0);
  assert.deepEqual(measured.acceptedMilestones, ['change']);
});

test('unchanged evidence is stored once across checks and reviews', async t => {
  const f = await fixture(t, happy);
  const support = f.host.ctx.workflowSupport;
  const first = await support.capture('shared-evidence', 'initial');
  const second = await support.capture('shared-evidence', 'review');
  assert.equal(second.id, first.id);
  assert.equal(fs.readdirSync(path.join(f.root, 'runs', 'shared-evidence', 'workflow-evidence')).length, 1);
});

test('Fix a bug reruns the observed reproducer even if the worker omits it from checks', async t => {
  const command = 'node -e "if(require(\'fs\').readFileSync(\'target.txt\',\'utf8\').trim()!==\'fixed\')process.exit(1)"';
  const f = await fixture(t, ({ id, count }) => {
    if (id.includes('work-0')) return count === 0 ? tool('bash', { command }, 'repro')
      : count === 1 ? tool('write_file', { path: 'target.txt', content: 'after\n' }) : finished(completion({ reproduction: 'The observed command is the reproducer.' }));
    if (id.includes('work-')) return finished(completion({ reproduction: 'The observed command is the reproducer.' }));
    return finished(review());
  }, { stack: 'fix-bug' });
  const { outcome, runId } = await f.run();
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Repair allowance exhausted/);
  const checks = (await f.events(runId)).filter(e => e.type === 'workflow.verification');
  assert.equal(checks.length, 3);
  assert.ok(checks.every(e => e.data.receipt.command === command && !e.data.receipt.passed));
});
