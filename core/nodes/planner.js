// Planner node: prompt.md (+ history digest) -> plan.md + retrospective.
// Communicates only through the RunStore; never calls other nodes.
import { callModel } from '../adapters/index.js';
import { makeRetrospective } from '../retrospective.js';

export async function runPlanner(store, runId, config) {
  const prompt = store.readPrompt(runId);
  const history = store.historyDigest();
  const worker = config.workers.planner;

  // Log provider/model only — the worker object may carry an injected apiKey.
  store.appendLog(runId, { event: 'node_start', node: 'planner', worker: { provider: worker.provider, model: worker.model } });

  const system = [
    'ROLE: planner',
    'You are the planning stage of an AI orchestration pipeline.',
    'Produce a Markdown plan for the user prompt. Structure it as:',
    '# Plan\\n\\nGoal: <one line>\\n\\n## Steps\\n1. <step>\\n2. <step> ...',
    'Each step must be small, self-contained, and independently verifiable.',
    'Prefer 3-7 steps. Do not include anything except the plan.'
  ].join('\n');

  const userMsg = [
    'USER PROMPT:',
    prompt,
    history ? '\nLESSONS FROM PREVIOUS RUNS (retrospective recommendations):\n' + history : ''
  ].join('\n');

  const result = await callModel({ ...worker, system, prompt: userMsg });
  store.writePlan(runId, result.text.trim());

  const retro = makeRetrospective({
    node: 'planner',
    status: 'success',
    confidence: 0.8,
    recommendation: 'Plan produced; validate step granularity against execution outcomes.',
    model: { provider: result.provider, model: result.model },
    usage: result.usage,
    durationMs: result.durationMs
  });
  store.writeRetrospective(runId, 'planner', retro);
  return retro;
}
