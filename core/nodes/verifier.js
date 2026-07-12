// Verifier node: plan.md + all task outputs -> verification.json (inside its
// retrospective) . Independent module; reads only file state.
import { callModel } from '../adapters/index.js';
import { makeRetrospective } from '../retrospective.js';

export async function runVerifier(store, runId, config) {
  const plan = store.readPlan(runId);
  const tasksDoc = store.readTasks(runId);
  const worker = config.workers.verifier;

  // Log provider/model only — the worker object may carry an injected apiKey.
  store.appendLog(runId, { event: 'node_start', node: 'verifier', worker: { provider: worker.provider, model: worker.model } });

  const outputs = tasksDoc.tasks.map(t =>
    `--- ${t.id}: ${t.title} (status: ${t.status}) ---\n${store.readTaskOutput(runId, t.id) ?? '(no output)'}`
  ).join('\n\n');

  const system = [
    'ROLE: verifier',
    'You are the verification stage of an AI orchestration pipeline.',
    'Check the task outputs against the plan. Respond with ONLY valid JSON, no code fences:',
    '{"verdict":"pass"|"fail","checks":[{"name":"...","result":"pass"|"fail"}],"summary":"..."}',
    'Fail if any task output is missing, contradicts the plan, or violates its constraints.'
  ].join('\n');

  const userMsg = `PLAN:\n${plan}\n\nTASK OUTPUTS:\n${outputs}`;
  const result = await callModel({ ...worker, system, prompt: userMsg });

  let verification;
  const problems = [];
  try {
    const cleaned = result.text.trim().replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '');
    verification = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
  } catch {
    problems.push('Verifier output was not valid JSON; treating as unverified.');
    verification = { verdict: 'fail', checks: [], summary: 'Verifier response unparseable: ' + result.text.slice(0, 300) };
  }
  const anyTaskFailed = tasksDoc.tasks.some(t => t.status === 'failed');
  if (anyTaskFailed) verification.verdict = 'fail';

  const retro = makeRetrospective({
    node: 'verifier',
    status: verification.verdict === 'pass' ? 'success' : 'failed',
    problems: [...problems, ...(verification.verdict === 'fail' ? [verification.summary] : [])],
    resolution: verification.verdict === 'pass' ? '' : 'Escalated to human review.',
    confidence: verification.verdict === 'pass' ? 0.8 : 0.3,
    recommendation: verification.summary,
    model: { provider: result.provider, model: result.model },
    usage: result.usage,
    durationMs: result.durationMs
  });
  retro.verification = verification; // full check detail rides along in the retro
  store.writeRetrospective(runId, 'verifier', retro);
  return retro;
}
