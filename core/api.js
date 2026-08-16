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
import fs from 'node:fs';
import path from 'node:path';
import { Workspace } from './workspace.js';
import { landTask, verifyTask } from './landing.js';
import { pushRefs, git } from './worktree.js';
import { workerForLevel, levelFor, LEVELS } from './levels.js';

// A band→model map, cleaned: known band names, non-empty ids, nothing else.
// Sent by a UI, a CLI flag and config.json alike, so it is normalized once here
// rather than trusted three times.
function normalizeLevelModels(raw) {
  const out = {};
  for (const band of LEVELS) {
    const id = raw?.[band];
    if (typeof id === 'string' && id.trim()) out[band] = id.trim();
  }
  return out;
}
import { Supervisor, renderReport } from './supervisor.js';
import { reviewWorker } from './diffReview.js';
import { APPROVAL_MODES } from './flowRunner.js';
import { lintFlow } from './flowlang/lint.js';
import {
  loadSuite, runBenchmark, saveCard, listCards, readCard, recentCards,
  compareCards, renderScorecard, renderComparison, DEFAULT_SUITE_DIR
} from './benchmark.js';
import { writeArchive, listArchive, readArchive, trend, dateStamp } from './archive.js';
import { assertRepoUrl, nameFromRepoUrl } from './references.js';
import { explainRun, probeModel, doctor, modelsInFlow } from './diagnostics.js';

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

  /**
   * A worker a CALLER named, turned into one the runner can use.
   *
   * `{ provider: 'auto', model }` is what every picker and every `--model` flag
   * produces: the id is the decision, and who serves it is the priority walk's
   * business. Resolving here rather than at the first model call is what makes
   * "no connected provider can serve this" a pre-flight error instead of a
   * worktree's worth of wasted work.
   *
   * The key never travels the other way: callers name models, the main process
   * holds keys, and a command surface reachable over HTTP must not be a way to
   * hand one in or read one out.
   *
   * `withKey` is OFF by default and must stay that way for anything that
   * becomes a node's worker. `log.jsonl` records `node_start` with the worker
   * object verbatim, so a key stamped here is a key written in plaintext into
   * every run's log — which agents read, the archive copies, and people paste
   * into bug reports. The runner does not need it: `resolveCallTarget` looks
   * the key up from `providerKeys` at call time. Only a caller that calls a
   * model DIRECTLY (the reviewer, which is not a node and is never logged)
   * asks for one.
   */
  const resolveWorkerArg = (worker, { withKey = false } = {}) => {
    if (!worker?.provider || !worker?.model) return null;
    let target = { provider: worker.provider, model: worker.model };
    if (target.provider === 'auto') {
      const r = runtimeConfig.resolveModelSource(target.model); // throws with a settings-pointing message
      target = { provider: r.provider, model: r.model };
    }
    if (!withKey) return target;
    const apiKey = runtimeConfig.providerKeys?.[target.provider] ?? null;
    return apiKey ? { ...target, apiKey } : target;
  };

  // One supervisor per project, for the life of the process.
  const supervisors = new Map();
  // One in-flight benchmark per project. Same reason: two benchmark runs over
  // one project would write two cards claiming to describe the same revision.
  const benchmarks = new Map();

  // A repository, because a benchmark clones one and an archive reads its
  // history. An appdata project has files but no git, and saying so beats a
  // git error from four calls deeper.
  const repoFor = projectId => {
    const entry = proj(projectId);
    // Checked, not assumed. A benchmark clones and an archive reads history, so
    // "there is a folder" is not the question — and the alternative is a git
    // error from four calls deeper, inside a background promise, at the end of
    // a working day. (`.git` is a file in a worktree and a directory in a
    // checkout; both count.)
    if (!entry.folder || !fs.existsSync(path.join(entry.folder, '.git'))) {
      throw new ApiError('This project is not a git repository, so it has nothing to clone or archive.',
        { status: 400, code: 'no_repo' });
    }
    return entry;
  };
  const stateDir = (projectId, name) => {
    const dir = engine.configDirOf(projectId);
    if (!dir) throw new ApiError(`This project has no folder, so it has nowhere to keep ${name}.`,
      { status: 400, code: 'no_folder' });
    return path.join(dir, name);
  };

  // Every flow, loaded. The list() shape is id + name only; the sub-flow lint
  // rules need nodes and edges to resolve a reference, find a cycle, or
  // measure depth. Flows are small YAML files and lint is user-triggered.
  const allFlows = () => flows.list()
    .map(f => { try { return flows.load(f.id); } catch { return null; } })
    .filter(Boolean);

  const commands = {
    // --- Flows -------------------------------------------------------------
    'flow:list': () => flows.list(),
    'flow:load': ({ id }) => flows.load(id),
    'flow:lint': ({ id }) =>
      lintFlow(flows.load(id), {
        templates: nodeLibrary.listFull(), library: toolLibrary.catalog(),
        // The sub-flow rules walk the flow-REFERENCE graph, so they need every
        // flow's nodes, not just its name (D36 P3.4).
        flows: allFlows()
      }),

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

    // Clone a repository and open it as a project (D36 P1, generalised).
    //
    // The two things you might want to do with someone else's repository are
    // different enough to be different commands: `ref:add` takes a read-only,
    // pinned, shallow copy you can grep and cite but never edit, and this takes
    // a full working clone you can be pointed at and told to change. Reading is
    // the safe default; this one is the deliberate act.
    'repo:clone': async ({ url, parentDir, name = null, open = true }) => {
      const clean = assertRepoUrl(url);
      if (!parentDir) throw new ApiError('A folder to clone into is required.', { status: 400, code: 'no_parent_dir' });
      const derived = nameFromRepoUrl(clean);
      const dirName = String(name || derived.name).replace(/[^a-zA-Z0-9._-]+/g, '-');
      const target = path.join(path.resolve(parentDir), dirName);
      if (fs.existsSync(target)) {
        throw new ApiError(`"${target}" already exists. Open it as a project, or clone somewhere else.`,
          { status: 409, code: 'target_exists' });
      }
      // A FULL clone, unlike a reference: you are going to work in this one,
      // and a shallow checkout makes branching and merging quietly worse.
      await git(['clone', clean, target], { cwd: path.resolve(parentDir), timeoutMs: 20 * 60 * 1000 });
      if (!open) return { folder: target, opened: false };
      const { project } = registry.open(target);
      return {
        folder: target, opened: true,
        id: project.id, name: project.name, kind: project.kind
      };
    },

    // --- Running -----------------------------------------------------------
    //
    // One engine, one entry point: pick a workflow, give it a request, run it.
    // The workspace is bound at run time (D15) — a bound tab IS its workspace
    // (T19), an appdata project has its own managed one (L5), and only an
    // unbound project picks one per run (or none, for mock/no-file flows).
    'flow:run': ({ projectId, flowId, userInput = '', workspaceDir = null, approvalMode = null, launch = null, level = null, worker = null }) => {
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
      //
      // A NAMED worker wins over a band, and is the same slot rather than a
      // second one: "which model does an unpinned node use" has to have exactly
      // one answer, or a run would be routed by whichever branch was written
      // last. Asking for a band is asking someone else to name the model; naming
      // it yourself is the same decision made earlier.
      entry.runner.config.levelWorker = worker?.provider && worker?.model
        ? { ...worker }
        : level
          ? workerForLevel(level, { allowedModels: runtimeConfig.loop?.allowedModels ?? null })
          : null;
      return entry.runner.start(flows.load(flowId), {
        userInput: String(userInput ?? ''),
        workspace,
        approvalMode: APPROVAL_MODES.includes(approvalMode) ? approvalMode : runtimeConfig.approvalMode,
        modeId: launch?.modeId ?? null,
        overrides: launch?.overrides ?? null,
        // Typed run inputs (D36 P1). Without this the composer collects them
        // and the runner never sees them.
        inputs: launch?.inputs ?? null,
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
    // `worker` re-pins the node's model for this attempt only (D39) — the way
    // back from "the step failed because of the model it was pointed at".
    'run:restartNode': ({ projectId, runId, nodeId, guidance = '', worker = null }) =>
      runnerFor(projectId).restartNode(runId, nodeId, String(guidance ?? ''), worker ?? null),
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
    // Throw the worktree away and drop the lease. `status: null` leaves the
    // task's status alone, which is what the supervisor wants — it has already
    // decided (queued a rung up, or parked) and a status written here would
    // overwrite that decision.
    'work:discard': async ({ projectId, taskId, status = 'queued' }) => {
      const removed = await poolFor(projectId).remove(taskId, { deleteBranch: true });
      backlogFor(projectId).release(taskId, { status });
      return { removed };
    },
    // The whole sequence: gates → mechanical checks → review → merge → canary.
    // Every outcome that is not "landed" carries guidance, because a task that
    // fails without telling the next attempt why is just re-rolling dice.
    'work:land': async ({ projectId, taskId, dryRun = false, push = null, baselineOutput = null, reviewer = null }) => {
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
      // A reviewer named for this session beats the configured one. The loop is
      // often driven from a machine whose settings belong to a running desktop
      // app, and "who reviews this" has to be answerable at the call.
      // withKey: the reviewer is called directly by `reviewDiff`, not through
      // the runner's call-time key lookup — and it is never logged as a node.
      const named = resolveWorkerArg(reviewer, { withKey: true });
      const config = named
        ? { ...runtimeConfig, workers: { ...runtimeConfig.workers, reviewer: named } }
        : runtimeConfig;
      const result = await landTask({
        pool, repoRoot: entry.folder, taskId, task, base, dryRun, baselineOutput,
        config,
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
    'loop:start': async ({
      projectId, parallelism = 1, maxTasks = null, dryRun = false,
      worker = null, reviewer = null, models = null
    }) => {
      proj(projectId);
      // The model every task runs on, when one has been named. `workers.loop`
      // is where the Loop view saves its pick; an explicit `worker` on the call
      // is for a caller that wants a different one for this session only.
      // Resolved here rather than at the first model call, because the point of
      // a pre-flight check is to fail before a worktree exists.
      //
      // `models` is the other shape of the same decision: a model PER BAND, so
      // the cheap one does the ordinary work and escalation is what reaches the
      // expensive one. It wins over a single pin, because it is strictly more
      // specific — a caller that sent both meant the map.
      const byLevel = normalizeLevelModels(models ?? runtimeConfig.loop?.models);
      let pinned, sessionReviewer;
      try {
        pinned = resolveWorkerArg(worker) ?? resolveWorkerArg(runtimeConfig.workers?.loop);
        sessionReviewer = resolveWorkerArg(reviewer, { withKey: true });
        // Every model in the map is checked now, not when a task first escalates
        // into it — an unroutable model at `max` is a failure that would
        // otherwise surface hours later, on the task that most needed to work.
        for (const [band, id] of Object.entries(byLevel)) {
          const w = resolveWorkerArg({ provider: 'auto', model: id });
          if (w && w.provider !== 'mock' && !engine.hasKey(w.provider)) {
            throw new Error(`The "${band}" band is set to "${id}", but its provider (${w.provider}) is not connected.`);
          }
        }
      } catch (err) {
        throw new ApiError(String(err?.message ?? err), { status: 400, code: 'no_provider_key' });
      }
      if (Object.keys(byLevel).length) pinned = null; // the map answers per attempt
      // Fail once, here, rather than per task. Levels route through
      // OpenRouter's Auto Router (§8), so without a key every task would fail
      // at its first node with a provider error and the whole backlog would
      // end the night parked for a reason that has nothing to do with the work.
      const useLevels = runtimeConfig.loop?.levels !== false && !pinned && !Object.keys(byLevel).length;
      if (useLevels && !engine.hasKey('openrouter')) {
        throw new ApiError(
          'Effort levels route through OpenRouter, and no OpenRouter key is set. Add one in Settings, pick a model for the loop, or set loop.levels to false to run on the configured workers instead.',
          { status: 400, code: 'no_openrouter_key' });
      }
      // A pinned model whose provider is not connected fails the same way for
      // the same reason, so it gets the same one-shot check rather than forty
      // identical provider errors spread across a night.
      if (pinned && pinned.provider !== 'mock' && !engine.hasKey(pinned.provider)) {
        throw new ApiError(
          `The loop is set to run on "${pinned.model}", but its provider (${pinned.provider}) is not connected. Add a key in Settings, or choose another model.`,
          { status: 400, code: 'no_provider_key' });
      }
      // Nothing lands unattended without a reviewer (§7.2) — also worth saying
      // before a night of work rather than after it. Asked of the same function
      // the landing sequence asks, because a reviewer that is merely PRESENT is
      // not a reviewer that can be called.
      if (!sessionReviewer && !reviewWorker(runtimeConfig) && !dryRun) {
        throw new ApiError(
          'No reviewer model is configured, so nothing could land. Pick one on the Loop view (or set workers.reviewer), or start the loop with dryRun to have it stop after review.',
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
        config: {
          ...runtimeConfig,
          workers: sessionReviewer
            ? { ...runtimeConfig.workers, reviewer: sessionReviewer }
            : runtimeConfig.workers,
          loop: { ...runtimeConfig.loop, dryRun, worker: pinned, models: byLevel }
        },
        parallelism,
        log: msg => engine.emitLoop?.(projectId, msg)
      });
      supervisors.set(projectId, sup);
      // Deliberately NOT awaited: the loop runs until it is stopped or capped,
      // and the caller gets an acknowledgement rather than a connection held
      // open for the length of a working day.
      sup.run({ maxTasks: maxTasks ?? Infinity }).catch(err => engine.emitLoop?.(projectId, `loop failed: ${err.message}`));
      return {
        started: true, parallelism, levels: useLevels,
        model: pinned?.model ?? null,
        models: byLevel,
        reviewer: (sessionReviewer ?? reviewWorker(runtimeConfig))?.model ?? null
      };
    },
    'loop:stop': ({ projectId, reason = 'stopped by request' }) => {
      const sup = supervisors.get(projectId);
      if (!sup) return { stopped: false, reason: 'no loop running' };
      sup.stop(reason);
      return { stopped: true, reason };
    },
    'loop:log': ({ projectId }) => engine.loopLog(projectId),
    'loop:status': ({ projectId }) => supervisors.get(projectId)?.status()
      ?? { running: false, stopping: null, inFlight: [], parked: [], completed: 0, landed: 0, model: null },
    'loop:report': ({ projectId }) => renderReport({
      status: supervisors.get(projectId)?.status() ?? { running: false, stopping: null, inFlight: [], landed: 0, completed: 0 },
      backlog: backlogFor(projectId),
      ledger: ledgerFor(projectId)
    }),

    // --- The benchmark and the archive (LOOP-PLAN §12.1) --------------------
    //
    // The score exists so that "improve yourself" can be distinguished from
    // churn. It is a loop run like any other — same supervisor, same gates,
    // same reviewer — against a throwaway clone, with an independent probe per
    // case deciding whether the work actually works.
    'bench:list': ({ projectId }) => {
      const entry = repoFor(projectId);
      const { dir, cases, problems } = loadSuite(path.join(entry.folder, DEFAULT_SUITE_DIR));
      return {
        dir,
        problems,
        cases: cases.map(c => ({
          id: c.id, title: c.title, level: c.level, weight: c.weight,
          probe: c.probe, setup: c.setup, gates: c.gates
        }))
      };
    },
    'bench:run': ({ projectId, only = null, suite = 'default', keep = false, revision = 'HEAD' }) => {
      const entry = repoFor(projectId);
      if (benchmarks.get(projectId)?.running) {
        throw new ApiError('A benchmark is already running for this project.',
          { status: 409, code: 'already_running' });
      }
      const state = {
        running: true, suite, startedAt: new Date().toISOString(),
        finishedAt: null, card: null, error: null, file: null
      };
      benchmarks.set(projectId, state);
      // Not awaited, for the reason `loop:start` is not: a benchmark is a
      // working session, and an HTTP caller should not hold a connection open
      // for the length of one.
      runBenchmark({
        engine, api: { invoke }, repoRoot: entry.folder,
        only: Array.isArray(only) ? only : (only ? String(only).split(',') : null),
        suite, keep, revision,
        cloneRoot: runtimeConfig.benchmarkRoot ?? null,
        log: msg => engine.emitLoop?.(projectId, `[bench] ${msg}`)
      }).then(card => {
        state.card = card;
        state.file = saveCard(stateDir(projectId, 'scores'), card).file;
        engine.emitLoop?.(projectId,
          `[bench] ${card.totals.verified}/${card.totals.cases} verified (${(card.score * 100).toFixed(0)}%)`);
      }).catch(err => {
        state.error = String(err.message ?? err);
        engine.emitLoop?.(projectId, `[bench] failed: ${state.error}`);
      }).finally(() => {
        state.running = false;
        state.finishedAt = new Date().toISOString();
      });
      return { started: true, suite };
    },
    'bench:status': ({ projectId }) => benchmarks.get(projectId)
      ?? { running: false, suite: null, startedAt: null, finishedAt: null, card: null, error: null, file: null },
    'bench:cards': ({ projectId, suite = null, limit = 20 }) => {
      const dir = stateDir(projectId, 'scores');
      return {
        dir,
        cards: recentCards(dir, { suite, limit }).map(({ name, card }) => ({
          name, suite: card.suite, at: card.at, revision: card.revision,
          score: card.score, totals: card.totals
        }))
      };
    },
    'bench:card': ({ projectId, name }) => {
      const card = readCard(stateDir(projectId, 'scores'), name);
      if (!card) throw new ApiError(`No scorecard "${name}".`, { status: 404, code: 'no_card' });
      return card;
    },
    'bench:report': ({ projectId, name = null }) => {
      const dir = stateDir(projectId, 'scores');
      const card = name ? readCard(dir, name) : recentCards(dir, { limit: 1 })[0]?.card;
      if (!card) throw new ApiError('No scorecard to report on.', { status: 404, code: 'no_card' });
      return renderScorecard(card);
    },
    // The gradient. With no names it compares the two most recent cards of a
    // suite, which is the question anyone actually asks: is it better than last
    // time.
    'bench:compare': ({ projectId, a = null, b = null, suite = null }) => {
      const dir = stateDir(projectId, 'scores');
      let prev = a ? readCard(dir, a) : null;
      let next = b ? readCard(dir, b) : null;
      if (!prev || !next) {
        const recent = recentCards(dir, { suite, limit: 2 });
        if (recent.length < 2) {
          throw new ApiError('Two scorecards are needed to compare; run the benchmark again.',
            { status: 400, code: 'not_enough_cards' });
        }
        next ??= recent[0].card;
        prev ??= recent[1].card;
      }
      const comparison = compareCards(prev, next);
      return { comparison, text: renderComparison(comparison) };
    },

    'archive:write': async ({ projectId, date = null, card = null, windowMs = null }) => {
      const entry = repoFor(projectId);
      const backlog = backlogFor(projectId);
      const ledger = ledgerFor(projectId);
      const scores = stateDir(projectId, 'scores');
      const day = date ?? dateStamp();
      // The day's card by default: an archive of a day that ran a benchmark and
      // did not record it is missing the one number the trend needs.
      const chosen = card ? readCard(scores, card)
        : (recentCards(scores, { limit: 1 })[0]?.card ?? null);
      const useCard = chosen && String(chosen.at).slice(0, 10) === day ? chosen : null;
      const pool = engine.poolFor(projectId);
      return writeArchive({
        root: stateDir(projectId, 'archive'),
        date: day,
        backlog, ledger, card: useCard,
        repoRoot: entry.folder,
        base: pool ? await pool.defaultBranch() : 'HEAD',
        windowMs: windowMs ?? runtimeConfig.loop?.windowMs ?? 24 * 60 * 60 * 1000,
        report: renderReport({
          status: supervisors.get(projectId)?.status()
            ?? { running: false, stopping: null, inFlight: [], landed: 0, completed: 0 },
          backlog, ledger
        }),
        log: msg => engine.emitLoop?.(projectId, msg)
      });
    },
    'archive:list': ({ projectId }) => listArchive(stateDir(projectId, 'archive')),
    'archive:read': ({ projectId, date }) => {
      const found = readArchive(stateDir(projectId, 'archive'), date);
      if (!found) throw new ApiError(`Nothing archived for ${date}.`, { status: 404, code: 'no_archive' });
      return found;
    },
    'archive:trend': ({ projectId, limit = 30 }) => trend(stateDir(projectId, 'archive'), { limit }),

    // --- Spend (LOOP-PLAN §9) ----------------------------------------------
    'ledger:totals': ({ projectId, sinceMs = null, taskId = null }) =>
      ledgerFor(projectId).totals({ sinceMs, taskId }),
    'ledger:check': ({ projectId, taskId = null }) =>
      ledgerFor(projectId).check({ caps: runtimeConfig.loop?.caps ?? {}, taskId }),

    // --- Diagnostics (D40) --------------------------------------------------
    //
    // The three questions a failing run raises, each answerable without paying
    // to run it again: what happened here, does this model work, and is the
    // configuration sane. Commands rather than a CLI-only feature, so the
    // desktop app and any agent driving the HTTP API reach the same answers.
    'run:explain': ({ projectId, runId }) => explainRun(proj(projectId).store, runId),

    'model:probe': async ({ model, provider = null, maxTokens = null, stream = true }) => {
      const target = provider
        ? { provider, model, apiKey: engine.settings.providers?.[provider]?.apiKey ?? null }
        : engine.resolveModelSource(model);
      if (!target?.provider) {
        throw new ApiError(`No connected provider can serve "${model}".`, { status: 400, code: 'no_provider' });
      }
      // No budget given means "the budget a node would really get", so the
      // verdict answers "will this model work in this app" rather than "does it
      // work at some number I picked".
      return probeModel({ ...target, model },
        { ...(maxTokens ? { maxTokens } : {}), stream, timeout: engine.runtimeConfig.timeout });
    },

    'diag:doctor': ({ projectId, probe = false, models = [], flowId = null }) => {
      // A flow id checks the models THAT flow pins, which is the set that will
      // actually be called — a curated list nobody's flow uses proves nothing.
      const list = flowId ? modelsInFlow(engine.flows.load(flowId)) : models;
      // Where this project's runs are is the first thing anyone looking into a
      // failure needs and the hardest thing to guess: a bound folder keeps them
      // in its own `.flyt/runs`, an appdata project under the user profile, and
      // the dev checkout in `runs/` — three answers to one question.
      let project = null;
      try {
        const p = proj(projectId);
        project = { id: p.id ?? projectId, folder: p.folder ?? null, runsDir: p.store.rootDir };
      } catch { /* no project bound — the rest of the report still stands */ }
      return doctor(engine, { probe, models: list, project });
    },

    // --- The reference library (LOOP-PLAN §16) ------------------------------
    //
    // Recipes, not dependencies: read-only clones an agent can grep at task
    // time instead of designing from first principles. App-level, since prior
    // art is portable in the way a backlog is not.
    'ref:list': () => engine.references.list(),
    // Adopt any repository by URL (D36 P1.4). General purpose on purpose: the
    // shipped list is a starting point, not the library.
    'ref:add': ({ url, name = null, about = null, ref = null }) =>
      engine.references.adopt(url, { name, about, ref }),
    'ref:remove': ({ name }) => engine.references.remove(name),
    'ref:update': async ({ name = null }) => {
      const names = name ? [name] : engine.references.allRepos().map(r => r.name);
      const done = [];
      const failed = [];
      for (const n of names) {
        try { done.push(await engine.references.fetch(n, { onLog: msg => engine.emitLoop?.('*', msg) })); }
        // One unreachable repo must not stop the others: a library with two of
        // three repos is still a library.
        catch (err) { failed.push({ name: n, error: String(err.message ?? err) }); }
      }
      return { updated: done, failed };
    },
    'ref:search': ({ pattern, repo = null, context = 0, maxResults = 40 }) =>
      engine.references.search(pattern, { repo, contextLines: context, maxResults }),
    'ref:read': ({ ref }) => {
      const text = engine.references.read(ref);
      if (text == null) throw new ApiError(`No reference "${ref}".`, { status: 404, code: 'no_reference' });
      return text;
    },
    'ref:index': ({ name }) => engine.references.index(name),

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

  // A flow's `loop` node drives the SAME supervisor as the Loop page (D36
  // P4.2): starting a second one over one backlog would have two pickers
  // racing for the same tasks. The engine holds the slot; this fills it, so
  // neither module has to import the other.
  engine.setLoopDriver?.({
    start: async ({ projectId, parallelism = 1, maxTasks = null }) => {
      if (supervisors.get(projectId)?.running) return { started: false, joined: true };
      await commands['loop:start']({ projectId, parallelism, maxTasks });
      return { started: true, joined: false };
    },
    status: projectId => supervisors.get(projectId)?.status() ?? null
  });

  return { commands, invoke, names: () => Object.keys(commands) };
}
