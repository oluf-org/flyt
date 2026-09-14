import fs from 'node:fs';
import { parseGoalReply } from './goalController.js';
import { aggregate, digest, rank, targetMet } from './evaluation.js';
import { campaignPhase, campaignForecast, initialCampaignState } from './campaignPolicy.js';
import { candidateDigest, caseFingerprint, recordLearning, retrieveLearning, verifiedGain, exposedFinalCases } from './goalLearning.js';

const read = (controller, state, name) => JSON.parse(fs.readFileSync(controller.recordPath(state, name), 'utf8'));
const exists = (controller, state, name) => fs.existsSync(controller.recordPath(state, name));
const projection = evaluation => {
  if (!evaluation) return null;
  const { samples, feedback, reportIds, ...rest } = evaluation;
  return { ...rest, feedback: feedback?.slice(0, 3), reportIds: reportIds?.slice(0, 12), totalReports: reportIds?.length ?? 0 };
};
const summary = (experiment, evaluation) => ({ iteration: experiment.number, revision: experiment.revision, artifact: `iteration-${experiment.number}`,
  runId: experiment.runId, preview: experiment.candidate.text.slice(0, 500), candidateId: experiment.id, family: experiment.family,
  evaluation: projection(evaluation), eligible: Boolean(evaluation?.eligible), verified: false, score: null, outcome: experiment.outcome, findings: experiment.findings ?? [] });
const promptFields = /^(systemPrompt|instructions|workerSystemPrompt|workerInstructions)$/;
const settingFields = /^(maxTasks|minTasks|parallelism|maxParallel|maxTokens|maxOutputWords|workerMaxSteps|workerMaxTokens|workerMaxOutputWords|workerMaxInputTokens|effort)$/;
function meaningfulDiff(before = '', after = '') {
  before ??= ''; after ??= '';
  let first = 0, tail = 0;
  while (first < before.length && first < after.length && before[first] === after[first]) first++;
  while (tail < before.length - first && tail < after.length - first && before[before.length - tail - 1] === after[after.length - tail - 1]) tail++;
  const removed = before.slice(first, before.length - tail), added = after.slice(first, after.length - tail);
  return { offset: first, removed: removed.slice(0, 2000), added: added.slice(0, 2000), truncated: removed.length > 2000 || added.length > 2000 };
}
function retainTradeoffs(population, item, ranking) {
  const family = [...population.filter(x => x.family === item.family), item];
  const names = [...new Set([ranking.primary, ...(ranking.tieBreakers ?? []), ...Object.keys(item.evaluation.metrics).filter(x => /\.(knownUsd|latencyMs|tokens)$/.test(x))])];
  const dominates = (a, b) => {
    const deltas = names.map(name => { const x = a.evaluation.metrics[name], y = b.evaluation.metrics[name]; return x?.value != null && y?.value != null && x.unit === y.unit && x.direction === y.direction ? (x.value - y.value) * (x.direction === 'higher' ? 1 : -1) : null; }).filter(x => x != null);
    return deltas.length && deltas.every(d => d >= 0) && deltas.some(d => d > 0);
  };
  const unique = family.filter((x, index) => family.findIndex(y => names.every(name => y.evaluation.metrics[name]?.value === x.evaluation.metrics[name]?.value)) === index);
  const survivors = unique.filter(x => !unique.some(y => x !== y && dominates(y, x)))
    .sort((a, b) => rank(a.evaluation, b.evaluation, ranking) ? -1 : rank(b.evaluation, a.evaluation, ranking) ? 1 : a.iteration - b.iteration).slice(0, 3);
  return [...population.filter(x => x.family !== item.family), ...survivors];
}

export async function checkSearchSpace(controller, state, candidate) {
  if (candidate.text.length > 24000) throw new Error('Candidate text exceeds 24,000 characters');
  const p = state.contract.campaign, e = state.contract.evaluation;
  if (e.target !== 'workflow') {
    if (candidate.source != null) throw new Error('Workflow source is outside this prompt search space');
    return;
  }
  const next = await controller.validateSource(candidate.source, state.contract);
  const baseline = await controller.validateSource(e.baseline.source, state.contract);
  const scrub = node => {
    const copy = structuredClone(node);
    if (copy.config) for (const key of Object.keys(copy.config)) {
      if (p.allowedChanges.includes('prompt') && promptFields.test(key) || p.allowedChanges.includes('settings') && settingFields.test(key)) delete copy.config[key];
    }
    copy.children = copy.children?.map(scrub); copy.else = copy.else?.map(scrub);
    return copy;
  };
  if (!p.allowedChanges.includes('structure') && digest(scrub(next.root)) !== digest(scrub(baseline.root))) throw new Error('Candidate changes fixed workflow structure or settings outside the permitted search space');
  if (p.allowedChanges.includes('structure')) {
    const prior = new Map();
    const visit = (node, fn) => { fn(node); node.children?.forEach(n => visit(n, fn)); node.else?.forEach(n => visit(n, fn)); };
    visit(baseline.root, n => { if (n.kind === 'block') prior.set(n.id, n); });
    visit(next.root, n => {
      if (n.kind !== 'block') return;
      const previous = prior.get(n.id)?.config ?? {};
      for (const key of new Set([...Object.keys(n.config ?? {}), ...Object.keys(previous)])) {
        const allowed = p.allowedChanges.includes('prompt') && promptFields.test(key) || p.allowedChanges.includes('settings') && settingFields.test(key);
        if (!allowed && digest(n.config?.[key] ?? null) !== digest(previous[key] ?? null)) throw new Error(`Fixed setting ${key} changed outside the permitted search space`);
      }
    });
  }
}

export function campaignPacket(controller, state) {
  const p = state.contract.campaign, c = state.campaign;
  const family = c.assignment?.family ?? p.families[c.candidateCount % p.families.length];
  const learning = retrieveLearning(controller, state, '', 4);
  return { completion: p.mode, phase: c.phase, distinctCandidates: c.candidateCount, maximum: p.maxCandidates,
    family, parentIds: c.assignment?.parents ?? ['baseline'], allowedChanges: p.allowedChanges,
    population: c.population.map(x => ({ id: x.candidateId, family: x.family, artifact: x.artifact, preview: x.preview.slice(0, 240) })).slice(0, 10),
    learning, instructions: 'Propose one materially different experiment in the assigned family. Use goal_history with candidateId and part:text|source to read complete parent artifacts in 8,000-character pages (follow nextOffset), or reportId to retrieve development diagnostics. Retrieve both successes and failures. Explain a predicted effect; model claims remain hypotheses. Preserve every fixed boundary.',
    experimentContract: { parents: ['known candidate IDs'], family, editType: 'controlled-edit | combination | redesign', hypothesis: 'predicted effect and why',
      informedBy: learning.map(x => x.id), repetition: { kind: 'replication or retest, only when intentional', reason: 'required for an exact repeat' } } };
}

function fixedChecks(controller, state, candidate) {
  return state.contract.criteria.map((criterion, index) => {
    // Campaigns are tool-free and evaluate immutable outputs. File acceptance
    // is handled by the isolated typed evaluator, not the optimizer workspace.
    if (criterion.type !== 'output_contains') throw new Error('Campaign file checks belong in the fixed evaluation suite');
    return { index, passed: candidate.text.includes(criterion.value) };
  });
}
function mergeMeasurements(controller, state, chunks) {
  const reports = chunks.flatMap(m => m.reportIds.map(id => read(controller, state, id)));
  return { ...aggregate(reports), benchmarkVersion: chunks[0]?.benchmarkVersion, reportIds: chunks.flatMap(m => m.reportIds),
    samples: chunks.flatMap(m => m.samples) };
}
async function matched(controller, record, candidate, label, split) {
  const state = record.state, p = state.contract.campaign, chunks = { candidate: [], baseline: [] };
  for (const item of state.benchmark.cases.filter(c => c.split === split)) for (let repeat = 0; repeat < Math.max(item.repeats, p.confirmationRepeats); repeat++) {
    // Stable randomized presentation order survives restarts and interleaves
    // the two executions at each matched case/repetition boundary.
    const key = `${label}-${item.id}-${repeat}`;
    const order = parseInt(digest(key).slice(0, 2), 16) % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const role of order) {
      const measurement = await controller.measured(record, role === 'baseline' ? state.contract.evaluation.baseline : candidate,
        `${key}-${role}`, state.benchmark, split, { caseIds: [item.id], repeats: 1, concurrency: 1, tier: 'confirmation' });
      chunks[role].push({ ...measurement, samples: measurement.samples.map(s => ({ ...s, repeat })) });
    }
  }
  return Object.fromEntries(Object.entries(chunks).map(([role, values]) => [role, mergeMeasurements(controller, state, values)]));
}

async function confirm(controller, record, reason) {
  const state = record.state, c = state.campaign, p = state.contract.campaign, e = state.contract.evaluation;
  if (c.result) { state.status = c.result.achieved ? 'achieved' : 'completed'; state.reason = c.result.reason; controller.save(state); return; }
  c.phase = 'confirm';
  if (!c.finalists) {
    const ranked = [...c.population].sort((a, b) => rank(a.evaluation, b.evaluation, e.ranking) ? -1 : rank(b.evaluation, a.evaluation, e.ranking) ? 1 : a.iteration - b.iteration);
    const families = ranked.filter((x, index) => ranked.findIndex(y => y.family === x.family) === index);
    c.finalists = [...families, ...ranked.filter(x => !families.includes(x))].slice(0, Math.min(p.finalists, state.benchmark.cases.some(x => x.split === 'validation') ? p.validationQueries : p.finalists)).map(x => x.candidateId);
    c.stopReason = reason;
    controller.putRecord(state, 'campaign-shortlist', { candidateIds: c.finalists, reason }); controller.save(state);
  }
  let winner = null;
  for (const candidateId of c.finalists) {
    const candidateSummary = c.population.find(x => x.candidateId === candidateId);
    const experiment = read(controller, state, candidateSummary.artifact);
    const split = state.benchmark.cases.some(x => x.split === 'validation') ? 'validation' : 'development';
    const key = `campaign-confirm-${experiment.number}`;
    let result;
    if (exists(controller, state, key)) result = read(controller, state, key);
    else {
      c.validationUsed ??= [];
      if (split === 'validation' && !c.validationUsed.includes(candidateId)) {
        if (c.validationUsed.length >= p.validationQueries) break;
        c.validationUsed.push(candidateId); controller.save(state);
      }
      const measurements = await matched(controller, record, experiment.candidate, `matched-${experiment.number}`, split);
      const decision = verifiedGain(measurements.candidate, measurements.baseline, e.ranking);
      result = controller.putRecord(state, key, { ...measurements, decision, candidateId, split });
    }
    if (result.decision.better && targetMet(result.candidate, e) && (!winner || rank(result.candidate, winner.result.candidate, e.ranking))) winner = { experiment, summary: candidateSummary, result };
  }
  let final = null, achieved = Boolean(winner);
  if (winner && e.finalVerification.required) {
    const priorUse = controller.list(state.projectId).some(other => other.id !== state.id
      && other.contract.evaluation?.suite.cases.some(item => (item.split === 'held-out' && other.holdout?.usedBy != null || item.split === 'validation' && other.campaign?.validationUsed?.length)
        && state.benchmark.cases.some(c => c.split === 'held-out' && caseFingerprint(c) === caseFingerprint(item))));
    if (exposedFinalCases(controller, state) || priorUse) {
      final = { eligible: false, reason: 'Final cases have prior campaign exposure. A fresh independent final test is required.' }; achieved = false;
    } else {
      const frozen = controller.putRecord(state, 'campaign-frozen', { candidate: winner.experiment.candidate, candidateId: winner.experiment.id, digest: candidateDigest(winner.experiment.candidate) });
      if (frozen.candidateId !== winner.experiment.id) throw new Error('Frozen finalist identity changed');
      c.frozen = frozen.candidateId; state.holdout.usedBy = winner.experiment.number; controller.save(state);
      final = await controller.measured(record, frozen.candidate, 'reserved-final', state.benchmark, 'held-out', { tier: 'final', minimumRepeats: p.confirmationRepeats });
      achieved = targetMet(final, e);
    }
  }
  const result = { achieved, outcome: achieved ? 'verified_improvement' : winner ? 'final_test_failed' : 'no_improvement',
    reason: achieved ? 'Matched confirmation established improvement; configured final checks passed.' : winner ? 'The frozen finalist did not pass independent final verification; baseline retained.' : 'No improvement established; baseline retained.',
    candidate: achieved ? winner.experiment.candidate : e.baseline, selected: achieved ? winner.experiment.id : 'baseline',
    confirmation: winner ? `campaign-confirm-${winner.experiment.number}` : null, finalVerification: final, stopReason: c.stopReason };
  controller.putRecord(state, 'campaign-result', result); c.result = result;
  if (achieved) state.best = { ...winner.summary, verified: true, finalVerification: final };
  else state.best = c.baselineSummary;
  state.status = achieved ? 'achieved' : 'completed'; state.reason = result.reason;
  if (state.contract.reviewResults) {
    state.pendingResult = { artifact: 'campaign-result', digest: digest(result), iteration: state.iteration, revision: state.activeRevision };
    state.status = 'paused'; state.reason = 'Waiting for human result review';
  }
  controller.save(state);
}

export async function driveCampaign(controller, record) {
  const state = record.state, p = state.contract.campaign, e = state.contract.evaluation;
  state.campaign ??= initialCampaignState();
  const c = state.campaign;
  c.baselineSummary ??= { iteration: 0, artifact: 'candidate-baseline', preview: e.baseline.text.slice(0, 500), candidateId: 'baseline', evaluation: null, eligible: false, verified: false, score: null };
  controller.putRecord(state, 'candidate-baseline', { candidate: e.baseline, digest: candidateDigest(e.baseline) });
  const development = state.benchmark.cases.filter(x => x.split === 'development');
  const screenOptions = { caseIds: development.slice(0, p.screenCases).map(x => x.id), repeats: 1, tier: 'screen' };
  if (!c.baselineReady) {
    c.screenBaseline = await controller.measured(record, e.baseline, 'baseline-screen', state.benchmark, 'development', screenOptions);
    state.baseline = await controller.measured(record, e.baseline, 'baseline'); state.baselines = [state.baseline];
    c.baselineSummary = { iteration: 0, artifact: 'candidate-baseline', preview: e.baseline.text.slice(0, 500), candidateId: 'baseline', evaluation: state.baseline, eligible: state.baseline.eligible, verified: false, score: null };
    c.baselineReady = true;
    state.best = c.baselineSummary;
    const reports = c.screenBaseline.reportIds.map(id => read(controller, state, id));
    const perTrial = field => reports.every(r => r.runtime?.[field] != null) ? reports.reduce((n, r) => n + r.runtime[field], 0) / reports.length : null;
    const pilot = { callsPerTrial: reports.reduce((n, r) => n + (r.execution.modelCalls ?? 0) + (e.target === 'workflow' ? r.runtime?.modelCalls ?? 0 : 0), 0) / reports.length,
      usdPerTrial: reports.every(r => !r.execution.unknownUsage?.length) && perTrial('knownUsd') != null ? reports.reduce((n, r) => n + (r.execution.knownUsd ?? 0) + (e.target === 'workflow' ? r.runtime.knownUsd : 0), 0) / reports.length : null,
      tokensPerTrial: perTrial('tokens'), msPerTrial: perTrial('latencyMs') };
    c.forecast = campaignForecast({ ...state.contract, campaign: p }, pilot);
    controller.putRecord(state, 'campaign-pilot', { observations: c.screenBaseline.reportIds, pilot, forecast: c.forecast }); controller.save(state);
  }
  if (c.phase === 'confirm') return confirm(controller, record, c.stopReason);
  while (state.iteration < state.contract.limits.iterations && c.candidateCount < p.maxCandidates) {
    if (state.calls >= state.contract.limits.calls - p.reserveCalls || state.contract.limits.usd != null && state.knownUsd + (state.reservedUsd ?? 0) + p.estimatedCallUsd >= state.contract.limits.usd - p.reserveUsd) break;
    controller.check(record);
    if (state.pendingProposal) {
      if (state.contract.reviewAi) { await controller.queueReview?.(state, state.pendingProposal); state.pendingProposal = null; state.status = 'paused'; state.reason = 'Waiting for recipe review'; controller.save(state); return; }
      try { await controller.editSource({ ...state.pendingProposal, projectId: state.projectId, goalId: state.id, author: 'model' }); }
      catch (error) { state.lastRevisionError = error.message; state.pendingProposal = null; }
    }
    if (state.pendingRevision && !state.iterationIntent) { state.activeRevision = state.pendingRevision; state.pendingRevision = null; }
    if (state.contract.reviewAi && !state.iterationIntent && controller.hasPendingReview?.(state)) { state.status = 'paused'; state.reason = 'Waiting for draft review'; controller.save(state); return; }
    const number = state.iteration + 1;
    c.phase = campaignPhase(c.candidateCount, p.maxCandidates);
    const family = [...p.families].sort((a, b) => (c.families[a]?.attempts ?? 0) - (c.families[b]?.attempts ?? 0))[0];
    const parent = c.population.find(x => x.family === family)?.candidateId ?? 'baseline';
    c.assignment = { family, parents: [parent] };
    state.iterationIntent ??= { number, revision: state.activeRevision, phase: `iteration-${number}` }; controller.save(state);
    let experiment, evaluation = null;
    if (exists(controller, state, `iteration-${number}`)) {
      experiment = read(controller, state, `iteration-${number}`); evaluation = experiment.evaluation;
    } else {
      const recipe = read(controller, state, `recipe-${state.iterationIntent.revision}`);
      const child = await controller.once(record, state.iterationIntent.phase, recipe.source, state.contract.objective);
      const envelope = parseGoalReply(child.output) ?? await controller.repairResult(record, child);
      if (!envelope?.candidate || typeof envelope.candidate.text !== 'string') throw new Error('Recipe must return candidate.text in a JSON object');
      const candidate = { text: envelope.candidate.text, source: envelope.candidate.source ?? null };
      const info = envelope.experiment ?? {}, fingerprint = candidateDigest(candidate);
      const knownParents = new Set(['baseline', ...state.history.map(x => x.candidateId)]);
      const parents = Array.isArray(info.parents) && info.parents.length <= 4 && info.parents.every(x => knownParents.has(x)) ? info.parents : [parent];
      const parentArtifact = parents[0] === 'baseline' ? e.baseline : read(controller, state, state.history.find(x => x.candidateId === parents[0]).artifact).candidate;
      const changed = ['text', 'source'].filter(key => (candidate[key] ?? null) !== (parentArtifact[key] ?? null));
      const duplicateOf = c.seen[fingerprint] ?? (fingerprint === candidateDigest(e.baseline) ? 'baseline' : null);
      const repeat = info.repetition;
      const deliberate = duplicateOf && ['replication', 'retest'].includes(repeat?.kind) && typeof repeat.reason === 'string' && repeat.reason.trim().length >= 10 && c.retestsUsed < p.retests;
      experiment = { id: `candidate-${number}`, number, revision: state.iterationIntent.revision, runId: child.runId, candidate, digest: fingerprint,
        family, parents, editType: ['controlled-edit', 'combination', 'redesign'].includes(info.editType) ? info.editType : 'redesign',
        hypothesis: String(info.hypothesis ?? '').slice(0, 1000),
        informedBy: retrieveLearning(controller, state, '', 4).map(x => x.id).filter(x => info.informedBy?.includes(x)),
        changes: { fields: changed, parentDigest: candidateDigest(parentArtifact), candidateDigest: fingerprint, textLengthDelta: candidate.text.length - parentArtifact.text.length,
          text: meaningfulDiff(parentArtifact.text, candidate.text), ...(candidate.source ? { source: meaningfulDiff(parentArtifact.source, candidate.source) } : {}) },
        repetition: duplicateOf ? { kind: deliberate ? repeat.kind : 'accidental_duplicate', reason: deliberate ? repeat.reason.slice(0, 1000) : 'Exact candidate already measured; evaluation skipped', duplicateOf } : { kind: 'distinct' },
        outcome: 'proposed', findings: Array.isArray(envelope.findings) ? envelope.findings.filter(x => typeof x === 'string').slice(0, 4).map(x => x.slice(0, 500)) : [],
        proposal: envelope.proposal ?? null, checks: [], tests: [], achieved: false };
      controller.putRecord(state, `experiment-${number}`, experiment);
      try {
        if (experiment.hypothesis.trim().length < 10) throw new Error('Each experiment requires a hypothesis describing its predicted effect');
        if (info.family != null && info.family !== family) throw new Error('Experiment must use the controller-assigned strategy family');
        if (info.parents != null && (!Array.isArray(info.parents) || !info.parents.length || info.parents.length > 4 || info.parents.some(x => !knownParents.has(x)))) throw new Error('Experiment parents must name recorded candidates');
        await checkSearchSpace(controller, state, candidate);
        experiment.checks = fixedChecks(controller, state, candidate);
        if (duplicateOf && !deliberate) experiment.outcome = 'duplicate';
        else if (experiment.checks.some(x => !x.passed)) experiment.outcome = 'candidate_failed';
        else {
          evaluation = await controller.measured(record, candidate, `screen-${number}`, state.benchmark, 'development', screenOptions);
          experiment.screen = evaluation;
          const familyState = c.families[family];
          const qualifies = evaluation.eligible && evaluation.comparable && (!familyState?.bestScreen || rank(evaluation, familyState.bestScreen, e.ranking));
          // Unused allocations roll forward, protecting deep trials for later
          // refinement and challenge instead of spending them all on discovery.
          const phaseBudget = Math.ceil(p.survivors * (c.phase === 'explore' ? 0.3 : c.phase === 'refine' ? 0.8 : 1));
          if (qualifies && c.promoted < phaseBudget && (familyState?.promoted ?? 0) < Math.ceil(p.survivors / p.families.length)) {
            evaluation = await controller.measured(record, candidate, `development-${number}`);
            experiment.promoted = true;
          }
          experiment.outcome = evaluation.counts.errors ? 'infrastructure_error' : !evaluation.eligible ? 'candidate_failed' : experiment.promoted ? 'evaluated' : 'screened';
        }
      } catch (error) {
        if (record.requested || record.abort.signal.aborted || ['goal_limit', 'goal_control', 'goal_cleanup_pending', 'campaign_pricing', 'campaign_reserve'].includes(error.code)) throw error;
        experiment.outcome = 'invalid_candidate'; experiment.error = String(error.message).slice(0, 1600);
      }
      experiment = controller.putRecord(state, `iteration-${number}`, { ...experiment, evaluation, calls: state.calls, knownUsd: state.knownUsd });
    }
    const parentSummary = state.history.find(x => x.candidateId === experiment.parents[0]);
    const prior = experiment.parents[0] === 'baseline' ? state.baseline : parentSummary ? read(controller, state, parentSummary.artifact).evaluation : null;
    recordLearning(controller, state, experiment, evaluation, prior);
    const item = summary(experiment, evaluation);
    if (!c.seen[experiment.digest] && experiment.repetition.kind === 'distinct') { c.candidateCount++; c.seen[experiment.digest] = experiment.id; }
    if (['retest', 'replication'].includes(experiment.repetition.kind)) c.retestsUsed++;
    const familyState = c.families[experiment.family] ??= { attempts: 0, promoted: 0 }; familyState.attempts++;
    if (experiment.promoted) {
      c.promoted++; familyState.promoted++;
      if (evaluation.eligible && evaluation.comparable) {
        c.population = retainTradeoffs(c.population, item, e.ranking);
      }
    }
    if (experiment.promoted && experiment.screen?.eligible && experiment.screen.comparable && (!familyState.bestScreen || rank(experiment.screen, familyState.bestScreen, e.ranking))) familyState.bestScreen = projection(experiment.screen);
    const improved = experiment.promoted && rank(evaluation, state.best?.evaluation, e.ranking);
    if (improved) { state.best = item; state.plateauCount = 0; }
    else if (evaluation?.comparable) state.plateauCount++;
    state.current = item; state.history.push(item); state.iteration = number; state.iterationIntent = null; state.pendingProposal = experiment.proposal;
    state.memory = retrieveLearning(controller, state, '', 4).map(x => ({ text: `${x.family}: ${x.outcome}. ${x.hypothesis}`, source: x.id, status: 'hypothesis' }));
    controller.save(state);
    if (state.contract.reviewResults) { state.pendingResult = { artifact: item.artifact, digest: digest(experiment), iteration: number, revision: experiment.revision }; state.status = 'paused'; state.reason = 'Waiting for human result review'; controller.save(state); return; }
    if (c.candidateCount >= p.minExploration && ((p.mode === 'improve' && state.best?.candidateId !== 'baseline') || c.phase === 'challenge' && state.plateauCount >= state.contract.plateau)) break;
  }
  return confirm(controller, record, state.plateauCount >= state.contract.plateau ? 'Search plateau after minimum exploration' : 'Candidate, proposal or search budget allocation reached');
}

export async function resumeCampaignConfirmation(controller, record) {
  const state = record.state;
  // An interrupted proposal is retained as abandoned evidence before the
  // protected reserve is spent. It is not misclassified as a failed direction.
  if (state.iterationIntent && exists(controller, state, `experiment-${state.iterationIntent.number}`)) {
    const experiment = read(controller, state, `experiment-${state.iterationIntent.number}`);
    recordLearning(controller, state, { ...experiment, outcome: 'budget_expired' }, null);
  }
  record.reserveHit = false; state.activeChild = null; state.iterationIntent = null;
  return confirm(controller, record, 'Search capacity exhausted; protected confirmation allocation retained');
}
