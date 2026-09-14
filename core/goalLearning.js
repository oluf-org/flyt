import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { digest } from './evaluation.js';
const caches = new Map();

export const candidateDigest = candidate => digest({ text: candidate.text, source: candidate.source ?? null });
export const caseFingerprint = item => digest({ input: item.input, fixtures: item.fixtures ?? [] });
export function learningScope(state) {
  const e = state.contract.evaluation;
  return { projectId: state.projectId, target: e.target, benchmark: e.suite.id,
    version: e.suite.version, worker: state.contract.worker, targetConfig: e.targetConfig ?? {},
    development: digest(e.suite.cases.filter(c => c.split === 'development')),
    evaluators: digest(e.suite.evaluators), constraints: state.contract.constraints,
    baseline: candidateDigest(e.baseline), runtimeFingerprint: state.runtimeFingerprint ?? null, policy: 'campaign-evidence-v1' };
}
// Immutable observations are authoritative; this scan is a rebuildable index.
// Restricted measurements never enter it, even when a caller asks for them.
export function learningIndex(controller, state) {
  const root = controller.root(state.projectId), records = [];
  if (!fs.existsSync(root)) return records;
  const cache = caches.get(root) ?? new Map(); caches.set(root, cache);
  const files = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/^[\w-]+$/.test(dir.name)) continue;
    for (const name of fs.readdirSync(path.join(root, dir.name)).filter(x => /^learning-experiment-\d+(?:-\d+)?\.json$/.test(x))) {
      try {
        const relative = `${dir.name}/${name}`; files.push(relative);
        const record = cache.get(relative) ?? JSON.parse(fs.readFileSync(path.join(root, dir.name, name), 'utf8'));
        if (record.split !== 'development' || record.scope?.projectId !== state.projectId) { cache.delete(relative); continue; }
        cache.set(relative, record);
        if (record.split === 'development' && record.scope?.projectId === state.projectId) records.push(record);
      } catch { /* A damaged index entry cannot hide other intact observations. */ }
    }
  }
  const indexFile = path.join(root, 'learning-index.json');
  const indexed = [...cache.entries()].filter(([file]) => files.includes(file)).map(([file, r]) => ({ file, id: r.id, at: r.at, scope: r.scope, family: r.family, outcome: r.outcome, hypotheses: r.hypothesis, evidence: r.evidence }));
  const signature = digest(indexed);
  if (cache.signature !== signature || !fs.existsSync(indexFile)) {
    const temporary = `${indexFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, signature, entries: indexed })); fs.renameSync(temporary, indexFile);
    cache.signature = signature;
  }
  return records;
}
export function retrieveLearning(controller, state, query = '', limit = 6) {
  const scope = learningScope(state), protectedCases = new Set(state.benchmark.cases.filter(c => c.split !== 'development').map(caseFingerprint));
  const compatible = learningIndex(controller, state).filter(r => (state.contract.campaign.reuseLearning || r.goalId === state.id)
    && r.scope.target === scope.target && r.scope.benchmark === scope.benchmark
    && !r.caseFingerprints.some(hash => protectedCases.has(hash))
    && JSON.stringify(r).toLowerCase().includes(String(query).toLowerCase()))
    .sort((a, b) => b.at.localeCompare(a.at));
  const varied = [];
  for (const kind of ['evaluated', 'candidate_failed', 'infrastructure_error', 'duplicate']) {
    const entry = compatible.find(r => r.outcome === kind); if (entry) varied.push(entry);
  }
  const selected = [...varied, ...compatible.filter(r => !varied.includes(r))].slice(0, Math.min(20, limit)).map(r => ({
      id: r.id, goalId: r.goalId, candidateId: r.candidateId, family: r.family, outcome: r.outcome,
      hypothesis: r.hypothesis, changes: { fields: r.changes.fields, parentDigest: r.changes.parentDigest, candidateDigest: r.changes.candidateDigest, textLengthDelta: r.changes.textLengthDelta }, parents: r.parents, evidence: r.evidence.slice(0, 3),
      observations: r.observations.slice(0, 3).map(o => ({ ...o, metrics: Object.fromEntries(Object.entries(o.metrics).slice(0, 4)) })),
      lessons: r.lessons.slice(0, 3).map(l => ({ claim: l.claim, status: l.status, conditions: l.conditions, revision: l.revision, previousEvidenceRecord: l.previousEvidenceRecord,
        supporting: l.supporting.slice(0, 2).map(({ experimentId, caseId, delta }) => ({ experimentId, caseId, delta })),
        contradicting: l.contradicting.slice(0, 2).map(({ experimentId, caseId, delta }) => ({ experimentId, caseId, delta })) })), investigations: r.investigations.slice(0, 1),
      applicability: scope.runtimeFingerprint && digest(r.scope) === digest(scope) ? 'compatible' : 'hypothesis requiring revalidation: model, workload, configuration or version changed',
    }));
  const bounded = [];
  for (const item of selected) { if (JSON.stringify([...bounded, item]).length > 10000) break; bounded.push(item); }
  return bounded;
}
export function exposedFinalCases(controller, state) {
  const protectedCases = new Set(state.benchmark.cases.filter(c => c.split === 'held-out').map(caseFingerprint));
  return learningIndex(controller, state).some(r => r.caseFingerprints.some(h => protectedCases.has(h)));
}
export function recordLearning(controller, state, experiment, evaluation, parentEvaluation = null) {
  if ([evaluation, parentEvaluation].some(e => e && e.split !== 'development')) throw new Error('Restricted evaluation evidence cannot enter optimizer learning');
  let revision = 1, recordName = `learning-experiment-${experiment.number}`;
  while (fs.existsSync(controller.recordPath(state, recordName))) {
    const previous = JSON.parse(fs.readFileSync(controller.recordPath(state, recordName), 'utf8'));
    if (previous.outcome === experiment.outcome && digest(previous.evidence) === digest(evaluation?.reportIds ?? [])) return;
    recordName = `learning-experiment-${experiment.number}-${++revision}`;
  }
  const observations = [], evidence = evaluation?.reportIds ?? [];
  for (const sample of evaluation?.samples ?? []) {
    observations.push({ caseId: sample.caseId, repeat: sample.repeat, status: sample.status, metrics: sample.metrics, reportId: sample.reportId });
  }
  const lessons = [];
  // Claims are literal scoped comparisons, never causal claims inferred from a
  // model's confidence. Repeated samples and a parent comparison are required.
  for (const name of Object.keys(evaluation?.metrics ?? {})) {
    const paired = (evaluation?.samples ?? []).map(s => {
      const before = parentEvaluation?.samples?.find(p => p.caseId === s.caseId && p.repeat === s.repeat);
      const a = s.metrics[name], b = before?.metrics[name];
      return a?.value != null && b?.value != null && a.unit === b.unit && a.direction === b.direction && s.status !== 'error' && before.status !== 'error'
        ? { caseId: s.caseId, delta: (a.value - b.value) * (a.direction === 'higher' ? 1 : -1), evidence: [s.reportId, before.reportId] } : null;
    }).filter(Boolean);
    if (!paired.length) continue;
    const gains = paired.filter(p => p.delta > 0), losses = paired.filter(p => p.delta < 0);
    const claim = `Observed ${name} changes for ${experiment.family} relative to ${experiment.parents.join(', ') || 'baseline'}`;
    lessons.push({ id: digest({ claim, scope: learningScope(state) }), revision: experiment.number,
      claim, status: gains.length && losses.length ? 'mixed evidence' : gains.length >= 2 ? 'supported finding' : losses.length >= 2 ? 'refuted claim' : 'hypothesis',
      supporting: gains.map(p => ({ experimentId: experiment.id, ...p })), contradicting: losses.map(p => ({ experimentId: experiment.id, ...p })),
      conditions: 'Observed finite development suite; association only. Multiple edits do not establish attribution.',
      unresolved: 'Isolate each useful component and replicate on matched trials.' });
  }
  for (const text of experiment.findings ?? []) lessons.push({ claim: text, status: 'hypothesis', supporting: [], contradicting: [], conditions: 'Unverified model interpretation' });
  const priorRecords = learningIndex(controller, state);
  for (const lesson of lessons.filter(l => l.id)) {
    const prior = priorRecords.flatMap(r => r.lessons.map(l => ({ ...l, experimentRecord: r.id }))).filter(l => l.id === lesson.id).sort((a, b) => a.revision - b.revision).at(-1);
    lesson.previousRevision = prior?.revision ?? null;
    lesson.previousEvidenceRecord = prior?.experimentRecord ?? null;
    lesson.revision = (prior?.revision ?? 0) + 1;
    if (prior) {
      lesson.supporting = [...prior.supporting, ...lesson.supporting];
      lesson.contradicting = [...prior.contradicting, ...lesson.contradicting];
      if (lesson.supporting.length && lesson.contradicting.length) lesson.status = 'mixed evidence';
    }
  }
  const value = { id: `${state.id}:${recordName}`, goalId: state.id, candidateId: experiment.id, split: 'development',
    scope: learningScope(state), caseFingerprints: state.benchmark.cases.filter(c => c.split === 'development').map(caseFingerprint),
    at: new Date().toISOString(), revision, family: experiment.family, parents: experiment.parents, hypothesis: experiment.hypothesis,
    changes: experiment.changes, outcome: experiment.outcome, repetition: experiment.repetition,
    model: state.contract.worker, recipeRevision: experiment.revision, evidence, observations, lessons,
    investigations: [{ question: experiment.outcome === 'infrastructure_error' ? 'Does this candidate work when evaluator execution succeeds?' : 'Which component accounts for each improvement or regression?',
      experiment: 'Change one component relative to the recorded parent and repeat matched cases.', retryWhen: 'Material model/workload change, contradictory evidence, or an explicitly budgeted replication.' }] };
  controller.putRecord(state, recordName, value);
  for (const [index, lesson] of lessons.entries()) controller.putRecord(state, `lesson-${experiment.number}-${revision}-${index}`, { ...lesson, experiment: value.id, scope: value.scope, version: 1 });
}

// Conservative matched selection. Require repeated observations per task and
// account for dispersion before using a gain. A good mean cannot hide a loss.
export function verifiedGain(candidate, baseline, ranking) {
  if (!candidate.eligible || !candidate.comparable || !baseline.comparable) return { better: false, reason: 'Incomplete or invalid matched evidence' };
  const metrics = [ranking.primary, ...(ranking.tieBreakers ?? [])], intervals = [];
  let primaryDecision = null;
  for (const name of metrics) {
    const deltas = [];
    for (const caseId of new Set(candidate.samples.map(s => s.caseId))) {
      const matched = candidate.samples.filter(s => s.caseId === caseId).map(s => {
        const before = baseline.samples.find(b => b.caseId === caseId && b.repeat === s.repeat);
        const a = s.metrics[name], b = before?.metrics[name];
        return before && a?.value != null && b?.value != null && a.unit === b.unit && a.direction === b.direction
          ? (a.value - b.value) * (a.direction === 'higher' ? 1 : -1) : null;
      });
      if (matched.length < 2 || matched.some(x => x == null)) return { better: false, reason: 'At least two complete matched samples per task are required' };
      const mean = matched.reduce((a, b) => a + b, 0) / matched.length;
      const tolerance = ranking.tolerances?.[name] ?? (name === ranking.primary ? ranking.minImprovement ?? 0 : 0);
      if (mean < -tolerance) return { better: false, reason: `Task regression: ${caseId} / ${name}` };
      deltas.push(...matched);
    }
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((s, x) => s + (x - mean) ** 2, 0) / (deltas.length - 1);
    // 3 standard errors is a conservative screening heuristic, not a formal
    // confidence guarantee for ordinal scores or adaptively selected samples.
    const margin = 3 * Math.sqrt(variance / deltas.length);
    const tolerance = ranking.tolerances?.[name] ?? (name === ranking.primary ? ranking.minImprovement ?? 0 : 0);
    intervals.push({ metric: name, mean, margin, samples: deltas.length });
    if (primaryDecision == null && mean - margin > tolerance) primaryDecision = true;
    else if (primaryDecision == null && (mean + margin < -tolerance || margin > tolerance && Math.abs(mean) <= margin)) primaryDecision = false;
  }
  return { better: primaryDecision === true, intervals, reason: primaryDecision ? 'Repeated matched gain with no task mean regression under the configured tolerances' : 'No improvement established', uncertainty: 'Three-standard-error selection heuristic on a finite adaptive sample; no universal or formal confidence claim' };
}
