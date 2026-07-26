// Executor node: runs ONE task from tasks.json -> tasks/<id>.md + per-task
// retrospective. Sequential orchestration lives in pipeline.js; this module
// only knows how to execute a single self-describing task from file state.
import { runAgent, toolProtocol } from '../agent.js';
import { resolveTools } from '../tools/index.js';
import { makeRetrospective } from '../retrospective.js';
import { Workspace } from '../workspace.js';
import { loadSkills, withSkillsSection } from '../skills.js';
import { resolveCallTarget } from '../modelSource.js';

// onText (optional): the caller's streaming sink for partial model output (V1
// task 8). onRetry (optional): fires per transient-error backoff (V1 task 11).
// Both are forwarded to the agent loop untouched — what to do with them is the
// caller's business, not this module's. signal (optional, RUN-CONTROL): an
// AbortSignal the runner fires on stop(); the agent loop's model calls reject
// with an AbortError, which lands in the catch below as a STOPPED task —
// requeued to 'pending', never marked failed.
export async function runExecutorTask(store, runId, taskId, config = {}, { approveToolCall = null, ledger = null, onText = null, onRetry = null, retry = null, signal = null } = {}) {
  const tasksDoc = store.readTasks(runId);
  const task = tasksDoc.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found in tasks.json`);

  // tasks.json never stores API keys; resolve the key for this task's
  // provider from the runtime config at call time. An 'auto' provider (a task
  // created from an active-models pick) resolves through the main process's
  // resolver — priority walk, pin override, key + keyKind stamping.
  const target = resolveCallTarget(task.worker, config);
  const apiKey = target.apiKey;

  // Native tool-calling is available per MODEL, learned from the provider's
  // catalogue (settings.modelCapabilities); anything unknown falls back to the
  // text protocol, which works everywhere.
  const worker = { ...task.worker, provider: target.provider, model: target.model, ...(target.keyKind ? { keyKind: target.keyKind } : {}) };
  if (worker.provider !== 'mock' && worker.provider !== 'anthropic') {
    worker.supportsTools = Boolean(config.modelCapabilities?.[worker.model]);
  }

  // The grant, intersected with the ceiling (TOOLS-PLAN §6). Absent ceiling ⇒
  // the ceiling is the grant, and an absent grant is the whole library — the
  // pre-ceiling semantics, unchanged.
  //
  // Nothing here is fatal, and the two failure modes are deliberately
  // different: a MISSING tool degrades the node quietly (the skills rule), a
  // REFUSED one means something tried to exceed its envelope and is recorded
  // as a problem on the retrospective as well as in the log.
  const grant = resolveTools({ grant: task.tools ?? null, ceiling: task.toolCeiling ?? null });
  const tools = grant.tools;
  store.appendLog(runId, {
    event: 'tool_resolved', node: `executor:${taskId}`,
    tools: tools.map(t => t.name), ceiling: grant.ceiling, source: 'static'
  });
  for (const m of grant.missing) {
    store.appendLog(runId, { event: 'tool_missing', node: `executor:${taskId}`, tool: m.tool, reason: m.reason });
  }
  for (const r of grant.refused) {
    store.appendLog(runId, { event: 'tool_grant_refused', node: `executor:${taskId}`, tool: r.tool, ceiling: grant.ceiling });
  }

  // `protocol` records HOW this agent will call its tools. The log said only
  // that tools were called, so the native and text paths were indistinguishable
  // after the fact and "did native actually run?" could only be inferred from
  // the catalogue (V1 task 11).
  store.appendLog(runId, {
    event: 'node_start', node: `executor:${taskId}`, worker: task.worker,
    protocol: tools.length ? toolProtocol(worker) : 'none'
  });

  // Bind the run's target workspace (V1 task 1) so file tools act on the real
  // project. A missing/moved folder degrades gracefully: the file tools fall
  // back to the run's own workspace sandbox instead of failing the task.
  // Bound BEFORE context assembly, because a declared input may name a file in
  // that project (see below).
  let workspace = null;
  const wsPath = store.readMeta(runId)?.workspace;
  if (wsPath) {
    try { workspace = new Workspace(wsPath); }
    catch (err) { store.appendLog(runId, { event: 'workspace_unavailable', path: wsPath, error: String(err?.message ?? err) }); }
  }

  // Assemble the task's full context from files — no hidden state.
  const contextParts = [];
  for (const input of task.inputs) {
    if (input === 'prompt.md') contextParts.push(`--- prompt.md ---\n${store.readPrompt(runId)}`);
    else if (input === 'plan.md') contextParts.push(`--- plan.md ---\n${store.readPlan(runId)}`);
    else {
      const m = input.match(/task-\d+/);
      // Not a task reference: flow runs may name an upstream flow-node id whose
      // output lives in nodes/<id>.md, or a contextSpec file — which means a
      // file in the BOUND PROJECT first, and only then the run's own sandbox.
      // Reading just the sandbox meant a task declaring "src/types.ts" was told
      // it did not exist while the repo it was bound to held exactly that file
      // (V1 task 12).
      let out = m ? store.readTaskOutput(runId, m[0]) : store.readNodeOutput?.(runId, input);
      if (out == null && !m && workspace) {
        try { out = workspace.readFile(input); } catch { /* escapes the project root */ }
      }
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
  // Skills the task carries (from its node's template) resolved against the
  // bound project's .flyt/skills/ (V1 task 10). Logged either way, so an
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
    const result = await runAgent({ worker, apiKey, system, prompt: userMsg, tools, ctx, onText, onRetry, retry: retry ?? config.retry, signal });
    // An agent that produced no deliverable has not done the task, whatever the
    // transport says. Marking it done would leave the streamed partial (or a
    // 0-byte file) standing as the task's output and let dependents run on it.
    if (!String(result.text ?? '').trim()) {
      throw new Error(`${worker.provider}/${worker.model} returned an empty response`);
    }
    // Authoritative write: onText may have left the last turn's partial text
    // (or a tool block) in this file, and this is what replaces it.
    store.writeTaskOutput(runId, taskId, result.text.trim());
    status = 'done';
    const failedCalls = result.toolCalls.filter(c => !c.ok);
    // A command that exits non-zero is a RESULT, not a tool failure: bash hands
    // the exit code back as data so the agent can read it and react (see
    // core/tools/bash.js), which makes ok:true mean "the tool ran", not "the
    // command succeeded". So a red test suite counted as a clean success and
    // vanished from the retrospective — a live run ended with `npm test` exit 1
    // and reported no problems at all. Whether the agent should have recovered
    // is its business; whether the run remembers is ours.
    const redCommands = result.toolCalls.filter(c => c.ok && c.tool === 'bash' && c.result?.exitCode !== 0);
    const problems = [
      // A refused grant is a problem even when the task succeeded: something
      // asked for more than its ceiling allows, and that must be visible
      // rather than merely absent (TOOLS-PLAN §5.3).
      ...grant.refused.map(r => `Tool "${r.tool}" was refused: outside this node's toolCeiling.`),
      ...failedCalls.map(c => `Tool call ${c.tool} failed: ${c.error}`),
      ...redCommands.map(c => `Command exited ${c.result.exitCode}: ${String(c.result.command ?? '').slice(0, 120)}`)
    ];
    retro = makeRetrospective({
      node: `executor:${taskId}`,
      status: 'success',
      problems,
      resolution: [
        failedCalls.length ? 'Tool errors were fed back to the model for self-correction.' : '',
        redCommands.length ? 'A command the agent ran exited non-zero; the agent reported the task complete regardless — check the tool calls before trusting the deliverable.' : ''
      ].filter(Boolean).join(' '),
      confidence: redCommands.length ? 0.4 : 0.75,
      recommendation: `Task "${task.title}" completed by ${task.worker.provider}/${task.worker.model}${result.toolCalls.length ? ` using ${result.toolCalls.length} tool call(s)` : ''}`
        + `${redCommands.length ? `, but ${redCommands.length} command(s) exited non-zero` : ''}.`,
      model: task.worker,
      usage: result.usage,
      durationMs: result.durationMs,
      toolCalls: result.toolCalls
    });
  } catch (err) {
    // RUN-CONTROL stop: an aborted model call is not a task failure. The task
    // goes back to 'pending' so a later resume/restart re-runs it, and the
    // retrospective carries the same aborted flag a tool-gate rejection does,
    // so the scheduler never turns a stop into a run failure.
    const stopped = Boolean(err?.aborted || err?.name === 'AbortError' || signal?.aborted);
    status = stopped ? 'pending' : 'failed';
    const aborted = stopped || Boolean(err?.toolRejected);
    retro = makeRetrospective({
      node: `executor:${taskId}`,
      status: 'failed',
      problems: [stopped ? 'Stopped by the user (run cancelled).' : String(err.message ?? err)],
      resolution: stopped
        ? 'The run was stopped; the task returns to the queue unfinished.'
        : aborted
          ? 'A tool call was rejected at the approval gate; task aborted by the human.'
          : 'Task marked failed; pipeline escalates to human.',
      confidence: 0,
      recommendation: stopped
        ? `Task "${task.title}" was stopped mid-flight — resume or restart the run to re-run it.`
        : aborted
          ? `Task "${task.title}" was aborted — a destructive tool call was rejected at the approval gate.`
          : `Task "${task.title}" failed — inspect log.jsonl and retry with a different worker.`,
      model: task.worker
    });
    // Flag human rejections and stops so the runner keeps the stage those
    // paths set, rather than overwriting it with a generic "failed".
    if (aborted) retro.aborted = true;
    if (stopped) retro.stopped = true;
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
