// The command surface: one map, bound by three front doors (LOOP-PLAN §4.2).
//
// Every command here is transport-agnostic — it takes a plain object, returns
// plain JSON, and knows nothing about who called it. `electron/main.js` binds
// it to `ipcMain.handle`, `core/server.js` binds it to HTTP, and the CLI calls
// it in-process. One implementation, several front doors: a command that only
// the renderer can reach is a command the supervisor and the AI cannot use, and
// that was the whole reason the loop could not exist.
//
// What is NOT here, on purpose: anything that needs a window, a dialog, a
// native file picker or `shell.openPath`. Those stay bound to Electron because
// they are how a human touches the app, not what the app does. A headless
// caller asking for one gets an honest error rather than a silent no-op.
import { Workspace } from './workspace.js';
import { landTask, verifyTask } from './landing.js';
import { pushRefs } from './worktree.js';
import { workerForLevel, levelFor, LEVELS } from './levels.js';
import { Supervisor, renderReport } from './supervisor.js';
import { APPROVAL_MODES } from './flowRunner.js';
import { lintFlow } from './flowlang/lint.js';

export class ApiError extends Error {
  constructor(message, { status = 400, code = 'bad_request' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {ReturnType<import('./engine.js').createEngine>} engine
 */
export function createApi(engine) {
  const { registry, flows, nodeLibrary, toolLibrary, runtimeConfig, publicSettings } = engine;

  // A project id that isn't open is a caller error, not a crash. The CLI hands
  // these straight to the user, so the message names the id it was given.
  const proj = projectId => {
    // The registry throws its own Error for an id it doesn't know. Over IPC
    // that surfaced as a rejected invoke and the renderer knew what it meant;
    // over HTTP an unclassified throw is a 500, which tells a CLI or an agent
    // that the server broke rather than that they named the wrong project.
    try {
      const entry = registry.get(projectId);
      if (entry) return entry;
    } catch { /* fall through to the honest 404 */ }
    throw new ApiError(`No open project "${projectId}".`, { status: 404, code: 'no_project' });
  };
  const runnerFor = projectId => proj(projectId).runner;
  const feedbackFor = projectId => {
    proj(projectId);
    const feedback = engine.feedbackFor(projectId);
    if (!feedback) {
      throw new ApiError('This project has no folder, so it has nowhere to keep tool feedback.',
        { status: 400, code: 'no_feedback' });
    }
    return feedback;
  };
  const poolFor = projectId => {
    proj(projectId);
    const pool = engine.poolFor(projectId);
    if (!pool) {
      throw new ApiError('This project is not a git repository, so it cannot use worktrees.',
        { status: 400, code: 'no_repo' });
    }
    return pool;
  };
  const ledgerFor = projectId => {
    proj(projectId);
    const ledger = engine.ledgerFor(projectId);
    if (!ledger) throw new ApiError('This project has no folder, so it has nowhere to keep a ledger.',
      { status: 400, code: 'no_ledger' });
    return ledger;
  };
  const backlogFor = projectId => {
    proj(projectId); // resolve/validate the project first, for the honest 404
    const backlog = engine.backlogFor(projectId);
    if (!backlog) {
      throw new ApiError('This project has no folder, so it has nowhere to keep a backlog.',
        { status: 400, code: 'no_backlog' });
    }
    return backlog;
  };

  // One supervisor per project, for the life of the process.
  const supervisors = new Map();

  const commands = {
    // --- Flows -------------------------------------------------------------
    'flow:list': () => flows.list(),
    'flow:load': ({ id }) => flows.load(id),
    'flow:lint': ({ id }) =>
      lintFlow(flows.load(id), { templates: nodeLibrary.listFull(), library: toolLibrary.catalog() }),

    // --- Tools & config ----------------------------------------------------
    'tool:list': () => toolLibrary.list(),
    'config:get': () => ({ workers: publicSettings().workers }),
    'settings:get': () => publicSettings(),

    // --- Projects ----------------------------------------------------------
    'project:list': () => ({ tabs: registry.listOpen(), active: registry.activeId }),
    'project:open': ({ folder = null }) => {
      const { project } = registry.open(folder);
      return { id: project.id, name: project.name, kind: project.kind, folder: project.folder ?? null };
    },

    // --- Running -----------------------------------------------------------
    //
    // One engine, one entry point: pick a workflow, give it a request, run it.
    // The workspace is bound at run time (D15) — a bound tab IS its workspace
    // (T19), an appdata project has its own managed one (L5), and only an
    // unbound project picks one per run (or none, for mock/no-file flows).
    'flow:run': ({ projectId, flowId, userInput = '', workspaceDir = null, approvalMode = null, launch = null, level = null }) => {
      const entry = proj(projectId);
      let workspace = null;
      // An explicit workspaceDir WINS, even for a bound project. That is how the
      // supervisor points a run at the task's worktree instead of the main
      // checkout — without it the isolation is built and then bypassed, and
      // every task edits the repo the loop is merging into.
      if (workspaceDir) workspace = new Workspace(workspaceDir).ensure().root;
      else if (entry.folder) workspace = new Workspace(entry.folder).ensure().root;
      else if (entry.kind === 'appdata') workspace = new Workspace(entry.workspaceRoot).ensure().root;
      // launch (MODES-COMPARE) carries the picked mode and any exposed
      // run-input overrides: { modeId?, overrides? }.
      // An effort band for this run (§8): every node that has not pinned its own
      // worker routes through OpenRouter's Auto Router at that cost tier. Set on
      // the runner's config rather than baked into the flow, because the level
      // belongs to the ATTEMPT — a retry runs the same flow one rung up.
      entry.runner.config.levelWorker = level
        ? workerForLevel(level, { allowedModels: runtimeConfig.loop?.allowedModels ?? null })
        : null;
      return entry.runner.start(flows.load(flowId), {
        userInput: String(userInput ?? ''),
        workspace,
        approvalMode: APPROVAL_MODES.includes(approvalMode) ? approvalMode : runtimeConfig.approvalMode,
        modeId: launch?.modeId ?? null,
        overrides: launch?.overrides ?? null,
        compareGroup: launch?.compareGroup ?? null
      });
    },

    'run:list': ({ projectId }) => proj(projectId).store.runSummaries(),
    'run:log': ({ projectId, runId }) => proj(projectId).store.readLog(runId),

    // Fetching a snapshot re-baselines the caller's diff channel at the same
    // instant, so the rev it gets back is the one subsequent patches build on.
    'run:snapshot': ({ projectId, runId }) => {
      const entry = proj(projectId);
      const chans = engine.pushStateFor(entry.id).channels;
      const snapshot = entry.store.snapshot(runId);
      const rev = (chans.get(runId)?.rev ?? 0) + 1;
      chans.set(runId, { snapshot, rev });
      return { ...snapshot, rev };
    },

    // --- Run control -------------------------------------------------------
    // A gate can be answered with no renderer in the process, which is what
    // lets the supervisor park a task instead of blocking on one (§10).
    'run:approve': ({ projectId, runId }) => runnerFor(projectId).approvePlan(runId),
    'run:reject': ({ projectId, runId, reason = '' }) => runnerFor(projectId).rejectPlan(runId, reason),
    'run:resume': ({ projectId, runId }) => runnerFor(projectId).resume(runId),
    'run:stop': ({ projectId, runId }) => runnerFor(projectId).stop(runId),
    'run:pause': ({ projectId, runId }) => runnerFor(projectId).pause(runId),
    'run:restartNode': ({ projectId, runId, nodeId, guidance = '' }) =>
      runnerFor(projectId).restartNode(runId, nodeId, String(guidance ?? '')),
    'run:followUp': ({ projectId, runId, text }) => runnerFor(projectId).followUp(runId, String(text ?? '')),
    'run:answerInput': ({ projectId, runId, text }) => runnerFor(projectId).answerInput(runId, String(text ?? '')),

    // --- Backlog (LOOP-PLAN §5) --------------------------------------------
    //
    // The supervisor owns these files, so every caller — CLI, HTTP, an agent's
    // enqueue_task — goes through one door. Nothing writes the directory
    // directly, which is what keeps the queue outside every worktree (§5.2).
    'task:add': ({ projectId, ...task }) => backlogFor(projectId).add(task),
    'task:list': ({ projectId, status = null }) => {
      const backlog = backlogFor(projectId);
      const tasks = backlog.list({ status });
      // Malformed files are reported rather than thrown past: one bad task must
      // not stop the loop working the other forty.
      return { tasks, problems: backlog.problems ?? [] };
    },
    'task:get': ({ projectId, id }) => {
      const task = backlogFor(projectId).get(id);
      if (!task) throw new ApiError(`No task "${id}".`, { status: 404, code: 'no_task' });
      return task;
    },
    'task:update': ({ projectId, id, ...patch }) => backlogFor(projectId).update(id, patch),
    // What the picker would choose, and what is stuck and why — the answer to
    // "why is nothing being picked up", which is otherwise invisible.
    'task:ready': ({ projectId }) => ({
      ready: backlogFor(projectId).ready(),
      blocked: backlogFor(projectId).blocked()
    }),
    'task:stats': ({ projectId }) => backlogFor(projectId).stats(),
    // Pick-and-claim in one step. Returns null when there is nothing ready,
    // which is a legitimate answer and not an error: an empty queue is what a
    // finished loop looks like.
    'task:take': ({ projectId, by = 'supervisor' }) => backlogFor(projectId).take(by),
    'task:release': ({ projectId, id, status = 'queued' }) => backlogFor(projectId).release(id, { status }),
    // One rung up and back in the queue — or parked, when the ladder is spent.
    // The supervisor calls this on a failed attempt and on a stalled one (§11.4).
    'task:escalate': ({ projectId, id, reason = 'failed', note = '' }) =>
      backlogFor(projectId).escalate(id, { reason, note }),
    'task:levels': () => ({ levels: LEVELS }),

    // --- Tool feedback (LOOP-PLAN §12) -------------------------------------
    //
    // What every instance left behind about the toolbox, and the reviewer that
    // folds it into one document. Digesting is deliberately separate from
    // enqueueing: a hundred nodes asking for the same missing tool should
    // become one considered piece of work with a hundred contexts attached,
    // not a hundred backlog entries to de-duplicate by hand.
    'feedback:pending': ({ projectId }) => {
      const feedback = feedbackFor(projectId);
      const entries = feedback.pending();
      return { entries, problems: feedback.problems ?? [] };
    },
    'feedback:stats': ({ projectId }) => feedbackFor(projectId).stats(),
    // Preview without consuming: what the digest WOULD say right now.
    'feedback:preview': ({ projectId }) => feedbackFor(projectId).digest(),
    // Write the digest and archive exactly the entries it covered — scoped by
    // id, so an instance that reported mid-write is not swept away unread.
    'feedback:digest': ({ projectId, enqueue = false }) => {
      const feedback = feedbackFor(projectId);
      const digest = feedback.digest();
      if (!digest.instances) return { digest, file: null, archived: [], task: null };
      const written = feedback.writeDigest(digest);
      // Optional, and off by default: ONE task pointing at the digest, never
      // one per request. The user decides when the pile becomes work.
      let task = null;
      if (enqueue) {
        task = backlogFor(projectId).add({
          title: `Act on the tool feedback digest (${digest.missing.length} request(s), ${digest.tools.length} tool(s))`,
          goal: [
            `Read the digest at .flyt/feedback/digests/${digest.id}.md and decide what to do about it.`,
            'It groups every instance\'s tool review and every missing-capability request,',
            'each with the run, node and task it came from, so the context is already assembled.',
            'Propose concrete changes; do not treat each request as its own task.'
          ].join(' '),
          value: 4,
          createdBy: 'feedback-review'
        });
      }
      return { ...written, task };
    },
    'feedback:digests': ({ projectId }) => feedbackFor(projectId).digests(),
    'feedback:readDigest': ({ projectId, name }) => {
      const text = feedbackFor(projectId).readDigest(name);
      if (text == null) throw new ApiError(`No digest "${name}".`, { status: 404, code: 'no_digest' });
      return text;
    },

    // --- Isolation and landing (LOOP-PLAN §6, §7) ---------------------------
    //
    // The supervisor will drive these in sequence; exposing them as commands
    // means the same steps are drivable by hand, by the CLI and (later) by the
    // loop, without a second implementation of any of it.
    'work:start': async ({ projectId, taskId }) => {
      const backlog = backlogFor(projectId);
      const task = backlog.get(taskId);
      if (!task) throw new ApiError(`No task "${taskId}".`, { status: 404, code: 'no_task' });
      const pool = poolFor(projectId);
      // A leftover tree from a crashed attempt must not wedge the task forever.
      // A failed attempt is thrown away by deleting a directory (§6.1), so
      // finding one here means nobody got to throw it away — and the right
      // answer is to start clean from the current base, not to refuse.
      await pool.remove(taskId, { deleteBranch: true }).catch(() => {});
      const wt = await pool.create(taskId, task.title);
      backlog.update(taskId, { status: 'running' });
      return wt;
    },
    'work:verify': async ({ projectId, taskId }) => {
      const task = backlogFor(projectId).get(taskId);
      return verifyTask({ pool: poolFor(projectId), taskId, task: task ?? {} });
    },
    'work:diff': ({ projectId, taskId, base = null }) =>
      poolFor(projectId).diff(taskId, { base: base ?? 'HEAD' }),
    'work:discard': async ({ projectId, taskId, status = 'queued' }) => {
      const removed = await poolFor(projectId).remove(taskId, { deleteBranch: true });
      backlogFor(projectId).release(taskId, { status });
      return { removed };
    },
    // The whole sequence: gates → mechanical checks → review → merge → canary.
    // Every outcome that is not "landed" carries guidance, because a task that
    // fails without telling the next attempt why is just re-rolling dice.
    'work:land': async ({ projectId, taskId, dryRun = false, push = null, baselineOutput = null }) => {
      const entry = proj(projectId);
      const backlog = backlogFor(projectId);
      const pool = poolFor(projectId);
      const task = backlog.get(taskId);
      if (!task) throw new ApiError(`No task "${taskId}".`, { status: 404, code: 'no_task' });
      const base = await pool.defaultBranch();
      await pool.commit(taskId, `${task.title}\n\nTask ${taskId}.`);
      // Pushing is outward-facing and hard to take back, so it is opt-in:
      // `loop.push` in config, or --push on the command. A repo with no origin
      // is still a perfectly good local loop.
      const wantPush = push ?? runtimeConfig.loop?.push === true;
      const result = await landTask({
        pool, repoRoot: entry.folder, taskId, task, base, dryRun, baselineOutput,
        config: runtimeConfig,
        push: wantPush ? (args => pushRefs({ ...args, log: () => {} })) : null,
        // The canary: the gates again, on the merged result in the main
        // checkout. Two branches that each pass alone can fail together.
        verify: async () => verifyTask({ pool: { dirFor: () => entry.folder }, taskId, task })
      });
      if (result.landed) {
        backlog.update(taskId, { status: 'landed', attempts: (task.attempts ?? 0) + 1, blockedReason: null });
      } else {
        // A failed attempt goes back up a rung rather than back at the same
        // band: retrying the same capability mostly reproduces the same answer.
        // At the top of the ladder the task parks for a human instead.
        backlog.escalate(taskId, { reason: 'failed', note: result.guidance ?? result.stage });
      }
      if (result.landed) await pool.remove(taskId, { deleteBranch: false });
      return result;
    },

    // --- The loop (LOOP-PLAN §4.3, §9, §11) ---------------------------------
    //
    // One supervisor per project, held here for the life of the process: it is
    // the thing that outlives a closed window, and starting a second one over
    // the same backlog would have two pickers racing for the same tasks.
    'loop:start': async ({ projectId, parallelism = 1, maxTasks = null, dryRun = false }) => {
      proj(projectId);
      // Fail once, here, rather than per task. Levels route through
      // OpenRouter's Auto Router (§8), so without a key every task would fail
      // at its first node with a provider error and the whole backlog would
      // end the night parked for a reason that has nothing to do with the work.
      const useLevels = runtimeConfig.loop?.levels !== false;
      if (useLevels && !engine.hasKey('openrouter')) {
        throw new ApiError(
          'Effort levels route through OpenRouter, and no OpenRouter key is set. Add one in Settings, or set loop.levels to false to run on the configured workers instead.',
          { status: 400, code: 'no_openrouter_key' });
      }
      // Nothing lands unattended without a reviewer (§7.2) — also worth saying
      // before a night of work rather than after it.
      if (!runtimeConfig.workers?.reviewer && !dryRun) {
        throw new ApiError(
          'No reviewer model is configured (workers.reviewer), so nothing could land. Configure one, or start the loop with dryRun to have it stop after review.',
          { status: 400, code: 'no_reviewer' });
      }
      if (supervisors.get(projectId)?.running) {
        throw new ApiError('A loop is already running for this project.', { status: 409, code: 'already_running' });
      }
      const sup = new Supervisor({
        invoke, projectId,
        backlog: backlogFor(projectId),
        ledger: ledgerFor(projectId),
        store: proj(projectId).store,
        config: { ...runtimeConfig, loop: { ...runtimeConfig.loop, dryRun } },
        parallelism,
        log: msg => engine.emitLoop?.(projectId, msg)
      });
      supervisors.set(projectId, sup);
      // Deliberately NOT awaited: the loop runs until it is stopped or capped,
      // and the caller gets an acknowledgement rather than a connection held
      // open for the length of a working day.
      sup.run({ maxTasks: maxTasks ?? Infinity }).catch(err => engine.emitLoop?.(projectId, `loop failed: ${err.message}`));
      return { started: true, parallelism };
    },
    'loop:stop': ({ projectId, reason = 'stopped by request' }) => {
      const sup = supervisors.get(projectId);
      if (!sup) return { stopped: false, reason: 'no loop running' };
      sup.stop(reason);
      return { stopped: true, reason };
    },
    'loop:log': ({ projectId }) => engine.loopLog(projectId),
    'loop:status': ({ projectId }) => supervisors.get(projectId)?.status()
      ?? { running: false, stopping: null, inFlight: [], parked: [], completed: 0, landed: 0 },
    'loop:report': ({ projectId }) => renderReport({
      status: supervisors.get(projectId)?.status() ?? { running: false, stopping: null, inFlight: [], landed: 0, completed: 0 },
      backlog: backlogFor(projectId),
      ledger: ledgerFor(projectId)
    }),

    // --- Spend (LOOP-PLAN §9) ----------------------------------------------
    'ledger:totals': ({ projectId, sinceMs = null, taskId = null }) =>
      ledgerFor(projectId).totals({ sinceMs, taskId }),
    'ledger:check': ({ projectId, taskId = null }) =>
      ledgerFor(projectId).check({ caps: runtimeConfig.loop?.caps ?? {}, taskId }),

    // --- Liveness ----------------------------------------------------------
    // What the supervisor's heartbeat reads (§11.1): which runs this process is
    // actually executing, as process state rather than file state — precisely
    // the thing a crash destroys and a file cannot tell you.
    'run:live': ({ projectId = null } = {}) => {
      const ids = projectId ? [projectId] : registry.listOpen().map(p => p.id);
      return Object.fromEntries(ids.map(id => [id, [...(registry.get(id)?.runner?.live ?? [])]]));
    }
  };

  /**
   * Invoke a command by name. Unknown names are an error rather than undefined,
   * because a typo from an AI caller should say so instead of silently doing
   * nothing.
   */
  async function invoke(name, args = {}) {
    const fn = commands[name];
    if (!fn) throw new ApiError(`Unknown command "${name}".`, { status: 404, code: 'unknown_command' });
    return await fn(args ?? {});
  }

  return { commands, invoke, names: () => Object.keys(commands) };
}
