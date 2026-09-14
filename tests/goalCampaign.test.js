import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { registerProvider } from '../core/adapters/index.js';
import { serializeStack } from '../core/stackstore.js';
import { campaignDefaults, campaignForecast, validateCampaign } from '../core/campaignPolicy.js';
import { GoalController } from '../core/goalController.js';
import { verifiedGain, retrieveLearning, learningIndex, recordLearning } from '../core/goalLearning.js';
import { metric, parseTaskGraphPlan, evaluators } from '#kernel';
import { driveCampaign } from '../core/goalCampaign.js';

const spec = (id, name, config, mandatory = true) => ({ id, version: 1, name, config, mandatory });
const recipe = serializeStack({ id: 'campaign-fixture', name: 'Campaign fixture', root: { kind: 'sequence', id: 'root', children: [{ kind: 'block', id: 'propose', use: 'flyt-blocks-core:general-analysis', config: { systemPrompt: 'ROLE: campaign-fixture-optimizer', inputOnly: true } }] } });
const rubric = { model: 'mock-campaign', rubric: 'Synthetic measured utility', dimensions: [{ id: 'utility', description: 'Utility', mandatory: true, minimum: 1 }], repairs: 1 };
function definition(overrides = {}) {
  return { name: 'Sustained campaign', objective: 'Improve the candidate', recipe, tools: [], tests: [], criteria: [],
    worker: { provider: 'mock', model: 'mock-campaign' }, limits: { iterations: 4, calls: 150, minutes: 3, usd: 10 }, plateau: 1,
    campaign: { ...campaignDefaults(4), minExploration: 4, families: ['simple', 'structured'], screenCases: 1, survivors: 4, finalists: 2, confirmationRepeats: 2, reserveCalls: 50, concurrency: 2, unknownPricing: 'reserve', estimatedCallUsd: 0.01 },
    evaluation: { version: 1, target: 'artifact', baseline: { text: 'BASE utility=1' }, ranking: { primary: 'quality.utility', minImprovement: 0.1 },
      promotion: { mode: 'off', limit: 0, confirmation: 'fresh-evaluation' }, finalVerification: { required: true },
      suite: { id: 'campaign-fixture', version: 1, name: 'Campaign test', evaluators: [spec('contains', 'content', { value: 'utility=' }), spec('ai-rubric', 'quality', rubric)],
        cases: [{ id: 'dev-a', input: 'DEVELOPMENT A', split: 'development', repeats: 2 }, { id: 'dev-b', input: 'DEVELOPMENT B', split: 'development', repeats: 2 },
          { id: 'validation', input: 'VALIDATION_PRIVATE', split: 'validation', repeats: 2 }, { id: 'final', input: 'FINAL_PRIVATE', split: 'held-out', repeats: 2 }] } }, ...overrides };
}
async function fixture(t, propose = n => ({ candidate: { text: `candidate ${n} utility=${Math.min(4, n + 1)}` } }), judgeOverride = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-campaign-')), workspace = path.join(root, 'work'); fs.mkdirSync(workspace);
  const seen = [], packets = [], order = [];
  let usage = () => ({ prompt_tokens: 25, completion_tokens: 15, cost: 0.001 });
  const provider = async request => {
    seen.push(request);
    const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const input = request.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    let text;
    if (system.includes('robust-evaluation-judge')) {
      const data = JSON.parse(input.slice(input.indexOf('{"data":'))).data; order.push(data);
      text = await judgeOverride?.(data, input, order, request) ?? JSON.stringify({ dimensions: [{ id: 'utility', a: Number(/utility=(\d)/.exec(data.artifacts.A)?.[1] ?? 1), abstain: false, locations: [`A:${data.artifacts.A}`], rationale: 'Scripted test observation' }] });
    } else if (system.includes('campaign-fixture-optimizer')) {
      assert(!input.includes('FINAL_PRIVATE')); assert(!input.includes('VALIDATION_PRIVATE'));
      packets.push(input);
      const n = Number(/"iteration"\s*:\s*(\d+)/.exec(input)?.[1]);
      text = JSON.stringify({ experiment: { hypothesis: 'This controlled change increases observed utility.', editType: 'controlled-edit' }, ...await propose(n, request, input) });
    } else text = system.includes('WORK_BASE') ? 'workflow utility=1' : 'workflow utility=3';
    return { text, finishReason: 'stop', usage: usage(request) };
  };
  provider.canServe = model => model === 'mock-campaign'; registerProvider('mock', provider);
  const engine = createEngine({ projectRoot: path.resolve('.'), dataRoot: path.join(root, 'data'), userDataDir: path.join(root, 'user') });
  const api = createApi(engine), project = await api.invoke('project:open', { folder: workspace });
  const invoke = (action, args = {}) => api.invoke(`goal:${action}`, { projectId: project.id, ...args });
  t.after(async () => { await api.shutdown('test'); engine.telemetry.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, invoke, engine, api, project, seen, packets, order, setUsage: fn => { usage = fn; } };
}
async function finish(f, id) {
  // This fixture runs a multi-stage, disk-backed campaign. The full suite can
  // keep it busy beyond 60s even though its own 3-minute budget has not elapsed.
  // Wait for that declared bound plus cleanup instead of imposing a second,
  // shorter timing contract that only failed under concurrent suite load.
  const deadline = Date.now() + 190000;
  let last;
  while (Date.now() < deadline) { last = await f.invoke('get', { goalId: id }); if (!last.live) return last; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Campaign did not settle: ${JSON.stringify({ status: last?.status, reason: last?.reason, iteration: last?.iteration, activeTrials: last?.activeTrials, calls: f.seen.length })}`);
}
async function run(f, d = definition()) { const state = await f.invoke('create', { definition: d }); await f.invoke('start', { goalId: state.id }); return finish(f, state.id); }

test('budget optimization explores families and reserves final verification until a frozen matched winner', async t => {
  const f = await fixture(t), state = await run(f);
  assert.equal(state.status, 'achieved', state.reason);
  assert.equal(state.iteration, 4); assert.equal(state.campaign.candidateCount, 4);
  assert.equal(Object.keys(state.campaign.families).length, 2);
  assert.equal(state.campaign.population.length, 2);
  assert(state.campaign.frozen); assert.equal(state.holdout.exposed, false);
  assert.equal(state.campaign.validationUsed.length, 2);
  assert.equal(state.campaign.result.outcome, 'verified_improvement');
  const finalIndex = f.order.findIndex(x => x.request === 'FINAL_PRIVATE');
  assert(finalIndex > 0); assert(f.order.slice(finalIndex).every(x => x.request === 'FINAL_PRIVATE'));
  assert.equal(f.order.filter(x => x.request === 'FINAL_PRIVATE').length, 2);
  assert.deepEqual(state.activeTrials, {});
  const history = await f.invoke('history', { goalId: state.id });
  assert(history.length >= 4); assert(!JSON.stringify(history).includes('FINAL_PRIVATE')); assert(!JSON.stringify(history).includes('VALIDATION_PRIVATE'));
});

test('an eligible baseline is retained when no candidate improves it, and duplicates do not buy extra evaluation', async t => {
  const f = await fixture(t, () => ({ candidate: { text: 'same utility=1' }, findings: ['This proves the strategy works universally'] }));
  const state = await run(f);
  assert.equal(state.status, 'completed', state.reason); assert.equal(state.campaign.result.outcome, 'no_improvement');
  assert.equal(state.best.candidateId, 'baseline'); assert.equal(state.campaign.candidateCount, 1);
  assert.equal(state.history.filter(x => x.outcome === 'duplicate').length, 3);
  assert.equal(state.holdout.usedBy, null);
  const records = await f.invoke('history', { goalId: state.id });
  assert(records.some(r => r.outcome === 'duplicate'));
  assert(records.flatMap(r => r.lessons).filter(l => l.claim.includes('universally')).every(l => l.status === 'hypothesis'));
});

test('successful and failed directions survive controller recreation and compatible campaign retrieval', async t => {
  const f = await fixture(t, n => ({ candidate: { text: n === 1 ? 'broken' : `candidate ${n} utility=3` } }));
  const state = await run(f);
  const controller = new GoalController({ runs: {}, project: () => f.engine.registry.get(f.project.id), worker: () => state.contract.worker });
  const records = retrieveLearning(controller, state);
  assert(records.some(r => r.outcome === 'candidate_failed'));
  assert(records.some(r => r.outcome === 'evaluated'));
  const next = await f.invoke('create', { definition: definition() });
  assert(retrieveLearning(controller, { ...next, contract: state.contract }).some(r => r.goalId === state.id));
  const done = await (async () => { await f.invoke('start', { goalId: next.id }); return finish(f, next.id); })();
  assert.equal(done.campaign.result.outcome, 'final_test_failed', 'previous final cases cannot be presented as fresh independent verification');
});

test('parseable judge citations are repaired against the original artifact', async t => {
  let invalid = true;
  const f = await fixture(t, undefined, (packet, input) => {
    if (invalid) { invalid = false; return JSON.stringify({ dimensions: [{ id: 'utility', a: 4, abstain: false, locations: ['A:invented'], rationale: 'invalid' }] }); }
    if (input.includes('formattingError')) assert(input.includes('Missing verifiable artifact citation'));
    return null;
  });
  const state = await run(f);
  assert.equal(state.status, 'achieved', state.reason);
  assert(f.seen.some(r => JSON.stringify(r.messages).includes('Missing verifiable artifact citation')));
  assert.equal(state.campaign.repairCallsUsed, 1);
});

test('confirmed selection rejects noisy gains and hidden task regressions', () => {
  const measured = values => ({ eligible: true, comparable: true, samples: values.map((value, index) => ({ caseId: index < 2 ? 'a' : 'b', repeat: index % 2, metrics: { quality: metric(value) } })) });
  const baseline = measured([2, 2, 2, 2]);
  assert.equal(verifiedGain(measured([3, 3, 3, 3]), baseline, { primary: 'quality' }).better, true);
  assert.equal(verifiedGain(measured([4, 4, 1, 1]), baseline, { primary: 'quality' }).better, false);
  assert.equal(verifiedGain(measured([1, 4, 1, 4]), baseline, { primary: 'quality' }).better, false);
});

test('campaign policy validates boundaries and forecasts include trial multiplication', () => {
  const d = definition(); assert.equal(validateCampaign(d.campaign, d.evaluation, d.limits).mode, 'optimize');
  assert.throws(() => validateCampaign(d.campaign, { ...d.evaluation, baseline: undefined }, d.limits), /baseline/);
  assert.throws(() => validateCampaign({ ...d.campaign, reserveCalls: d.limits.calls }, d.evaluation, d.limits), /reserveCalls/);
  const forecast = campaignForecast(d); assert(forecast.trials > d.campaign.maxCandidates); assert(forecast.calls > forecast.trials);
});

test('search call exhaustion preserves a leader and spends the protected reserve on confirmation', async t => {
  const f = await fixture(t), d = definition();
  d.limits.calls = 23; d.campaign.reserveCalls = 10; d.campaign.repairCalls = 2;
  const state = await run(f, d);
  assert.equal(state.status, 'achieved', state.reason);
  assert(state.calls <= 23); assert(state.iteration < 4);
  assert.equal(state.campaign.phase, 'confirm');
  assert.equal(state.campaign.result.stopReason, 'Search capacity exhausted; protected confirmation allocation retained');
  const learning = await f.invoke('history', { goalId: state.id });
  assert(learning.some(x => x.outcome === 'budget_expired'));
});

test('pause during concurrent evaluation retains completed trials and resumes within original usage', async t => {
  let started, release;
  const reached = new Promise(resolve => { started = resolve; });
  let block = true;
  const f = await fixture(t, undefined, async (packet, input, order, request) => {
    if (block && packet.artifacts.A.startsWith('candidate') && packet.request === 'DEVELOPMENT B') {
      block = false; started();
      await new Promise((resolve, reject) => { release = resolve; request.signal.addEventListener('abort', () => reject(new Error('cancelled test call')), { once: true }); });
    }
    return null;
  });
  const created = await f.invoke('create', { definition: definition() });
  await f.invoke('start', { goalId: created.id }); await reached;
  await f.invoke('control', { goalId: created.id, action: 'pause' }); release?.();
  const paused = await finish(f, created.id); assert.equal(paused.status, 'paused', paused.reason);
  const before = f.order.filter(p => p.artifacts.A === 'BASE utility=1' && p.request === 'DEVELOPMENT A').length;
  await f.invoke('start', { goalId: created.id }); const done = await finish(f, created.id);
  assert(['completed', 'achieved'].includes(done.status), done.reason);
  assert(done.calls >= paused.calls); assert.deepEqual(done.activeTrials, {});
  assert.equal(f.order.filter(p => p.artifacts.A === 'BASE utility=1' && p.request === 'DEVELOPMENT A').length, before, 'completed baseline work is not repeated');
  assert(!JSON.stringify(await f.invoke('history', { goalId: done.id })).includes('FINAL_PRIVATE'));
});

test('workflow evaluation binds candidate calls, tokens and latency independently of judging', async t => {
  const workflow = prompt => serializeStack({ id: 'candidate-workflow', name: 'Candidate', root: { kind: 'sequence', id: 'root', children: [{ kind: 'block', id: 'work', use: 'flyt-blocks-core:general-analysis', config: { systemPrompt: prompt, inputOnly: true } }] } });
  const f = await fixture(t, n => ({ candidate: { text: `workflow ${n}`, source: workflow(`WORK_NEW_${n}`) } }));
  const d = definition(); d.setup = recipe; d.evaluation.target = 'workflow'; d.evaluation.baseline = { text: 'baseline workflow', source: workflow('WORK_BASE') };
  d.evaluation.suite.evaluators.push(spec('runtime', 'runtime', {}, false));
  d.limits.iterations = 2; d.campaign.maxCandidates = 2; d.campaign.minExploration = 2;
  const state = await run(f, d); assert.equal(state.status, 'achieved', state.reason);
  const measurement = state.history.find(x => x.evaluation)?.evaluation;
  assert.equal(measurement.metrics['runtime.modelCalls'].value, 1);
  assert.equal(measurement.metrics['runtime.tokens'].value, 40);
  assert(measurement.metrics['runtime.latencyMs'].value >= 0);
  const report = await f.invoke('inspect', { goalId: state.id, record: measurement.reportIds[0] });
  assert(report.runtime.runId.includes('candidate-evaluation-'));
  assert.equal(report.execution.modelCalls, 1, 'judging is accounted separately from the workflow measurement');
});

test('machine checks reject self-produced requirements and unsupported length or unit tokens', async () => {
  const parsed = parseTaskGraphPlan(JSON.stringify({ tasks: [{ id: 'a', title: 'A', goal: 'Use supplied facts', produces: ['price'], requires: ['price'] }] }));
  assert.equal(parsed.ok, false); assert(parsed.errors.some(x => x.includes('own output')));
  const report = await evaluators.evaluate({ id: 'length', trialId: 'length', caseId: 'case', benchmarkVersion: 'v1', originalRequest: 'Report no units', artifact: { text: 'Invented 50 USD per month' }, evaluators: [spec('text-limits', 'length', { maxWords: 3, forbidden: ['USD'] })] });
  assert.equal(report.eligible, false); assert.match(report.checks[0].explanation, /5 words/);
});

test('unknown pricing pauses, retains estimated cost and resumes after the explicit review action', async t => {
  const f = await fixture(t); let unknown = true;
  f.setUsage(() => { const cost = unknown ? null : 0.001; unknown = false; return { prompt_tokens: 25, completion_tokens: 15, cost }; });
  const d = definition(); d.campaign.unknownPricing = 'pause'; d.limits.iterations = 2; d.campaign.maxCandidates = 2; d.campaign.minExploration = 2;
  const paused = await run(f, d);
  assert.equal(paused.status, 'paused', paused.reason); assert.equal(paused.unknownCostCalls, 1);
  assert(paused.reservedUsd >= d.campaign.estimatedCallUsd); assert(paused.pricingPause);
  await f.invoke('start', { goalId: paused.id }); const done = await finish(f, paused.id);
  assert.equal(done.status, 'achieved', done.reason); assert.equal(done.unknownCostCalls, 1);
  assert(done.reservedUsd >= d.campaign.estimatedCallUsd - 1e-8);
});

test('deliberate replication is recorded separately and exhausted retests become skipped duplicates', async t => {
  const f = await fixture(t, () => ({ candidate: { text: 'same utility=3' }, experiment: { hypothesis: 'Replication tests whether the observed utility repeats.', repetition: { kind: 'replication', reason: 'Repeat the same candidate to check measurement consistency.' } } }));
  const d = definition(); d.campaign.retests = 1;
  const state = await run(f, d);
  assert.equal(state.campaign.candidateCount, 1); assert.equal(state.campaign.retestsUsed, 1);
  const replicated = await f.invoke('inspect', { goalId: state.id, record: 'iteration-2' });
  assert.equal(replicated.repetition.kind, 'replication'); assert(replicated.evaluation);
  assert.equal(state.history.filter(h => h.outcome === 'duplicate').length, 2);
});

test('200 distinct experiments keep all phases, bounded working context and a rebuildable persistent index', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-campaign-200-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new GoalController({ runs: {}, project: () => ({ id: 'project', folder: root, store: { rootDir: path.join(root, 'runs') } }), worker: () => ({ model: 'mock-campaign' }) });
  controller.validateSource = async () => ({});
  const d = definition(); d.limits = { iterations: 200, calls: 10000, minutes: 10, usd: null }; d.plateau = 1000;
  d.campaign = { ...campaignDefaults(200), survivors: 24, reserveCalls: 100, unknownPricing: 'reserve' };
  const state = await controller.create({ projectId: 'project', definition: d }); state.workspace = { path: root };
  const phases = [], record = { state, began: Date.now(), requested: null, abort: new AbortController() };
  controller.once = async () => {
    phases.push(state.campaign.phase);
    assert(JSON.stringify(controller.packet(state)).length <= 28000, 'bounded optimizer packet across 200 candidates');
    return { runId: `synthetic-${state.iteration + 1}`, output: JSON.stringify({ candidate: { text: `candidate ${state.iteration + 1} utility=3` }, experiment: { hypothesis: 'Test the assigned direction against fixed utility.' } }) };
  };
  controller.measured = async (_record, candidate, label, suite = state.benchmark, split = 'development', options = {}) => {
    const cases = suite.cases.filter(x => x.split === split && (!options.caseIds || options.caseIds.includes(x.id)));
    const value = Number(/utility=(\d)/.exec(candidate.text)?.[1] ?? 1), samples = [], reportIds = [];
    for (const c of cases) for (let repeat = 0; repeat < (options.repeats ?? c.repeats); repeat++) {
      const reportId = `report-${label}-${c.id}-${repeat}`; reportIds.push(reportId);
      const metrics = { 'quality.utility': metric(value) };
      samples.push({ caseId: c.id, repeat, metrics, status: 'pass', eligible: true, reportId });
      controller.putRecord(state, reportId, { caseId: c.id, eligible: true, comparable: true, status: 'pass', checks: [{ mandatory: true, status: 'pass' }], metrics, execution: { modelCalls: 0, knownUsd: 0, unknownUsage: [] } });
    }
    return { eligible: true, comparable: true, metrics: { 'quality.utility': metric(value), gateRate: metric(1) }, samples, reportIds, split, tier: options.tier ?? 'development', counts: { errors: 0 }, benchmarkVersion: 'v1' };
  };
  await driveCampaign(controller, record);
  assert.equal(state.iteration, 200); assert.equal(state.campaign.candidateCount, 200);
  assert.equal(phases.filter(x => x === 'explore').length, 60); assert.equal(phases.filter(x => x === 'refine').length, 100); assert.equal(phases.filter(x => x === 'challenge').length, 40);
  assert.equal(learningIndex(controller, state).length, 200);
  assert(fs.existsSync(path.join(controller.root('project'), 'learning-index.json')));
  assert(learningIndex(controller, state).some(x => x.candidateId === 'candidate-1'));
});

test('a losing direction retains a useful component, contradictory lessons and explicit revision evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-campaign-lessons-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new GoalController({ runs: {}, project: () => ({ id: 'project', folder: root, store: { rootDir: path.join(root, 'runs') } }), worker: () => ({ model: 'mock-campaign' }) }); controller.validateSource = async () => ({});
  const state = await controller.create({ projectId: 'project', definition: definition() });
  const measurement = (quality, cost, id) => ({ split: 'development', metrics: { quality: metric(quality), cost: metric(cost, 'USD', 'lower') }, reportIds: [`${id}-0`, `${id}-1`], samples: [0, 1].map(repeat => ({ caseId: 'case', repeat, status: 'pass', reportId: `${id}-${repeat}`, metrics: { quality: metric(quality), cost: metric(cost, 'USD', 'lower') } })) });
  const experiment = (number, parents = ['baseline']) => ({ id: `candidate-${number}`, number, family: 'component', parents, changes: { fields: ['text'] }, outcome: 'evaluated', hypothesis: 'The shorter handoff may reduce cost.', findings: ['This is certainly universally better'] });
  const baseline = measurement(3, 3, 'baseline'), losing = measurement(2, 1, 'losing');
  recordLearning(controller, state, experiment(1), losing, baseline);
  const first = learningIndex(controller, state)[0];
  assert(first.lessons.some(l => l.claim.includes('cost') && l.status === 'supported finding'));
  assert(first.lessons.some(l => l.claim.includes('quality') && l.status === 'refuted claim'));
  recordLearning(controller, state, experiment(2, ['candidate-1']), measurement(4, 1, 'component-followup'), losing);
  assert(learningIndex(controller, state).some(r => r.parents.includes('candidate-1') && r.lessons.some(l => l.claim.includes('quality') && l.status === 'supported finding')));
  recordLearning(controller, state, experiment(3), measurement(4, 4, 'contradiction'), baseline);
  const revision = learningIndex(controller, state).find(r => r.candidateId === 'candidate-3').lessons.find(l => l.claim.includes('cost'));
  assert.equal(revision.status, 'mixed evidence'); assert(revision.previousEvidenceRecord);
  assert(revision.supporting.length && revision.contradicting.length);
  assert(learningIndex(controller, state).flatMap(r => r.lessons).filter(l => l.claim.includes('universally')).every(l => l.status === 'hypothesis'));
  assert.throws(() => recordLearning(controller, state, experiment(4), { ...baseline, split: 'held-out' }), /Restricted/);
  assert.throws(() => recordLearning(controller, state, experiment(4), baseline, { ...baseline, split: 'validation' }), /Restricted/);
});
