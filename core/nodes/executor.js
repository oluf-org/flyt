// Executor node: runs ONE task from tasks.json -> tasks/<id>.md + per-task
// retrospective. Sequential orchestration lives in pipeline.js; this module
// only knows how to execute a single self-describing task from file state.
import { runAgent } from '../agent.js';
import { getTools } from '../tools/index.js';
import { makeRetrospective } from '../retrospective.js';
import { Workspace } from '../workspace.js';
import { loadSkills, withSkillsSection } from '../skills.js';

// onText (optional): the caller's streaming sink for partial model output (V1
// task 8). Forwarded to the agent loop untouched — where the partial text is
// written, and how often, is the caller's business, not this module's.
export async function runExecutorTask(store, runId, taskId, config = {}, { approveToolCall = null, ledger = null, onText = null } = {}) {
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
      // Not a task reference: flow runs may name an upstream flow-node id
      // whose output lives in nodes/<id>.md, or a contextSpec file in the
      // run's workspace/.
      let out = m ? store.readTaskOutput(runId, m[0]) : store.readNodeOutput?.(runId, input);
      if (out == null && !m) {
        try { out = store.readWorkspaceFile?.(runId, input); } catch { /* escapes workspace */ }
      }
      if (out != null) contextParts.push(`--- ${m ? m[0] + ' output' : input} ---\n${out}`);
      else {
        contextParts.push(`--- ${input} ---\n[NOT FOUND: this declared input does not exist in the run yet. State any assumptions you make.]`);
        store.appendLog(runId, { event: 'context_input_missing', node: `executor:${taskId}`, input });
      }
    }
  }

  // Toolset: everything in the registry unless the task names a subset
  // (task.tools: string[]). The agent loop picks native vs text protocol
  // per worker capability.
  const tools = getTools(task.tools);
  // Bind the run's target workspace (V1 task 1) so file tools act on the real
  // project. A missing/moved folder degrades gracefully: the file tools fall
  // back to the run's own workspace sandbox instead of failing the task.
  let workspace = null;
  const wsPath = store.readMeta(runId)?.workspace;
  if (wsPath) {
    try { workspace = new Workspace(wsPath); }
    catch (err) { store.appendLog(runId, { event: 'workspace_unavailable', path: wsPath, error: String(err?.message ?? err) }); }
  }
  const ctx = {
    store, runId, taskId, workspace,
    // Present only when the node opted into per-tool approval: the agent loop
    // calls it before each destructive tool call (V1 task 4).
    approveToolCall,
    // Present when this task is part of a parallel batch: file tools use it to
    // flag a write to a path another in-flight task also wrote (V1 task 6).
    ledger,
    defaultWorker: {
      provider: config.workers?.executor?.provider ?? task.worker.provider,
      model: config.workers?.executor?.model ?? task.worker.model
    }
  };
  const worker = { ...task.worker };
  if (worker.provider === 'openrouter') {
    worker.supportsTools = Boolean(config.modelCapabilities?.[worker.model]);
  }

  // Skills the task carries (from its node's template) resolved against the
  // bound project's .llmflow/skills/ (V1 task 10). Logged either way, so an
  // attached-but-absent skill is distinguishable in the audit log from one
  // that applied — a skill that silently did nothing was the original bug.
  const { found: skills, missing: missingSkills } = loadSkills(workspace, task.skills);
  if (skills.length) {
    store.appendLog(runId, { event: 'skills_injected', node: `executor:${taskId}`, skills: skills.map(s => s.name) });
  }
  for (const m of missingSkills) {
    store.appendLog(runId, { event: 'skill_missing', node: `executor:${taskId}`, skill: m.name, reason: m.reason });
  }

  const system = withSkillsSection([
    'ROLE: executor',
    'You are an execution worker in an AI orchestration pipeline.',
    'Complete exactly the task described. Produce the deliverable as Markdown.',
    'Do not do work belonging to other tasks. Respect every constraint.',
    tools.length ? 'You have tools to write files, spawn follow-up tasks, and record a task spec — use them when they help the task.' : ''
  ].filter(Boolean).join('\n'), skills);

  const userMsg = [
    `USER PROMPT:\n${store.readPrompt(runId)}`,
    `TASK: ${task.title}`,
    `GOAL: ${task.goal}`,
    task.constraints.length ? `CONSTRAINTS:\n- ${task.constraints.join('\n- ')}` : '',
    contextParts.length ? `CONTEXT:\n${contextParts.join('\n\n')}` : ''
  ].filter(Boolean).join('\n\n');

  let retro;
  let status;
  try {
    const result = await runAgent({ worker, apiKey, system, prompt: userMsg, tools, ctx, onText });
    // Authoritative write: onText may have left the last turn's partial text
    // (or a tool block) in this file, and this is what replaces it.
    store.writeTaskOutput(runId, taskId, result.text.trim());
    status = 'done';
    const failedCalls = result.toolCalls.filter(c => !c.ok);
    retro = makeRetrospective({
      node: `executor:${taskId}`,
      status: 'success',
      problems: failedCalls.map(c => `Tool call ${c.tool} failed: ${c.error}`),
      resolution: failedCalls.length ? 'Errors were fed back to the model for self-correction.' : '',
      confidence: 0.75,
      recommendation: `Task "${task.title}" completed by ${task.worker.provider}/${task.worker.model}${result.toolCalls.length ? ` using ${result.toolCalls.length} tool call(s)` : ''}.`,
      model: task.worker,
      usage: result.usage,
      durationMs: result.durationMs,
      toolCalls: result.toolCalls
    });
  } catch (err) {
    status = 'failed';
    const aborted = Boolean(err?.toolRejected);
    retro = makeRetrospective({
      node: `executor:${taskId}`,
      status: 'failed',
      problems: [String(err.message ?? err)],
      resolution: aborted
        ? 'A tool call was rejected at the approval gate; task aborted by the human.'
        : 'Task marked failed; pipeline escalates to human.',
      confidence: 0,
      recommendation: aborted
        ? `Task "${task.title}" was aborted — a destructive tool call was rejected at the approval gate.`
        : `Task "${task.title}" failed — inspect log.jsonl and retry with a different worker.`,
      model: task.worker
    });
    // Flag human rejections so the runner keeps the "rejected" stage the tool
    // gate set, rather than overwriting it with a generic "failed".
    if (aborted) retro.aborted = true;
  }
  // Persist the status change against a FRESH read of tasks.json: a
  // create_task tool call during this run may have appended tasks that the
  // doc read at the top of this function doesn't contain.
  const freshDoc = store.readTasks(runId);
  const freshTask = freshDoc.tasks.find(t => t.id === taskId);
  if (freshTask) freshTask.status = status;
  store.writeTasks(runId, freshDoc);
  task.status = status; // keep the in-memory copy consistent for callers
  store.writeRetrospective(runId, `executor-${taskId}`, retro);
  return retro;
}
