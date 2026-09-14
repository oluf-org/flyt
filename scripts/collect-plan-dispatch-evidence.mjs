// Export compact, inspectable evidence from canonical app sessions. This does
// not launch work or export credentials, hidden reasoning, or unrelated runs.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs/reviews/plan-dispatch-performance');
const index = JSON.parse(fs.readFileSync(path.join(root, '.flyt/plan-dispatch-experiment.json'), 'utf8'));
const runRoot = path.join(root, '.flyt/runs');
const goalRoot = path.join(runRoot, 'goals', index.goalId);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const events = id => {
  if (!/^[\w.-]+$/.test(id)) throw new Error('Invalid session identity');
  const file = path.join(runRoot, id, 'session.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
};
const save = (file, value) => fs.writeFileSync(path.join(out, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const goal = read(path.join(goalRoot, 'state.json'));
const measurement = m => m && ({ eligible: m.eligible, comparable: m.comparable, metrics: Object.fromEntries(Object.entries(m.metrics).map(([k, v]) => [k, v.value])), counts: m.counts, firstAttemptRate: m.firstAttemptRate, reportIds: m.reportIds });
const evaluations = fs.readdirSync(goalRoot).filter(f => /^report-evaluation-/.test(f) && !f.includes('interrupted')).map(f => {
  const report = read(path.join(goalRoot, f));
  const log = events(report.runId);
  return { record: f, caseId: report.caseId, status: report.status, eligible: report.eligible, checks: report.checks,
    metrics: report.metrics, runtime: { latencyMs: report.runtime?.latencyMs, repairs: report.runtime?.repairs, fallbacks: report.runtime?.fallbacks, initialContractValid: report.runtime?.initial?.contractValid, tokens: report.runtime?.tokens },
    artifact: report.artifact, judgeEvidence: report.evaluations?.filter(e => e.evaluator === 'ai-rubric').map(e => e.evidence),
    diagnostics: log.filter(e => e.type === 'block.warning' && e.data.code === 'invalid_task_graph').flatMap(e => e.data.diagnostics ?? []) };
});
const histories = goal.history.map(h => ({ iteration: h.iteration, evaluation: measurement(h.evaluation), candidate: read(path.join(goalRoot, `${h.artifact}.json`)).candidate }));
if (goal.best) save('best-planner-prompt.txt', read(path.join(goalRoot, `${goal.best.artifact}.json`)).candidate.text);
const runs = index.runs.map(entry => {
  const log = events(entry.runId);
  const states = log.filter(e => e.type === 'block.status');
  const started = states.find(e => e.data.blockId === 'dispatch' && e.data.status === 'active');
  const ended = states.filter(e => e.data.blockId === 'dispatch' && ['done', 'failed'].includes(e.data.status)).at(-1);
  const childIds = [...new Set(log.filter(e => e.type === 'child.session').map(e => e.data.sessionId))];
  const all = [...log, ...childIds.flatMap(events)];
  const modelCalls = all.filter(e => e.type === 'llm.response').map(e => ({ at: e.at, blockId: e.data.blockId, model: e.data.route?.effective, usage: e.data.usage }));
  const modelMatches = modelCalls.length > 0 && modelCalls.every(e => e.model === `openrouter/${index.model}`);
  const children = [...new Set(states.filter(e => e.data.parentId === 'dispatch').map(e => e.data.taskId))].map(id => {
    const rows = states.filter(e => e.data.taskId === id);
    const first = rows.find(e => e.data.status === 'active'), last = rows.at(-1);
    const output = log.filter(e => e.type === 'block.output' && e.data.taskId === id).at(-1)?.data.content ?? '';
    const finishedAt = ['done', 'failed', 'blocked'].includes(last.data.status) ? last.at : null;
    return { id, status: last.data.status, startedAt: first?.at, finishedAt, durationMs: first && finishedAt ? Date.parse(finishedAt) - Date.parse(first.at) : null,
      dependsOn: last.data.dependsOn ?? [], words: output.trim() ? output.trim().split(/\s+/).length : 0, output };
  });
  const points = children.flatMap(c => c.startedAt ? [{ at: c.startedAt, delta: 1 }, ...(c.finishedAt ? [{ at: c.finishedAt, delta: -1 }] : [])] : []).sort((a, b) => a.at.localeCompare(b.at) || a.delta - b.delta);
  let active = 0, peak = 0; for (const p of points) { active += p.delta; peak = Math.max(peak, active); }
  const output = log.filter(e => e.type === 'block.output' && e.data.blockId === 'dispatch' && !e.data.port).at(-1)?.data.content ?? '';
  const checks = entry.label.includes('heldout') ? {
    panels: /12/.test(output) && /(?:7\s*\+\s*5|east|west)/i.test(output), reduction: /25\s*%/.test(output),
    uncertainty: /sample|statistic|significan|limitation/i.test(output), inspectionDay5: /(?:inspect[^\n]{0,45}day\s*5|day\s*5[^\n]{0,45}inspect)/i.test(output),
    completionByDay6: /(?:day\s*6|sixth day)/i.test(output),
  } : entry.label.includes('mixed') ? {
    sum: /31/.test(children.find(c => c.id === 'sum')?.output ?? ''), double: /62/.test(children.find(c => c.id === 'double')?.output ?? ''),
    range: /0/.test(children.find(c => c.id === 'range')?.output ?? '') && /9/.test(children.find(c => c.id === 'range')?.output ?? ''),
    twelveConcernCoverage: ['corrupt', 'unknown', 'interrupt', 'backup', 'cache', 'retry', 'timeout', 'disk', 'encoding', 'zero', 'empty', 'version'].every(s => (children.find(c => c.id === 'audit')?.output ?? '').toLowerCase().includes(s)),
  } : { total: /20/.test(output) && /pears/i.test(output), reduction: /37\.5/.test(output), uncertainty: /significan|sample|statistic/i.test(output), qaDay4: /(?:QA[^\n]{0,40}day\s*4|day\s*4[^\n]{0,40}QA)/i.test(output), releaseDay5: /(?:release[^\n]{0,40}day\s*5|day\s*5[^\n]{0,40}release)/i.test(output), rollback: /rollback/i.test(output) };
  const exclusion = !modelMatches ? 'Requested GLM route not observed for every planner/worker response'
    : !ended ? 'Run is still in progress'
      : ended.data.status !== 'done' ? 'Failed run; retained for failure review, excluded from successful timing comparison' : null;
  const row = { ...entry, status: ended?.data.status ?? 'running', modelVerified: modelMatches, included: exclusion === null, exclusion,
    durationMs: started && ended ? Date.parse(ended.at) - Date.parse(started.at) : null, peakWorkers: peak, children, checks, output,
    modelCalls, toolResults: all.filter(e => e.type === 'tool.result').length, repairs: log.filter(e => e.type === 'block.warning' && e.data.code === 'invalid_task_graph').length,
    knownUsd: modelCalls.reduce((n, c) => n + (c.usage?.costUsd ?? 0), 0) };
  save(`${entry.label}-output.md`, output || `Run status: ${row.status}. ${ended?.data.error ?? ''}`);
  return row;
});
const report = { model: index.model, goalId: index.goalId, draftId: index.draftId, generatedAt: new Date().toISOString(),
  goal: { status: goal.status, reason: goal.reason, iteration: goal.iteration, calls: goal.calls, knownUsd: goal.knownUsd, limits: goal.contract.limits,
    baseline: measurement(goal.baseline), best: goal.best && { iteration: goal.best.iteration, ...measurement(goal.best.evaluation) }, histories }, evaluations, runs };
save('evidence.json', report);
console.log(JSON.stringify({ goal: report.goal, runs: runs.map(({ modelCalls, children, output, ...r }) => r) }, null, 2));
