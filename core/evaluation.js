// Benchmark definitions are immutable data. Execution remains GoalController /
// RunController-owned; this module contains no scheduler or provider client.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Ajv from 'ajv';
import { evaluators, digest, metric, rank, validateResult } from '#kernel';
import { serializeStack } from './stackstore.js';
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const string = { type: 'string', minLength: 1, maxLength: 8000 };
const identifier = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' };
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const artifact = object({ text: { type: 'string', maxLength: 24000 }, source: { type: ['string', 'null'], maxLength: 64000 }, provenance: { type: 'object' }, limitations: { type: 'string', maxLength: 2000 }, reviewed: { type: 'boolean' } }, ['text']);
export const SUITE_SCHEMA = object({
  id: identifier, version: { type: 'integer', minimum: 1 }, name: string,
  evaluators: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object' } },
  cases: { type: 'array', minItems: 1, maxItems: 30, items: object({ id: identifier, input: string, requirements: { type: 'string', maxLength: 8000 }, split: { enum: ['development', 'validation', 'held-out'] }, repeats: { type: 'integer', minimum: 1, maximum: 20 }, tags: { type: 'array', items: string, maxItems: 10 }, references: { type: 'array', items: artifact, maxItems: 5 },
    evaluators: { type: 'array', items: { type: 'object' }, maxItems: 30 }, fixtures: { type: 'array', maxItems: 10, items: object({ path: string, text: { type: 'string', maxLength: 16000 } }, ['path', 'text']) },
  }, ['id', 'input', 'split', 'repeats']) },
}, ['id', 'version', 'name', 'evaluators', 'cases']);
export const EVALUATION_SCHEMA = object({
  version: { const: 1 }, suite: SUITE_SCHEMA, target: { enum: ['artifact', 'plan', 'task-graph', 'workflow'] }, targetConfig: object({ minTasks: { type: 'integer', minimum: 1, maximum: 24 }, maxTasks: { type: 'integer', minimum: 1, maximum: 24 }, parallelism: { enum: ['low', 'medium', 'high'] }, maxTokens: { type: 'integer', minimum: 1, maximum: 131072 }, maxOutputWords: { type: 'integer', minimum: 1, maximum: 100000 } }),
  baseline: artifact, ranking: object({ primary: string, tieBreakers: { type: 'array', maxItems: 5, items: string }, minImprovement: { type: 'number', minimum: 0 }, tolerances: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } } }, ['primary']),
  targetThreshold: object({ metric: string, value: { type: 'number' }, direction: { enum: ['higher', 'lower'] } }, ['metric', 'value', 'direction']),
  finalVerification: object({ required: { type: 'boolean' } }, ['required']),
  referencePreparation: object({ fromSetup: { const: true } }, ['fromSetup']),
  promotion: object({ mode: { enum: ['off', 'automatic', 'manual'] }, limit: { type: 'integer', minimum: 0, maximum: 5 }, confirmation: { const: 'fresh-evaluation' } }, ['mode', 'limit', 'confirmation']),
}, ['version', 'suite', 'target', 'ranking', 'finalVerification', 'promotion']);
const finite = value => { if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Evaluation values must be finite'); if (value && typeof value === 'object') Object.values(value).forEach(finite); };
export function validateSuite(suite) {
  finite(suite);
  if (JSON.stringify(suite).length > 96000 || !ajv.validate(SUITE_SCHEMA, suite)) throw new Error(`Invalid benchmark: ${ajv.errorsText()}`);
  evaluators.validate(suite.evaluators);
  if (new Set(suite.cases.map(c => c.id)).size !== suite.cases.length) throw new Error('Duplicate benchmark case ID');
  if (!suite.cases.some(c => c.split === 'development')) throw new Error('At least one development case is required');
  for (const item of suite.cases) {
    evaluators.validate([...suite.evaluators, ...(item.evaluators ?? [])]);
    for (const fixture of item.fixtures ?? []) safeRelative(fixture.path);
  }
  return structuredClone(suite);
}
export function validateEvaluation(config) {
  finite(config);
  if (!ajv.validate(EVALUATION_SCHEMA, config)) throw new Error(`Invalid evaluation policy: ${ajv.errorsText()}`);
  validateSuite(config.suite);
  const names = new Set(['gateRate']);
  for (const e of [...config.suite.evaluators, ...config.suite.cases.flatMap(c => c.evaluators ?? [])]) {
    const fields = e.id === 'runtime' ? ['latencyMs', 'planningMs', 'readyDelayMs', 'peakWorkers', 'modelCalls', 'tokens', 'knownUsd', 'repairs', 'fallbacks', 'unresolved'] : e.id === 'ai-rubric' ? e.config.dimensions.map(d => d.id) : e.id === 'block-contract' ? ['rawFormat'] : e.id === 'command' && e.config.metricSchema ? ['measured'] : [];
    for (const field of fields) names.add(`${e.name}.${field}`);
  }
  if ([config.ranking.primary, ...(config.ranking.tieBreakers ?? []), ...(config.targetThreshold ? [config.targetThreshold.metric] : [])].some(name => !names.has(name))) throw new Error('Ranking and target must name a configured metric');
  if (Object.keys(config.ranking.tolerances ?? {}).some(name => ![config.ranking.primary, ...(config.ranking.tieBreakers ?? [])].includes(name))) throw new Error('Tolerances must name ranking metrics');
  if (config.finalVerification.required && !config.suite.cases.some(c => c.split === 'held-out')) throw new Error('Final verification requires a held-out split');
  if (config.promotion.mode !== 'off') {
    if (!config.baseline || (!config.referencePreparation && !config.suite.cases.every(c => c.references?.length))) throw new Error('Promotion requires a fixed baseline and reference for every case, or explicit setup preparation');
    const comparison = config.suite.evaluators.find(e => e.id === 'reference');
    if (!comparison || !comparison.config.dimensions.some(d => d.minGain > 0)) throw new Error('Promotion requires blinded comparison and a named meaningful gain');
  }
  return structuredClone(config);
}
export function safeRelative(relative) {
  if (typeof relative !== 'string' || /^[\\/]|^[a-z]:|:|\x00/i.test(relative) || relative.split(/[\\/]/).some(p => ['..', '.flyt', '.goal-tests'].includes(p))) throw new Error('Fixture path must stay inside the clean case folder');
}
const safeId = value => { if (!/^[\w-]{1,100}$/.test(value)) throw new Error('Invalid evaluation identity'); return value; };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function immutable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
  try { fs.linkSync(temp, file); return value; } catch (e) { if (e.code !== 'EEXIST') throw e; return read(file); } finally { fs.unlinkSync(temp); }
}
export class BenchmarkStore {
  constructor(project) { this.project = project; }
  root(projectId) { return path.join(this.project(projectId).store.rootDir, 'benchmarks'); }
  list({ projectId }) { const root = this.root(projectId); return fs.existsSync(root) ? fs.readdirSync(root).filter(f => /^[\w-]+\.json$/.test(f)).map(f => read(path.join(root, f))) : []; }
  get({ projectId, id, version }) { return read(path.join(this.root(projectId), `${safeId(id)}-${Number(version)}.json`)); }
  save({ projectId, suite, baseVersion = 0 }) {
    validateSuite(suite);
    const versions = this.list({ projectId }).filter(s => s.id === suite.id);
    const latest = Math.max(0, ...versions.map(s => s.version));
    if (baseVersion !== latest || suite.version !== latest + 1) throw new Error('Stale benchmark revision');
    const next = { ...structuredClone(suite), digest: digest(suite) }, file = path.join(this.root(projectId), `${safeId(suite.id)}-${suite.version}.json`);
    const saved = immutable(file, next);
    if (saved.digest !== next.digest) throw new Error('Stale benchmark revision');
    return saved;
  }
  export(args) { const { digest: _digest, ...suite } = this.get(args); return JSON.stringify(suite, null, 2); }
}
export function aggregate(reports, scheduled = reports.length) {
  const required = reports.flatMap(r => r.checks.filter(c => c.mandatory));
  const metrics = { gateRate: metric(required.length ? required.filter(c => c.status === 'pass').length / required.length : null, 'ratio', 'higher', required.length, 'rate') };
  for (const name of new Set(reports.flatMap(r => Object.keys(r.metrics)))) {
    const entries = reports.map(r => r.metrics[name]); const known = entries.filter(m => m?.value != null), first = entries.find(Boolean);
    const compatible = first && known.every(m => m.unit === first.unit && m.direction === first.direction && m.aggregation === first.aggregation);
    const all = known.length === reports.length && reports.length === scheduled;
    metrics[name] = compatible ? metric(all ? (first.aggregation === 'sum' ? known.reduce((sum, m) => sum + m.value, 0) : known.reduce((sum, m) => sum + m.value * m.samples, 0) / known.reduce((sum, m) => sum + m.samples, 0)) : null, first.unit, first.direction, known.reduce((sum, m) => sum + m.samples, 0), first.aggregation) : metric(null, 'unknown', 'higher', 0);
  }
  const attempted = reports.filter(r => r.runtime?.attempted).length;
  const count = field => reports.filter(r => r.runtime?.[field]).length;
  const firstSuccess = reports.filter(r => r.runtime?.initial?.contractValid === true).length;
  return { eligible: reports.length === scheduled && reports.length > 0 && reports.every(r => r.eligible), comparable: reports.length === scheduled && reports.every(r => r.comparable), metrics,
    counts: { scheduled, attempted, responses: count('responses'), completed: count('completed'), errors: reports.filter(r => r.status === 'error').length, cancelled: count('cancelled'), firstSuccess, repairs: count('repairs'), fallbacks: count('fallbacks'), unresolved: count('unresolved') },
    firstAttemptRate: attempted ? firstSuccess / attempted : null, recoveryRate: attempted ? reports.filter(r => r.runtime?.repairs && r.runtime?.completed && !r.runtime?.fallbacks).length / attempted : null,
    fallbackRate: attempted ? count('fallbacks') / attempted : null, unresolvedRate: attempted ? count('unresolved') / attempted : null,
    comparison: reports.length && reports.every(r => r.comparison === 'better') ? 'better' : reports.every(r => ['better', 'equivalent'].includes(r.comparison)) && reports.some(r => r.comparison === 'better') ? 'better' : 'inconclusive',
    scope: 'Observed finite suite and configured sample counts; no statistical or universal reliability claim' };
}
export const evaluationRecipe = config => serializeStack({ id: 'runtime-evaluation', name: 'Runtime-owned evaluation', root: { kind: 'sequence', id: 'root', children: [{ kind: 'block', id: 'verify', use: 'flyt-blocks-judgement:robust-evaluation', config }] } });

export async function evaluateCandidate(controller, record, candidate, label, suite, split = 'development', options = {}) {
  const { state } = record, policy = state.contract.evaluation;
  const cases = suite.cases.filter(c => c.split === split && (!options.caseIds || options.caseIds.includes(c.id))), reports = [], reportIds = [];
  const version = `${suite.id}@${suite.version}:${digest(suite).slice(0, 16)}`;
  const jobs = cases.flatMap(item => Array.from({ length: options.repeats ?? Math.max(item.repeats, options.minimumRepeats ?? 0) }, (_, repeat) => ({ item, repeat })));
  const runTrial = async ({ item, repeat }, index) => {
    const phase = `evaluation-${label}-${suite.version}-${item.id}-${repeat}`;
    const trial = controller.trialRecord?.(record, phase) ?? record;
    const reportId = `report-${phase}`;
    if (fs.existsSync(controller.recordPath(state, reportId))) { reports[index] = read(controller.recordPath(state, reportId)); reportIds[index] = reportId; return; }
    const folder = controller.evaluationFolder(state, phase);
    for (const fixture of item.fixtures ?? []) controller.fixture(folder, fixture);
    const request = { id: phase, goalId: state.id, trialId: phase, caseId: item.id, benchmarkVersion: version,
      artifact: { text: candidate.text }, originalRequest: item.input, constraints: item.requirements ?? state.contract.constraints,
      evaluators: [...suite.evaluators, ...(item.evaluators ?? [])], ...(item.references?.length ? { reference: item.references[0], references: item.references } : {}) };
    let report;
    try {
      let target = policy.target;
      if (target === 'workflow') {
        const executed = await controller.once(trial, `candidate-${phase}`, candidate.source, item.input, folder);
        request.artifact.text = executed.output; target = 'artifact';
      }
      const source = evaluationRecipe({ request, target, targetConfig: policy.targetConfig ?? {}, ...(target === 'artifact' ? {} : { candidatePrompt: candidate.text }) });
      const child = await controller.once(trial, phase, source, item.input, policy.target === 'artifact' ? state.workspace.path : folder);
      report = JSON.parse(child.output); validateResult(report);
      // Evaluator exception handling cannot swallow owner control decisions.
      if (record.reserveHit) throw Object.assign(new Error('Search reached protected confirmation capacity'), { code: 'campaign_reserve' });
      if (state.pricingPause) throw Object.assign(new Error(state.pricingPause), { code: 'campaign_pricing' });
    } catch (error) {
      const cancelled = Boolean(record.requested || record.abort?.signal.aborted), status = cancelled ? 'skipped' : 'error';
      report = { id: phase, version: 1, goalId: state.id, runId: state.activeChild?.runId ?? null, trialId: phase, caseId: item.id, benchmarkVersion: version, artifactDigest: digest(request.artifact), configDigest: digest(request.evaluators),
        status, eligible: false, comparable: false, checks: [{ name: 'execution', mandatory: true, status, code: cancelled ? 'cancelled' : 'evaluation_infrastructure_error', explanation: String(error.message).slice(0, 1600) }],
        metrics: {}, evaluations: [], comparison: null, evidence: { artifact: digest(request.artifact), excerpt: request.artifact.text.slice(0, 1800) },
        execution: { durationMs: 0, modelCalls: null, knownUsd: null, unknownUsage: ['Interrupted or unavailable execution; see owning session'] },
        artifact: request.artifact, runtime: { attempted: false, completed: false, cancelled, unresolved: 1, infrastructure: true } };
      validateResult(report);
      // Stop/limits preserve ownership recovery; they never continue the suite.
      if (cancelled || ['goal_limit', 'goal_cleanup_pending', 'goal_control', 'campaign_reserve', 'campaign_pricing'].includes(error.code)) {
        controller.putRecord(state, `${reportId}-interrupted`, report);
        state.evaluationInterruption = { record: `${reportId}-interrupted`, reason: report.checks[0].explanation }; controller.save(state);
        throw error;
      }
      trial.state.activeChild = null; controller.save(state);
    }
    controller.putRecord(state, reportId, report);
    reports[index] = report; reportIds[index] = reportId;
  };
  // Settle every launched trial before releasing Goal ownership on failure.
  let cursor = 0, failure = null;
  const workers = Array.from({ length: Math.min(jobs.length, options.concurrency ?? state.contract.campaign?.concurrency ?? 1) }, async () => {
    while (!failure && cursor < jobs.length) { const index = cursor++; try { await runTrial(jobs[index], index); } catch (error) { failure ??= error; } }
  });
  await Promise.allSettled(workers);
  if (failure) throw failure;
  return { ...aggregate(reports, jobs.length), benchmarkVersion: version, suiteVersion: suite.version, split, reportIds,
    tier: options.tier ?? 'development', samples: reports.map((r, index) => ({ caseId: r.caseId, repeat: jobs[index].repeat, tags: jobs[index].item.tags ?? [], metrics: r.metrics, eligible: r.eligible, status: r.status, reportId: reportIds[index] })),
    model: state.contract.worker, configDigest: digest(policy), candidateDigest: digest(candidate), reports };
}
export function targetMet(evaluation, policy) {
  if (!evaluation.eligible) return false;
  const target = policy.targetThreshold;
  if (!target) return true;
  const m = evaluation.metrics[target.metric];
  return m?.value != null && (target.direction === 'higher' ? m.value >= target.value : m.value <= target.value);
}
export { rank, digest };
