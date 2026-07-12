// Router node: plan.md -> tasks.json + retrospective.
// Splits the approved plan into self-describing tasks and assigns each a
// worker (provider+model). Tasks carry full context (goal, inputs,
// constraints, dependencies) so any model can pick one up without hidden state.
import { callModel } from '../adapters/index.js';
import { makeRetrospective } from '../retrospective.js';

export async function runRouter(store, runId, config) {
  const plan = store.readPlan(runId);
  const prompt = store.readPrompt(runId);
  const worker = config.workers.router;
  // tasks.json is persisted to runs/, so the worker assignment written there
  // must never include an injected apiKey — keys are re-resolved per provider
  // at execution time (see executor.js).
  const defaultExecutor = { provider: config.workers.executor.provider, model: config.workers.executor.model };

  store.appendLog(runId, { event: 'node_start', node: 'router', worker: { provider: worker.provider, model: worker.model } });

  const system = [
    'ROLE: router',
    'You are the routing stage of an AI orchestration pipeline.',
    'Split the approved plan into an ordered list of tasks. Respond with ONLY valid JSON, no code fences:',
    '{"tasks":[{"id":"task-1","title":"...","goal":"...","inputs":["..."],"constraints":["..."],"dependsOn":[],"worker":{"provider":"' + defaultExecutor.provider + '","model":"' + defaultExecutor.model + '"}}]}',
    'Rules: ids are task-1..task-N in execution order. Every task must be fully self-describing:',
    'goal states what to produce, inputs lists which artifacts it needs (prompt.md, plan.md, or "task-N output"),',
    'constraints lists hard requirements, dependsOn lists prerequisite task ids.',
    `Use the worker shown above for every task unless the plan clearly demands otherwise.`
  ].join('\n');

  const userMsg = `USER PROMPT:\n${prompt}\n\nAPPROVED PLAN:\n${plan}`;
  const result = await callModel({ ...worker, system, prompt: userMsg });

  const problems = [];
  let tasks;
  try {
    tasks = parseTasksJson(result.text);
  } catch (err) {
    // Adaptive fallback: derive tasks mechanically from the plan's numbered steps.
    problems.push(`Router output was not valid task JSON (${err.message}); fell back to mechanical plan split.`);
    tasks = fallbackTasksFromPlan(plan, defaultExecutor);
  }
  // Enforce the contract regardless of what the model said.
  tasks.tasks = tasks.tasks.map((t, i) => ({
    id: t.id || `task-${i + 1}`,
    title: t.title || `Task ${i + 1}`,
    goal: t.goal || t.title || '',
    inputs: t.inputs ?? ['plan.md'],
    constraints: t.constraints ?? [],
    dependsOn: t.dependsOn ?? (i > 0 ? [`task-${i}`] : []),
    worker: t.worker?.provider && t.worker?.model ? { provider: t.worker.provider, model: t.worker.model } : defaultExecutor,
    status: 'pending'
  }));
  store.writeTasks(runId, tasks);

  const retro = makeRetrospective({
    node: 'router',
    status: problems.length ? 'partial' : 'success',
    problems,
    resolution: problems.length ? 'Used mechanical fallback split; tasks still satisfy the contract.' : '',
    confidence: problems.length ? 0.5 : 0.8,
    recommendation: `Split plan into ${tasks.tasks.length} tasks.`,
    model: { provider: result.provider, model: result.model },
    usage: result.usage,
    durationMs: result.durationMs
  });
  store.writeRetrospective(runId, 'router', retro);
  return retro;
}

function parseTasksJson(text) {
  const cleaned = text.trim().replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object found');
  const obj = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) throw new Error('missing tasks array');
  return obj;
}

function fallbackTasksFromPlan(plan, worker) {
  const steps = [...plan.matchAll(/^\s*\d+\.\s+(.+)$/gm)].map(m => m[1].trim());
  const list = (steps.length ? steps : ['Execute the plan as a single task']).map((s, i) => ({
    id: `task-${i + 1}`,
    title: s.slice(0, 80),
    goal: s,
    inputs: ['prompt.md', 'plan.md', ...(i > 0 ? [`task-${i} output`] : [])],
    constraints: [],
    dependsOn: i > 0 ? [`task-${i}`] : [],
    worker
  }));
  return { tasks: list };
}
