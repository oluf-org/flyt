// Executor node: runs ONE task from tasks.json -> tasks/<id>.md + per-task
// retrospective. Sequential orchestration lives in pipeline.js; this module
// only knows how to execute a single self-describing task from file state.
import { callModel } from '../adapters/index.js';
import { makeRetrospective } from '../retrospective.js';

export async function runExecutorTask(store, runId, taskId, config = {}) {
  const tasksDoc = store.readTasks(runId);
  const task = tasksDoc.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found in tasks.json`);

  // tasks.json never stores API keys; resolve the key for this task's
  // provider from the runtime config at call time.
  const apiKey = config.providerKeys?.[task.worker.provider];

  store.appendLog(runId, { event: 'node_start', node: `executor:${taskId}`, worker: task.worker });

  // Assemble the task's full context from files — no hidden state.
  const contextParts = [];
  for (const input of task.inputs) {
    if (input === 'prompt.md') contextParts.push(`--- prompt.md ---\n${store.readPrompt(runId)}`);
    else if (input === 'plan.md') contextParts.push(`--- plan.md ---\n${store.readPlan(runId)}`);
    else {
      const m = input.match(/task-\d+/);
      const out = m ? store.readTaskOutput(runId, m[0]) : null;
      if (out) contextParts.push(`--- ${m[0]} output ---\n${out}`);
    }
  }

  const system = [
    'ROLE: executor',
    'You are an execution worker in an AI orchestration pipeline.',
    'Complete exactly the task described. Produce the deliverable as Markdown.',
    'Do not do work belonging to other tasks. Respect every constraint.'
  ].join('\n');

  const userMsg = [
    `USER PROMPT:\n${store.readPrompt(runId)}`,
    `TASK: ${task.title}`,
    `GOAL: ${task.goal}`,
    task.constraints.length ? `CONSTRAINTS:\n- ${task.constraints.join('\n- ')}` : '',
    contextParts.length ? `CONTEXT:\n${contextParts.join('\n\n')}` : ''
  ].filter(Boolean).join('\n\n');

  let retro;
  try {
    const result = await callModel({ ...task.worker, apiKey, system, prompt: userMsg });
    store.writeTaskOutput(runId, taskId, result.text.trim());
    task.status = 'done';
    retro = makeRetrospective({
      node: `executor:${taskId}`,
      status: 'success',
      confidence: 0.75,
      recommendation: `Task "${task.title}" completed by ${task.worker.provider}/${task.worker.model}.`,
      model: task.worker,
      usage: result.usage,
      durationMs: result.durationMs
    });
  } catch (err) {
    task.status = 'failed';
    retro = makeRetrospective({
      node: `executor:${taskId}`,
      status: 'failed',
      problems: [String(err.message ?? err)],
      resolution: 'Task marked failed; pipeline escalates to human.',
      confidence: 0,
      recommendation: `Task "${task.title}" failed — inspect log.jsonl and retry with a different worker.`,
      model: task.worker
    });
  }
  store.writeTasks(runId, tasksDoc); // persist status change
  store.writeRetrospective(runId, `executor-${taskId}`, retro);
  return retro;
}
