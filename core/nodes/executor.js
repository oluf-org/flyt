// Executor node: runs ONE task from tasks.json -> tasks/<id>.md + per-task
// retrospective. Sequential orchestration lives in pipeline.js; this module
// only knows how to execute a single self-describing task from file state.
import { runAgent, toolProtocol, describeEmptyTurn, supportsToolsFor } from '../agent.js';
import { resolveTools } from '../tools/index.js';
import { makeRetrospective } from '../retrospective.js';
import { recordToolUsage } from '../feedback.js';
import { runRetrospectiveTurn, retroWorker, retroEnabled } from '../retroTurn.js';
import { Workspace } from '../workspace.js';
import { loadSkills, withSkillsSection, resolveSkillToolRequests, missingSkillToolsSection } from '../skills.js';
import { resolveCallTarget, autoFallbackTargets } from '../modelSource.js';
import { effectContractFor, captureWorkspaceSignature, evaluateTaskEffect, describeEffect, EffectMissingError } from '../effect.js';
import { effortBudget } from '../../src/flowTypes.js';

// onText (optional): the caller's streaming sink for partial model output (V1
// task 8). onRetry (optional): fires per transient-error backoff (V1 task 11).
// Both are forwarded to the agent loop untouched — what to do with them is the
// caller's business, not this module's. signal (optional, RUN-CONTROL): an
// AbortSignal the runner fires on stop(); the agent loop's model calls reject
// with an AbortError, which lands in the catch below as a STOPPED task —
// requeued to 'pending', never marked failed.
export async function runExecutorTask(store, runId, taskId, config = {}, { approveToolCall = null, ledger = null, onText = null, onRetry = null, notify = null, retry = null, timeout = null, backlog = null, feedback = null, references = null, pool = null, signal = null, unattended = false } = {}) {
  const tasksDoc = store.readTasks(runId);
  const task = tasksDoc.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found in tasks.json`);

  // tasks.json never stores API keys; resolve the key for this task's
  // provider from the runtime config at call time. An 'auto' provider (a task
  // created from an active-models pick) resolves through the main process's
  // resolver — priority walk, pin override, key + keyKind stamping.
  const target = resolveCallTarget(task.worker, config);
  const apiKey = target.apiKey;

  // Native tool-calling is available per MODEL. Asked of the SHARED rule rather
  // than re-decided here: this line was `Boolean(config.modelCapabilities?.[model])`,
  // which ignores the catalogue facts and ignores the "unknown, on an
  // OpenAI-compatible provider, means probably yes" default that
  // `supportsToolsFor` exists to encode. Nothing outside the desktop app's
  // Settings page ever fills `modelCapabilities`, so the answer here was always
  // FALSE — on every model, for every task, forever.
  //
  // The executor is the only node that writes code. So the one node whose whole
  // job is touching the workspace was the one node hardcoded never to call a
  // tool natively. Watched seven sub-tasks in a row run on the text protocol,
  // make zero tool calls, report `done`, and produce no diff.
  const worker = { ...task.worker, provider: target.provider, model: target.model, ...(target.keyKind ? { keyKind: target.keyKind } : {}) };
  if (worker.provider !== 'mock' && worker.provider !== 'anthropic') {
    worker.supportsTools = supportsToolsFor(worker, config);
  }

  // The grant, intersected with the ceiling (DESIGN-SPEC.md §5). Absent ceiling ⇒
  // the ceiling is the grant, and an absent grant is the whole library — the
  // pre-ceiling semantics, unchanged.
  //
  // Nothing here is fatal, and the two failure modes are deliberately
  // different: a MISSING tool degrades the node quietly (the skills rule), a
  // REFUSED one means something tried to exceed its envelope and is recorded
  // as a problem on the retrospective as well as in the log.
  const grant = resolveTools({ grant: task.tools ?? null, ceiling: task.toolCeiling ?? null });
  let tools = grant.tools;
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
  // Requested vs effective, in one record (WR-03/WR-04). `task.worker` is what
  // this task is pointed at — including a manual retry override, which is the
  // whole point: a retry re-pointed at another model has to be visible in the
  // artifacts as having actually gone there. `resolvedWorker` is where an
  // 'auto' provider landed after the priority walk. Never a key.
  const sameTarget = task.worker.provider === worker.provider && task.worker.model === worker.model;
  store.appendLog(runId, {
    event: 'node_start', node: `executor:${taskId}`, worker: task.worker,
    ...(sameTarget ? {} : { resolvedWorker: { provider: worker.provider, model: worker.model } }),
    ...(task.originalWorker ? { originalWorker: task.originalWorker, retryOverride: true } : {}),
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
  //
  // An input the plan EXPLICITLY declared required, and which does not exist,
  // stops the task before a model is invoked (WR-06). Runs used to log
  // `context_input_missing`, hand the executor a "[NOT FOUND]" placeholder, and
  // let it work from an assumption — which is how downstream tasks came to run
  // on documentation that was never written.
  //
  // `requiredInputs` is a NEW, opt-in declaration, deliberately not derived
  // from the legacy `inputs` list. `inputs` has always been best-effort — a
  // fan-out lane or an authored flow lists upstream ids that may legitimately
  // produce no file — so promoting all of them to required would re-define
  // every flow ever written and fail work that is not wrong.
  const requiredInputs = new Set(task.requiredInputs ?? []);
  const missingRequired = [];
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
        const required = requiredInputs.has(input);
        contextParts.push(`--- ${input} ---\n[NOT FOUND: this declared input does not exist in the run yet. State any assumptions you make.]`);
        store.appendLog(runId, {
          event: 'context_input_missing', node: `executor:${taskId}`, input, required
        });
        if (required) missingRequired.push(input);
      }
    }
  }

  // A required input that does not exist is a graph error, not something for
  // the model to work around (WR-06). Failing HERE costs nothing; failing after
  // the call costs a model call and produces a confident deliverable built on
  // an assumption, which downstream tasks then treat as fact.
  if (missingRequired.length) {
    const problem = `Required input(s) not available: ${missingRequired.join(', ')}. `
      + 'Nothing in this run produces them, so this task cannot start.';
    const retro = makeRetrospective({
      node: `executor:${taskId}`,
      status: 'failed',
      problems: [problem],
      resolution: 'The task was not started; no model was called.',
      confidence: 0,
      recommendation: `Task "${task.title}" declares input(s) nothing produces — `
        + 'fix the plan (add a producer, or mark them optional) and re-run.',
      model: task.worker
    });
    const doc = store.readTasks(runId);
    const t = doc.tasks.find(x => x.id === taskId);
    if (t) t.status = 'failed';
    store.writeTasks(runId, doc);
    task.status = 'failed';
    store.writeRetrospective(runId, `executor-${taskId}`, retro);
    return retro;
  }
  const ctx = {
    store, runId, taskId, workspace,
    // How this installation is set up, for the tools whose answer depends on
    // it rather than on this run (web_search's key, why_blocked's reviewer).
    config,
    // The worktree pool, when the caller has one: read_run's diff.
    pool,
    // The project backlog (DESIGN-SPEC.md §8), resolved outside any worktree, so a
    // task an agent notices mid-run outlives the run: enqueue_task writes here.
    backlog,
    // Where an instance's tool review lands (DESIGN-SPEC.md §8), same canonical
    // location rule as the backlog: outside every worktree.
    feedback,
    // The read-only reference library (DESIGN-SPEC.md §8): prior art an agent can
    // grep at task time instead of designing from first principles.
    references,
    notify,
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
  const skillTools = resolveSkillToolRequests(skills, {
    granted: task.skillToolGrants ?? [], unattended,
    // A request is dynamic authority: unlike the legacy absent-grant behavior,
    // it has no ceiling unless the block author wrote one (or a static grant).
    ceiling: task.toolCeiling ?? task.tools ?? [], resolve: resolveTools
  });
  const byName = new Map(tools.map(t => [t.name, t]));
  for (const tool of skillTools.tools) byName.set(tool.name, tool);
  tools = [...byName.values()];
  for (const miss of skillTools.ungranted) {
    store.appendLog(runId, { event: 'skill_tool_missing', node: `executor:${taskId}`, ...miss });
  }
  for (const refused of skillTools.refused) {
    store.appendLog(runId, { event: 'skill_tool_refused', node: `executor:${taskId}`, ...refused, ceiling: skillTools.ceiling });
  }
  const unavailableSkillTools = [...skillTools.ungranted, ...skillTools.refused.map(r => ({
    ...r, reason: 'outside this block\'s static tool ceiling'
  }))];

  let system = withSkillsSection([
    'ROLE: executor',
    'You are an execution worker in an AI orchestration pipeline.',
    'Complete exactly the task described. Produce the deliverable as Markdown.',
    'Do not do work belonging to other tasks. Respect every constraint.',
    tools.length ? 'You have tools to write files, spawn follow-up tasks, and record a task spec — use them when they help the task.' : ''
  ].filter(Boolean).join('\n'), skills);
  const missingToolNotice = missingSkillToolsSection(unavailableSkillTools);
  if (missingToolNotice) system += `\n\n${missingToolNotice}`;

  const userMsg = [
    `USER PROMPT:\n${store.readPrompt(runId)}`,
    `TASK: ${task.title}`,
    `GOAL: ${task.goal}`,
    task.constraints.length ? `CONSTRAINTS:\n- ${task.constraints.join('\n- ')}` : '',
    contextParts.length ? `CONTEXT:\n${contextParts.join('\n\n')}` : ''
  ].filter(Boolean).join('\n\n');

  // --- The effect contract (WR-01) -----------------------------------------
  // What this task owes: a document, a change in the bound project, either, or
  // nothing. Authored on the node and stamped onto the task when one was
  // declared; otherwise inferred from the task's role/category and the tools it
  // was actually granted. Resolved HERE, in the one place that has both the
  // authored intent and the resolved tool records.
  const contract = effectContractFor({
    type: 'agentTask',
    role: task.role, category: task.category,
    // `task.tools` absent means the full registry, not a chosen grant — the
    // difference decides whether the grant counts as evidence of intent.
    tools, toolsAuthored: Array.isArray(task.tools),
    effect: task.effect, effectScope: task.effectScope
  });
  // The baseline is taken before a single tool runs, so "what changed" means
  // what THIS task changed rather than what it inherited. Read-only: capturing
  // it must never itself be a workspace effect.
  const beforeSig = contract.mode === 'artifact' || contract.mode === 'none'
    ? null
    : captureWorkspaceSignature(workspace?.root ?? wsPath ?? null);
  store.appendLog(runId, {
    event: 'effect_contract', node: `executor:${taskId}`,
    effect: contract.mode, inferred: contract.inferred,
    ...(contract.scope ? { scope: contract.scope } : {}),
    ...(beforeSig && beforeSig.kind === 'none' ? { unmeasurable: beforeSig.reason } : {})
  });

  let retro;
  let status;
  let effect = null;
  try {
    const result = await runAgent({
      worker, apiKey, system, prompt: userMsg, tools, ctx, onText, onRetry,
      // Auto routes may fall through when the RUNTIME cannot start — a missing
      // or unlaunchable vendor CLI (WR-05). `autoFallbackTargets` returns an
      // empty list for a pinned source, so a pin can never be silently spent
      // somewhere else; and the activity is logged, so a fallback shows as
      // "Codex could not start; trying OpenRouter" rather than as a stale
      // fatal error sitting next to a live attempt.
      fallback: {
        // The REQUESTED source, not the resolved provider: `worker` below has
        // already been resolved to a concrete provider, so reading the source
        // off it would make every auto route look pinned.
        source: task.worker.provider,
        candidates: autoFallbackTargets(task.worker, config, {
          tried: [{ provider: target.provider, model: target.model }]
        }),
        onFallback: info => store.appendLog(runId, {
          event: 'route_fallback', node: `executor:${taskId}`,
          from: info.from, to: info.to, code: info.code,
          detail: info.detail, remedy: info.remedy
        })
      },
      // agentTask is the code-writing path. It must honor the same host-level
      // tool budget as aiStep (FlowRunner.callAgent), otherwise changing
      // config.maxToolIterations affects planners but leaves every executor
      // stuck on runAgent's small fallback cap.
      maxIterations: config.maxToolIterations ?? null,
      // An executor writes a deliverable and reasons its way there, so it needs
      // the same reasoning headroom every other node gets (D40). Without one it
      // fell through to the adapter's bare 4096 — enough budget for a thinking
      // model to spend entirely on thinking.
      maxTokens: effortBudget(task.effort),
            // The SAME name the retrospective below is written under. Two spellings
      // for one node meant the ledger read the trace and the retrospective as
      // two nodes and billed the task twice for one set of calls.
      onCall: record => store.writeCallTrace(runId, `executor-${taskId}`, record),
      onEmptyTurn: info => store.appendLog(runId, { event: 'model_empty_turn', node: `executor:${taskId}`, ...info }),
      retry: retry ?? config.retry, timeout: timeout ?? config.timeout, signal
    });
    // An agent that produced no deliverable has not done the task, whatever the
    // transport says. Marking it done would leave the streamed partial (or a
    // 0-byte file) standing as the task's output and let dependents run on it.
    if (!String(result.text ?? '').trim()) {
      throw new Error(describeEmptyTurn(worker, result));
    }
    // Authoritative write: onText may have left the last turn's partial text
    // (or a tool block) in this file, and this is what replaces it.
    //
    // Written BEFORE the effect is judged, and deliberately: when a required
    // change is missing the prose is still the best evidence of what the model
    // believed it did, and a reader needs it to decide whether to retry, re-aim
    // or rewrite the task. It is kept as evidence — never as a completion.
    const artifact = [result.text.trim(), missingToolNotice ? `\n\n## Missing skill tools\n\n${missingToolNotice}` : ''].join('');
    store.writeTaskOutput(runId, taskId, artifact);

    // Did the task actually do what it owed? A confident paragraph is not a
    // repository change, and treating it as one is how a green node ends up
    // sitting on top of an empty diff (WR-01).
    effect = evaluateTaskEffect({
      contract,
      artifactText: result.text,
      before: beforeSig,
      after: beforeSig ? captureWorkspaceSignature(workspace?.root ?? wsPath ?? null) : null
    });
    if (!effect.ok) {
      store.appendLog(runId, {
        event: 'effect_missing', node: `executor:${taskId}`,
        effect: contract.mode, inferred: contract.inferred, reason: effect.reason,
        toolCalls: result.toolCalls.length,
        writes: result.toolCalls.filter(c => c.ok && (c.tool === 'create_file' || c.tool === 'edit_file')).length,
        ...(effect.outOfScopePaths?.length ? { outOfScope: effect.outOfScopePaths.slice(0, 20) } : {})
      });
      throw new EffectMissingError(effect);
    }
    if (effect.unverified) {
      // Accepted on the artifact because the workspace could not be measured.
      // Said out loud rather than silently: landing's empty-diff check is the
      // only thing standing behind this one.
      store.appendLog(runId, {
        event: 'effect_unverified', node: `executor:${taskId}`,
        effect: contract.mode, reason: effect.observed?.undetectable ?? 'workspace effect could not be measured'
      });
    }
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
      // rather than merely absent (DESIGN-SPEC.md §5).
      ...grant.refused.map(r => `Tool "${r.tool}" was refused: outside this node's toolCeiling.`),
      ...unavailableSkillTools.map(r => `Skill "${r.skill}" is missing requested tool "${r.tool}": ${r.reason}.`),
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

    // --- The retrospective turn (DESIGN-SPEC.md §8) ---
    // The instance is prompted once more, with its own completion handed back,
    // and asked how the toolbox was and what was missing. It runs AFTER the
    // deliverable is written and the status is set, so nothing about the task's
    // outcome depends on it: a retrospective that fails is simply absent.
    if (retroEnabled(config)) {
      // A configured retrospective worker resolves its own call target — key,
      // provider walk and all — exactly like the task's worker did above. It is
      // usually a cheaper model than the one that did the work (§8), so it is a
      // different provider as often as not.
      const configured = retroWorker(config, null);
      const retroTarget = configured ? resolveCallTarget(configured, config) : null;
      const answer = await runRetrospectiveTurn({
        worker: retroTarget
          ? { ...configured, provider: retroTarget.provider, model: retroTarget.model, ...(retroTarget.keyKind ? { keyKind: retroTarget.keyKind } : {}) }
          : worker,
        apiKey: retroTarget ? retroTarget.apiKey : apiKey,
        goal: userMsg,
        availableTools: tools,
        toolCalls: result.toolCalls,
        output: result.text,
        retry: retry ?? config.retry,
        timeout: timeout ?? config.timeout,
        signal,
        onRetry,
        onProblem: reason => store.appendLog(runId, { event: 'retrospective_skipped', node: `executor:${taskId}`, reason })
      });
      if (answer) {
        retro.review = answer.used;
        retro.missing = answer.missing;
        feedback?.record({
          runId,
          nodeId: `executor:${taskId}`,
          task: taskId,
          model: task.worker,
          review: answer.used,
          missing: answer.missing
        });
        store.appendLog(runId, {
          event: 'retrospective',
          node: `executor:${taskId}`,
          reviewed: answer.used.map(u => `${u.tool}:${u.rating}`),
          requested: answer.missing.map(m => m.want),
          by: answer.model
        });
      }
    }
  } catch (err) {
    // RUN-CONTROL stop: an aborted model call is not a task failure. The task
    // goes back to 'pending' so a later resume/restart re-runs it, and the
    // retrospective carries the same aborted flag a tool-gate rejection does,
    // so the scheduler never turns a stop into a run failure.
    const stopped = Boolean(err?.aborted || err?.name === 'AbortError' || signal?.aborted);
    status = stopped ? 'pending' : 'failed';
    const aborted = stopped || Boolean(err?.toolRejected);
    // A task that wrote nothing is a DIFFERENT failure from a model that errored
    // (WR-01). The deliverable it did produce stays on disk as evidence, and the
    // recommendation says what is actually wrong — "retry with a different
    // worker" is unhelpful advice when the model answered fine and simply never
    // touched the repository.
    const effectMissing = Boolean(err?.effectMissing);
    if (effectMissing) effect = err.effect;
    retro = makeRetrospective({
      node: `executor:${taskId}`,
      status: 'failed',
      problems: [stopped ? 'Stopped by the user (run cancelled).' : String(err.message ?? err)],
      resolution: stopped
        ? 'The run was stopped; the task returns to the queue unfinished.'
        : aborted
          ? 'A tool call was rejected at the approval gate; task aborted by the human.'
          : effectMissing
            ? 'The model produced a deliverable but not the effect this task requires; the text is kept as evidence, not as a completion.'
            : 'Task marked failed; pipeline escalates to human.',
      confidence: 0,
      recommendation: stopped
        ? `Task "${task.title}" was stopped mid-flight — resume or restart the run to re-run it.`
        : aborted
          ? `Task "${task.title}" was aborted — a destructive tool call was rejected at the approval gate.`
          : effectMissing
            ? `Task "${task.title}" reported completion without producing the required ${effect?.required === 'workspace-change' ? 'change to the project' : 'deliverable'}`
              + ` — read tasks/${taskId}.md for what it claimed, then retry it with clearer instructions or a worker that uses its tools.`
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
  // The effect contract and what was observed ride on the retrospective, so the
  // run feed, diagnostics and the retro reader all read one recorded fact
  // rather than each re-deriving it (WR-01 telemetry).
  if (effect) {
    retro.effect = {
      required: effect.required, ok: effect.ok, inferred: contract.inferred,
      ...(contract.scope ? { scope: contract.scope } : {}),
      ...(effect.reason ? { reason: effect.reason } : {}),
      ...(effect.unverified ? { unverified: true } : {}),
      changedPaths: (effect.changedPaths ?? []).slice(0, 20),
      summary: describeEffect(effect)
    };
  }
  const freshDoc = store.readTasks(runId);
  const freshTask = freshDoc.tasks.find(t => t.id === taskId);
  if (freshTask) freshTask.status = status;
  store.writeTasks(runId, freshDoc);
  task.status = status; // keep the in-memory copy consistent for callers
  store.writeRetrospective(runId, `executor-${taskId}`, retro);
  // The instance's tool use joins the project's feedback pile (DESIGN-SPEC.md §8).
  // Facts only, derived from the calls it made.
  recordToolUsage(feedback, { runId, nodeId: `executor:${taskId}`, task: taskId, model: task.worker, retro });
  return retro;
}
