// The command surface: one map, bound by three front doors (DESIGN-SPEC.md §8).
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
import { correctionFields } from './repair.js';
import { pushRefs, git, releaseDeadOwners } from './worktree.js';
import { workerForLevel, workerForLevelMap, levelFor, LEVELS } from './levels.js';
import { blockersAll, boardBlockers } from './blockers.js';
import { ChatStore, runChatTurn, CHAT_TOOLS } from './chat.js';
import { breakdown, costOf, liveEntries, totalsWithLive } from './ledger.js';
import { executeTool, getTools, registerDefinition } from './tools/index.js';
import { canUseFlytTools } from './adapters/index.js';
import { SUBSCRIPTION_PROVIDERS } from './modelSource.js';
import { isDestructive } from '../src/toolTypes.js';
import { pythonStatus, setupPython } from './python.js';
import { loadToolSuite, runToolSuite, SUITE_DIR } from './toolbench.js';
import { bootLoopKernel, startStackRun, stopStackRun } from './kernelRunner.js';

// Why a one-shot call to this tool needs the caller to say so. Reads off the
// record rather than a name list, for the same reason isDestructive() does.
function describeEffects(tool) {
  const effects = tool?.effects ?? [];
  const parts = [];
  if (effects.includes('destructive')) parts.push('deletes things');
  if (effects.includes('write')) parts.push('writes to the project');
  if (effects.includes('shell')) parts.push('runs shell commands');
  return parts.length ? parts.join(' and ') : 'changes something outside this call';
}

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

/**
 * Resolve the two launch-time ways of choosing Loop workers.
 *
 * An explicit per-band map is the most specific choice. An explicit single
 * worker is next and must clear a saved per-band map; otherwise the map wins
 * later in Supervisor.#workerFor and the CLI can acknowledge one model while
 * starting another. With neither launch override, keep the saved map.
 */
export function loopLaunchModels({ worker = null, models = null, configuredModels = null } = {}) {
  const requested = normalizeLevelModels(models);
  if (Object.keys(requested).length) return requested;
  if (worker?.provider && worker?.model) return {};
  return normalizeLevelModels(configuredModels);
}

// The effort ladder must compare the workers from THIS Loop session. Landing
// runs through the process-wide API, whose runtime config may name a different
// saved model; using that one produced escalation/parking reasons about a model
// that never ran the task.
export function landingWorkerAt(level, { loopWorker, loopModels, config } = {}) {
  const models = loopModels !== undefined ? loopModels : config?.loop?.models;
  const worker = loopWorker !== undefined ? loopWorker : config?.loop?.worker;
  return workerForLevelMap(level, models)?.model ?? worker?.model ?? null;
}

export function loopWorkerProblem(worker) {
  if (!worker?.provider || canUseFlytTools(worker.provider)) return null;
  return `The ${worker.provider} adapter cannot work a Loop task: it is a sandboxed model-call delegate and cannot use Flyt's file and shell tools. Choose a tool-capable API model for the worker; it can still be used as the reviewer.`;
}
import { Supervisor, renderReport } from './supervisor.js';
import { reviewWorker } from './diffReview.js';
import { APPROVAL_MODES } from './stackRunner.js';
import { lintFlow } from './stacklang/lint.js';
import {
  loadSuite, runBenchmark, saveCard, listCards, readCard, recentCards,
  compareCards, renderScorecard, renderComparison, DEFAULT_SUITE_DIR
} from './benchmark.js';
import { writeArchive, listArchive, readArchive, trend, dateStamp } from './archive.js';
import { listIncidents, resolveIncident, damagedBy, clearDamaged } from './incidents.js';
import { assertRepoUrl, nameFromRepoUrl } from './references.js';
import { explainRun, probeModel, doctor, modelsInFlow } from './diagnostics.js';

// Is this pid still running? `kill(pid, 0)` sends no signal and only asks — the
// standard way, and the only one that needs no dependency. EPERM means the
// process exists and belongs to someone else, which still counts as alive.
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === 'EPERM'; }
}

/**
 * The last gate an ATTEMPT ran for itself, from its own run log.
 *
 * The attempt has `run_gate` available as a tool and is encouraged to use it.
 * When it runs the suite, sees a failure, and then stops — or worse, edits the
 * failing assertion until it passes — the landing's own gate run says nothing
 * about that, because by then the assertion accepts the wrong answer.
 *
 * Reads only the newest run, and never throws: a log that cannot be read is not
 * a reason to fail a landing.
 */
function lastWorkerGate(store, runIds) {
  const runId = Array.isArray(runIds) ? runIds[runIds.length - 1] : null;
  if (!store || !runId) return null;
  try {
    const gates = (store.readLog(runId) ?? []).filter(e => e.event === 'gate_run');
    const last = gates[gates.length - 1];
    return last ? { command: last.command, status: last.status, code: last.code ?? null } : null;
  } catch { return null; }
}

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
  /**
   * The runs in flight for this project, whoever is driving them.
   *
   * A loop in ANOTHER process is the normal case for a CLI reader, and its
   * status file names the runs — so spend can be answered honestly from a
   * terminal while the desktop app does the work.
   */
  const inFlightRuns = projectId => {
    const status = supervisors.get(projectId)?.status() ?? readLoopStatus(projectId);
    // The whole heartbeat, not just its run id: a live call belongs to a task
    // and a band, and only the heartbeat knows which. A breakdown that dropped
    // them would file every dollar being spent right now under "(none)".
    return (status?.inFlight ?? []).filter(h => h?.runId);
  };
  const inFlightRunIds = projectId => inFlightRuns(projectId).map(h => h.runId);

  const ledgerFor = projectId => {
    proj(projectId);
    const ledger = engine.ledgerFor(projectId);
    if (!ledger) throw new ApiError('This project has no folder, so it has nowhere to keep a ledger.',
      { status: 400, code: 'no_ledger' });
    return ledger;
  };
  // One chat store per project, beside the backlog. Same rule as everything
  // else the loop owns: it lives in the MAIN checkout's config dir, never in a
  // worktree (DESIGN-SPEC.md §8).
  const chats = new Map();
  const chatFor = projectId => {
    proj(projectId);
    let c = chats.get(projectId);
    if (c) return c;
    const dir = engine.configDirOf(projectId);
    if (!dir) {
      throw new ApiError('This project has no folder, so it has nowhere to keep a conversation.',
        { status: 400, code: 'no_chat' });
    }
    chats.set(projectId, c = new ChatStore(path.join(dir, 'chats')));
    return c;
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

  // --- the loop's status, on disk (DESIGN-SPEC.md §8) --------------------------
  //
  // The supervisor is a long-running process that outlives the window which
  // started it, so its status cannot live only in its own memory: `flyt loop
  // status` from a second terminal, `flyt report`, and the desktop app's Loop
  // view were all answering "no loop running" while one was working. For a
  // system whose entire premise is running when nobody is watching, being
  // invisible to everything except the terminal that started it is the wrong
  // shape.
  //
  // One file per project, rewritten on every transition and every poll.
  const loopStatusFile = projectId => {
    const dir = engine.configDirOf(projectId);
    return dir ? path.join(dir, 'loop-status.json') : null;
  };

  const writeLoopStatus = (projectId, status) => {
    const file = loopStatusFile(projectId);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename: a reader polling this file must never catch it
    // half-written, and JSON.parse of half a file is an error a status reader
    // would report as "the loop is broken".
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
    fs.renameSync(tmp, file);
  };

  // A status written by SOMEONE ELSE. Trusted for what it says, but never for
  // whether it is still true: a process that died mid-run leaves a file
  // claiming work is in flight, and a reader that believes it is worse off than
  // one with no file at all. So liveness is checked against the pid, and a
  // stale record is reported as stopped with the reason.
  const readLoopStatus = projectId => {
    const file = loopStatusFile(projectId);
    if (!file || !fs.existsSync(file)) return null;
    let status;
    try { status = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    const alive = status.pid != null && isProcessAlive(status.pid);
    if (status.running && !alive) {
      return {
        ...status, running: false, inFlight: [],
        stopping: `the process that was running it (pid ${status.pid}) is gone`,
        stale: true, observed: true
      };
    }
    return { ...status, observed: true };
  };

  // A stop asked for by a process that does not own the supervisor. Same
  // file-shaped answer as the status: the loop reads it once a tick, so the
  // app's Stop button and a second terminal both reach the running loop
  // wherever it is, and it winds down cleanly rather than being killed.
  const loopStopFile = projectId => {
    const dir = engine.configDirOf(projectId);
    return dir ? path.join(dir, 'loop-stop') : null;
  };

  const requestLoopStop = (projectId, reason) => {
    const file = loopStopFile(projectId);
    if (!file) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ reason, at: new Date().toISOString(), by: process.pid }));
    return true;
  };

  // Read once and consumed: a stop request left on disk would stop the NEXT
  // loop the moment it started, which is a confusing way to discover a file.
  const takeLoopStop = projectId => {
    const file = loopStopFile(projectId);
    if (!file || !fs.existsSync(file)) return null;
    let reason = 'stopped by request';
    try { reason = JSON.parse(fs.readFileSync(file, 'utf8')).reason ?? reason; } catch { /* keep the default */ }
    try { fs.rmSync(file); } catch { /* it will be read again and stop again, which is harmless */ }
    return reason;
  };

  // One supervisor per project, for the life of the process.
  const supervisors = new Map();
  // One in-flight chat turn per thread, so `chat:stop` has something to abort
  // and a second send cannot race the first into the same jsonl file.
  const chatRuns = new Map();

  /**
   * The model chat uses when the caller names none.
   *
   * In order: the choice this person already made and saved; then the band
   * models they picked for the loop, cheapest first, because those are the
   * models they have already decided they trust; then nothing — and "nothing"
   * is an honest error rather than a silent pick, since this is a chat box
   * wired to a paid API.
   */
  const chatWorkerDefault = () => {
    const saved = engine.settings?.chat?.worker;
    if (saved?.model) return saved;
    for (const band of LEVELS) {
      const model = runtimeConfig.loop?.models?.[band];
      if (model) return { provider: 'auto', model };
    }
    const loop = runtimeConfig.workers?.loop;
    return loop?.model ? { provider: loop.provider, model: loop.model } : null;
  };

  // What one turn cost, priced the same way every other line in the ledger is.
  const costFor = (usage, target) =>
    costOf({ usage, provider: target.provider, model: target.model, prices: runtimeConfig.loop?.prices ?? {} });

  // --- what the blocker model needs, without a caller having to assemble it --
  //
  // Both of these answer "what is the state of the world right now" for
  // core/blockers.js, and both must be TOTAL: a blocker list is a diagnosis,
  // and a diagnosis that throws because the ledger is missing is worse than one
  // that says nothing about money. So each degrades to null rather than up.
  const loopStatusOf = projectId => {
    try {
      return supervisors.get(projectId)?.status()
        ?? readLoopStatus(projectId)
        ?? { running: false, inFlight: [] };
    } catch { return { running: false, inFlight: [] }; }
  };
  const spendCheckOf = projectId => {
    try { return engine.ledgerFor(projectId)?.check({ caps: runtimeConfig.loop?.caps ?? {} }) ?? null; }
    catch { return null; }
  };
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

    // One tool, in full — schema included. `tool:list` returns summaries, and a
    // summary is not enough to CALL anything: an agent asked to add or fix a
    // tool needs the parameter schema, and reading it out of the source tree is
    // only possible for someone standing in this repository.
    'tool:show': ({ id }) => {
      const def = toolLibrary.get(id);
      if (!def) {
        throw new ApiError(`No tool "${id}". Known: ${toolLibrary.ids().join(', ')}.`,
          { status: 404, code: 'no_tool' });
      }
      const bound = getTools([def.id])[0] ?? null;
      // Whether the definition RESOLVED matters as much as what it says: a
      // file naming a built-in module this build does not ship is listed,
      // looks healthy, and cannot run.
      return { ...def, bound: Boolean(bound), ...(bound ? {} : { boundReason: registerDefinition(def).reason ?? 'not bound' }) };
    },

    /**
     * Call one tool, once, outside a run.
     *
     * The library has always been files you could read and never something you
     * could TRY. The only way to find out whether a tool worked was to pay for
     * a run and read the log afterwards, which is a bad loop for a human and an
     * impossible one for an agent asked to add a tool: it could write the
     * module, write the definition, and have no way to see the first result.
     *
     * Authority is not widened by this door (CLAUDE.md standing rules). A tool
     * whose effects mutate something outside the run — a write, a shell command
     * — is exactly what the per-call approval gate exists for, so calling one
     * from here requires `confirm: true` said out loud by the caller. Read-only
     * and network tools run straight through, which is what makes this useful
     * for the case it was built for.
     */
    'tool:run': async ({ projectId = null, id, args = {}, confirm = false }) => {
      const def = toolLibrary.get(id);
      if (!def) {
        throw new ApiError(`No tool "${id}". Known: ${toolLibrary.ids().join(', ')}.`,
          { status: 404, code: 'no_tool' });
      }
      if (!def.enabled) {
        throw new ApiError(`"${id}" is disabled in the tool library, so it cannot be called.`,
          { status: 400, code: 'tool_disabled' });
      }
      if (isDestructive(def) && confirm !== true) {
        throw new ApiError(
          `"${id}" ${describeEffects(def)} — that is what the approval gate exists for. Pass confirm:true (\`--yes\` on the CLI) to run it anyway.`,
          { status: 400, code: 'needs_confirm' });
      }
      const entry = projectId ? proj(projectId) : null;
      // The same ctx shape chat binds (§ 'chat:send'), minus the run store: with
      // no store the full result stays inline, which is the whole point of a
      // one-shot call. No `pool`, so nothing here can reach a worktree.
      const record = await executeTool(id, args ?? {}, {
        config: runtimeConfig,
        references: engine.references ?? null,
        ...(entry ? { backlog: engine.backlogFor(projectId) } : {}),
        ...(entry?.folder ? { workspace: new Workspace(entry.folder) } : {})
      });
      return record;
    },

    // Which tools the library holds but could not bind, and why. `flyt doctor`
    // reports providers and models; a definition that silently resolves to
    // nothing is the same class of problem and was invisible.
    'tool:problems': () => {
      const defs = toolLibrary.listFull();
      const unbound = defs
        .filter(d => d.enabled)
        .map(d => ({ id: d.id, ...registerDefinition(d) }))
        .filter(r => !r.ok)
        .map(({ id, reason }) => ({ id, reason }));
      return { files: toolLibrary.problems ?? [], unbound };
    },

    /**
     * Run a tool suite: the same fixed cases through several tools, measured.
     *
     * "Which one is better" deserves an answer somebody can argue with, and the
     * agent benchmark does not answer it — that one scores whether a TASK
     * landed, which is a different axis. This calls the tools and prints what
     * happened; every opinion in the result was written into the suite file.
     */
    'tool:bench': async ({ projectId = null, suite, confirm = false, onProgress = null }) => {
      const entry = projectId ? proj(projectId) : null;
      const file = path.isAbsolute(String(suite))
        ? String(suite)
        : path.join(engine.projectRoot, SUITE_DIR, String(suite).endsWith('.json') ? String(suite) : `${suite}.json`);
      const loaded = loadToolSuite(file);

      // Same posture as tool:run — a suite that names a write or shell tool is
      // a suite that runs one, and the caller says so or it does not run.
      const gated = loaded.tools.filter(t => isDestructive(toolLibrary.get(t.id) ?? {}));
      if (gated.length && confirm !== true) {
        throw new ApiError(
          `This suite calls ${gated.map(t => t.id).join(', ')}, which change things outside the call. Pass confirm:true (\`--yes\`) to run it.`,
          { status: 400, code: 'needs_confirm' });
      }

      const ctx = {
        config: runtimeConfig,
        references: engine.references ?? null,
        ...(entry ? { backlog: engine.backlogFor(projectId) } : {}),
        ...(entry?.folder ? { workspace: new Workspace(entry.folder) } : {})
      };
      return runToolSuite(loaded, {
        call: (id, args) => executeTool(id, args, ctx),
        onProgress: typeof onProgress === 'function' ? onProgress : () => {}
      });
    },

    'tool:suites': () => {
      const dir = path.join(engine.projectRoot, SUITE_DIR);
      let names;
      try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); }
      catch { return { dir, suites: [] }; }
      return {
        dir,
        suites: names.map(n => {
          try {
            const s = loadToolSuite(path.join(dir, n));
            return { file: n, name: s.name, description: s.description, cases: s.cases.length, tools: s.tools.map(t => t.as) };
          } catch (err) { return { file: n, error: String(err?.message ?? err) }; }
        })
      };
    },

    // --- The Python sidecar (core/python.js) -----------------------------------
    'python:status': ({ packages = [] }) => pythonStatus({
      userDataDir: engine.userDataDir,
      settings: engine.settings,
      packages: Array.isArray(packages) ? packages : String(packages).split(',').map(s => s.trim()).filter(Boolean)
    }),

    'python:setup': async ({ packages = [], python = null, log = null }) => {
      const list = Array.isArray(packages) ? packages : String(packages).split(',').map(s => s.trim()).filter(Boolean);
      const lines = [];
      const result = await setupPython({
        userDataDir: engine.userDataDir,
        packages: list,
        baseBin: python,
        log: line => { lines.push(line); if (typeof log === 'function') log(line); }
      });
      return { ...result, log: lines, status: await pythonStatus({ userDataDir: engine.userDataDir, settings: engine.settings, packages: list }) };
    },

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
    'flow:run': ({ projectId, flowId, userInput = '', workspaceDir = null, approvalMode = null, attended = null, launch = null, level = null, worker = null, loopTaskId = null, skills = null }) => {
      const entry = proj(projectId);
      let workspace = null;
      // An explicit workspaceDir WINS, even for a bound project. That is how the
      // supervisor points a run at the task's worktree instead of the main
      // checkout — without it the isolation is built and then bypassed, and
      // every task edits the repo the loop is merging into.
      if (workspaceDir) workspace = new Workspace(workspaceDir).ensure().root;
      else if (entry.folder) workspace = new Workspace(entry.folder).ensure().root;
      else if (entry.kind === 'appdata') workspace = new Workspace(entry.workspaceRoot).ensure().root;
      // launch (DECISIONS.md D27) carries the picked mode and any exposed
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
        compareGroup: launch?.compareGroup ?? null,
        // Which backlog task this run IS, when the supervisor started it. The
        // supervisor records that run's spend against the task when the task
        // ends, so the runner must not also record it as an unattributed flow
        // run — one call, one ledger line.
        loopTaskId,
        // Expertise the CALLER knows this run needs, on top of whatever the
        // flow's templates already attach (core/backlog.js `skills`). A backlog
        // task carries it because "this job needs to know how tools are
        // authored here" is a property of the job, not of the pipeline every
        // job runs through.
        skills: Array.isArray(skills) ? skills : null,
        // t-0084: did the caller promise somebody on the other end? Only
        // `flyt run` passes true today; the loop and scripted callers leave it
        // unset and the run stays unattended no matter its approvalMode.
        attended
      });
    },

    // The kernel path (t-0117). Same shape as flow:run, but the run is walked
    // by the production StackRunner over a v2 stack, with the session log and
    // the fs/tools/llm/approvals seams doing what the compat runner faked.
    // The supervisor tries this first and falls back to flow:run only when
    // the kernel cannot boot (unknown_command / kernel_unavailable), so a
    // project without a compiled kernel still runs the loop.
    'stack:run': async ({ projectId, stackId, input = '', workspaceDir = null, approvalMode = 'always', runId = null }) => {
      const entry = proj(projectId);
      const workspace = workspaceDir
        ? new Workspace(workspaceDir).ensure().root
        : entry.folder
          ? new Workspace(entry.folder).ensure().root
          : new Workspace(entry.workspaceRoot).ensure().root;
      // One kernel per project+worktree, memoized on the registry entry: the
      // session store and run projection inside it must not be doubled.
      const key = `loopKernel:${workspace}`;
      entry.kernelByWorktree ??= new Map();
      if (!entry.kernelByWorktree.has(key)) {
        const booted = await bootLoopKernel({
          runsRoot: entry.store.root,
          workspaceDir: workspace,
          approvalMode: APPROVAL_MODES.includes(approvalMode) ? approvalMode : 'always',
        });
        entry.kernelByWorktree.set(key, booted);
      }
      const { ctx } = entry.kernelByWorktree.get(key);
      const { runId: startedId } = await startStackRun({ ctx, stackId, input, runId });
      return startedId;
    },

    'stack:stop': async ({ projectId, runId, workspaceDir = null }) => {
      const entry = proj(projectId);
      const workspace = workspaceDir
        ? new Workspace(workspaceDir).ensure().root
        : entry.folder
          ? new Workspace(entry.folder).ensure().root
          : new Workspace(entry.workspaceRoot).ensure().root;
      const booted = entry.kernelByWorktree?.get(`loopKernel:${workspace}`);
      if (!booted) return { ok: false, error: 'not-live', message: `No kernel run ${runId} in this process.` };
      return stopStackRun(booted.ctx, runId);
    },

    'run:list': ({ projectId }) => proj(projectId).store.runSummaries(),
    'run:log': ({ projectId, runId }) => {
      const store = proj(projectId).store;
      const retired = store.runRetirement(runId);
      if (retired) return { retired: true, runId, ...retired };
      return store.readLog(runId);
    },

    // Fetching a snapshot re-baselines the caller's diff channel at the same
    // instant, so the rev it gets back is the one subsequent patches build on.
    'run:snapshot': ({ projectId, runId }) => {
      const entry = proj(projectId);
      const retired = entry.store.runRetirement(runId);
      if (retired) return { retired: true, runId, ...retired };
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

    // --- Backlog (DESIGN-SPEC.md §8) --------------------------------------------
    //
    // The supervisor owns these files, so every caller — CLI, HTTP, an agent's
    // enqueue_task — goes through one door. Nothing writes the directory
    // directly, which is what keeps the queue outside every worktree (§5.2).
    'task:add': ({ projectId, ...task }) => backlogFor(projectId).add(task),
    'task:list': ({ projectId, status = null }) => {
      const backlog = backlogFor(projectId);
      const tasks = backlog.list({ status });
      const problems = backlog.problems ?? [];
      // WHY each of them is not moving, in the same words the supervisor's
      // headline uses (DECISIONS.md D45). This used to be computed by
      // `backlog.blocked()`, reachable only through `task:ready`, which the
      // preload never exposed — so the one screen whose job is "what is stuck"
      // was the one caller that could not see it.
      //
      // A filtered list must still be judged against the WHOLE backlog: a
      // dependency that is not in `status` is still a dependency.
      const all = status ? backlog.list() : tasks;
      const ctx = {
        tasks: all, problems,
        config: runtimeConfig,
        settings: publicSettings(),
        status: loopStatusOf(projectId),
        spend: spendCheckOf(projectId),
        cwd: proj(projectId).folder ?? undefined
      };
      const blockers = Object.fromEntries(blockersAll(ctx));
      return {
        tasks,
        // Malformed files are reported rather than thrown past: one bad task
        // must not stop the loop working the other forty.
        problems,
        blockers,
        // What is wrong with the PROJECT rather than with any one task — a
        // banner, not the same badge on forty cards.
        boardBlockers: boardBlockers(ctx)
      };
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
    // Out of the queue for good. Parking a task that should never have been
    // written only moves it to the pile a person reads every morning; this is
    // the one that ends it. A claimed task is refused unless forced, because
    // something holds a lease and probably a worktree.
    'task:remove': ({ projectId, id, force = false }) => {
      const removed = backlogFor(projectId).remove(id, { force });
      if (!removed) throw new ApiError(`No task "${id}".`, { status: 404, code: 'no_task' });
      return {
        removed: removed.id, title: removed.title, status: removed.status,
        // Tasks that depended on this one and can no longer become ready.
        // Carried through so a caller says it at the moment of removal, which
        // is the only moment anyone is looking.
        stranded: removed.stranded ?? [],
        ...(removed.unreadable ? { unreadable: removed.unreadable } : {})
      };
    },
    // One rung up and back in the queue — or parked, when the ladder is spent.
    // The supervisor calls this on a failed attempt and on a stalled one (§11.4).
    // Parked with its evidence, not erased. A retirement moves the task file,
    // the retirement record, and its run folders into .flyt/archive/retired/;
    // a revival under the same id brings it back queued. A claimed task is
    // refused unless forced, for the same reason remove() refuses it.
    'task:retire': ({ projectId, id, reason, by = null, force = false }) => {
      const retired = backlogFor(projectId).retire(id, { reason, by, force });
      if (!retired) throw new ApiError(`No task "${id}".`, { status: 404, code: 'no_task' });
      return {
        retired: retired.id, title: retired.title, status: retired.status,
        // Tasks that depended on this one and can no longer become ready.
        stranded: retired.stranded ?? [],
        ...(retired.unreadable ? { unreadable: retired.unreadable } : {})
      };
    },
    // Put back what something that was not the task's fault took from it: the
    // rung it was walked up, the attempts it was charged, the block reason
    // describing work that never ran. `incident` resets everything one incident
    // damaged in a single call, which is the shape the need actually has — a
    // provider does not refuse one task, it refuses all of them.
    'task:reset': ({ projectId, id = null, incident = null, reason = null, keepWork = false }) => {
      const backlog = backlogFor(projectId);
      const root = engine.configDirOf(projectId);
      const ids = incident
        ? damagedBy(root, incident).map(d => d.taskId)
        : [].concat(id ?? []).map(String).filter(Boolean);
      if (!ids.length) {
        throw new ApiError(incident
          ? `Incident "${incident}" did not record any damaged task.`
          : 'Name a task to reset, or an incident to reset everything it damaged.',
        { status: 400, code: 'nothing_to_reset' });
      }
      const reset = [];
      for (const one of ids) {
        const out = backlog.reset(one, { reason: reason ?? (incident ? `incident ${incident}` : null), keepWork });
        if (out) reset.push({ id: out.id, level: out.level, was: out.before });
      }
      // The incident keeps its history and stops advertising a repair that has
      // now been done: a headline still offering `reset` for tasks already
      // reset is how a loud channel teaches people to ignore it.
      if (incident && reset.length) clearDamaged(root, incident, reset.map(r => r.id));
      return { reset, incident };
    },
    'incident:list': ({ projectId, open = false }) =>
      ({ incidents: listIncidents(engine.configDirOf(projectId), { includeResolved: !open }) }),
    'incident:resolve': ({ projectId, id, by = 'human' }) => {
      const out = resolveIncident(engine.configDirOf(projectId), id, { by });
      if (!out) throw new ApiError(`No incident "${id}".`, { status: 404, code: 'no_incident' });
      return out;
    },
    'task:revive': ({ projectId, id }) => {
      const revived = backlogFor(projectId).revive(id);
      if (!revived) throw new ApiError(`No retired task "${id}".`, { status: 404, code: 'no_task' });
      return revived;
    },
    'task:escalate': ({ projectId, id, reason = 'failed', note = '' }) =>
      backlogFor(projectId).escalate(id, { reason, note }),
    'task:levels': () => ({ levels: LEVELS }),

    // --- Chat (DECISIONS.md D45) ------------------------------------------------
    //
    // ONE agent turn loop over a read-mostly toolset whose single write is
    // enqueue_task. It is deliberately NOT a second orchestrator: everything
    // expensive still goes through the loop, in a worktree, behind gates, with
    // a reviewer. The toolset (core/chat.js CHAT_TOOLS) is what enforces that —
    // not the system prompt, which a model can be talked out of.
    'chat:threads': ({ projectId }) => {
      const store = chatFor(projectId);
      return { threads: store.threads(), problems: store.problems ?? [] };
    },
    'chat:read': ({ projectId, threadId }) => ({ turns: chatFor(projectId).read(threadId) }),
    'chat:new': ({ projectId }) => ({ threadId: chatFor(projectId).newThreadId() }),
    'chat:delete': ({ projectId, threadId }) => ({ removed: chatFor(projectId).remove(threadId) }),
    'chat:stop': ({ projectId, threadId }) => {
      const ctl = chatRuns.get(`${projectId}:${threadId}`);
      if (!ctl) return { stopped: false, reason: 'nothing running' };
      ctl.abort();
      return { stopped: true };
    },
    'chat:send': async ({ projectId, threadId, text, worker = null }) => {
      const key = `${projectId}:${threadId}`;
      if (chatRuns.has(key)) {
        throw new ApiError('That thread is already answering. Stop it first.',
          { status: 409, code: 'chat_busy' });
      }
      const entry = proj(projectId);
      const store = chatFor(projectId);
      const backlog = backlogFor(projectId);
      const tasks = backlog.list();
      // The same context the board reads, so the chat's answer to "why is
      // t-0008 blocked" and the card's sentence cannot disagree.
      const blockerCtx = {
        tasks, problems: backlog.problems ?? [],
        config: runtimeConfig, settings: publicSettings(),
        status: loopStatusOf(projectId), spend: spendCheckOf(projectId),
        cwd: entry.folder ?? undefined
      };
      // The picked worker, or the band the user already trusts, or nothing —
      // in which case say so rather than silently calling something they did
      // not choose.
      const target = resolveWorkerArg(worker ?? chatWorkerDefault(), { withKey: true });
      if (!target) {
        throw new ApiError('No model is set for chat. Pick one beside the send button.',
          { status: 400, code: 'no_worker' });
      }
      const ctl = new AbortController();
      chatRuns.set(key, ctl);
      try {
        return await runChatTurn({
          store, threadId, text, projectName: entry.name ?? null,
          worker: { provider: target.provider, model: target.model },
          apiKey: target.apiKey ?? null,
          tasks, blockerCtx,
          // The tool ctx. `backlog` is what makes list_tasks/read_task/
          // why_blocked/enqueue_task work; `workspace` is what read_file and
          // glob act on. No `pool`, so nothing here can reach a worktree.
          toolCtx: {
            backlog,
            references: engine.references ?? null,
            config: runtimeConfig,
            ...(entry.folder ? { workspace: new Workspace(entry.folder) } : {})
          },
          signal: ctl.signal,
          timeout: runtimeConfig.timeout,
          retry: runtimeConfig.retry,
          onText: chunk => engine.emitChat?.(projectId, { kind: 'text', threadId, text: chunk }),
          onEvent: ev => engine.emitChat?.(projectId, ev)
        });
      } finally {
        chatRuns.delete(key);
        // Chat spend rides the SAME ledger as everything else, tagged so it can
        // be told apart. Money spent in a text box is still money, and a burn
        // bar that omits it is the one that is lowest exactly when someone has
        // been chatting all afternoon.
        try {
          const last = store.read(threadId).at(-1);
          const ledger = engine.ledgerFor(projectId);
          if (ledger && last?.usage) {
            ledger.record({
              source: 'chat', threadId, node: 'chat',
              provider: target.provider, model: target.model, usage: last.usage,
              ...costFor(last.usage, target)
            });
          }
        } catch { /* an unwritable ledger must never fail a turn that succeeded */ }
      }
    },
    'chat:tools': () => ({ tools: CHAT_TOOLS }),

    // --- Tool feedback (DESIGN-SPEC.md §8) -------------------------------------
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

    // --- Isolation and landing (DESIGN-SPEC.md §8) ---------------------------
    //
    // The supervisor will drive these in sequence; exposing them as commands
    // means the same steps are drivable by hand, by the CLI and (later) by the
    // loop, without a second implementation of any of it.
    'work:start': async ({ projectId, taskId, runId = null }) => {
      const backlog = backlogFor(projectId);
      const task = backlog.get(taskId);
      if (!task) throw new ApiError(`No task "${taskId}".`, { status: 404, code: 'no_task' });
      const pool = poolFor(projectId);
      // A leftover tree from a crashed attempt must not wedge the task forever.
      // A failed attempt is thrown away by deleting a directory (§6.1), so
      // finding one here usually means nobody got to throw it away — and the
      // right answer is to start clean from the current base.
      //
      // "Usually", not "always": `reclaim` refuses to clear a slot whose owner
      // is still ALIVE, and says who holds it. Deleting a live attempt's tree
      // is how in-progress work disappears (WR-02), and a start that collides
      // with a running attempt is a scheduling bug to report, not a directory
      // to remove.
      const cleared = await pool.reclaim(taskId);
      if (cleared.outcome === 'live-owner') {
        throw new ApiError(
          `Task "${taskId}" already has a live attempt (${cleared.owner}`
          + `${cleared.runId ? `, run ${cleared.runId}` : ''}). Stop or discard it before starting another.`,
          { status: 409, code: 'attempt_live' });
      }
      // Start from the last reviewed commit when there is one (see work:land):
      // a reviewer's objection is a correction, not a reason to rebuild. The sha
      // is verified before it is trusted — a branch that has been gc'd or a
      // repository that has moved on must degrade to the base branch, not fail
      // the attempt.
      let base = null;
      if (task.resumeFrom) {
        try {
          await git(['cat-file', '-e', `${task.resumeFrom}^{commit}`], { cwd: pool.repoRoot });
          base = task.resumeFrom;
        } catch {
          backlog.update(taskId, { resumeFrom: null });
        }
      }
      const wt = await pool.create(taskId, task.title, { projectId, runId, base });
      backlog.update(taskId, { status: 'running', attemptId: wt.attemptId, ...(base ? { resumedFrom: base } : {}) });
      return { ...wt, ...(base ? { resumedFrom: base } : {}) };
    },
    // Keep a live attempt's ownership record fresh (WR-02). Without a beat, a
    // genuinely long task looks abandoned to the next `work:start`, which is
    // the failure mode this whole mechanism exists to prevent — so the loop
    // says "still mine" on every tick.
    'work:touch': ({ projectId, taskId, attemptId }) =>
      ({ touched: poolFor(projectId).touchAttempt(taskId, attemptId) }),
    // Owner records and worktrees that no longer belong together. Reported,
    // never auto-deleted: "remove this directory" is precisely the decision
    // that must not be guessed at.
    'work:reconcile': ({ projectId }) => ({ orphans: poolFor(projectId).reconcile() }),
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
    'work:discard': async ({ projectId, taskId, status = 'queued', attemptId = null }) => {
      // `attemptId` is what stops a late cleanup from deleting the NEXT
      // attempt's worktree (WR-02). Callers that know which attempt they are
      // discarding must say so; the outcome comes back either way, so a
      // mismatch is visible rather than silently successful.
      const pool = poolFor(projectId);
      const result = await pool.remove(taskId, { deleteBranch: true, attemptId });
      // A cleanup that touched nothing because somebody else owns the path must
      // not drop that owner's lease along with it.
      if (result.outcome !== 'owner-mismatch' && result.outcome !== 'live-owner') {
        backlogFor(projectId).release(taskId, { status });
      }
      return { removed: result.outcome === 'removed', ...result };
    },
    // The whole sequence: gates → mechanical checks → review → merge → canary.
    // Every outcome that is not "landed" carries guidance, because a task that
    // fails without telling the next attempt why is just re-rolling dice.
    'work:land': async ({
      projectId, taskId, dryRun = false, push = null, baselineOutput = null,
      reviewer = null, attemptId = null, onStage = null,
      loopWorker, loopModels
    }) => {
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
      // The LAST gate this attempt ran itself, from its own run log. The
      // landing re-runs the gates and sees only its own result, so an attempt
      // that ran the suite, saw it fail, and stopped anyway is invisible from
      // here — which is exactly what t-0103 did before it widened the failing
      // assertion to make it pass.
      const workerGate = lastWorkerGate(proj(projectId).store, task.runIds);
      // A roll-up task's dependency work is already in `base`, so it cannot
      // appear in this task's incremental diff. Give the reviewer the contracts
      // that made the task ready and the harness-attested landing state rather
      // than asking it to infer five prior merges from their absence.
      const dependencyEvidence = (task.dependsOn ?? []).map(id => backlog.get(id))
        .filter(Boolean)
        .map(dependency => ({
          id: dependency.id, title: dependency.title, status: dependency.status,
          body: dependency.body,
        }));
      const result = await landTask({
        pool, repoRoot: entry.folder, taskId, task, base, dryRun, baselineOutput,
        config, workerGate, dependencyEvidence,
        onStage: typeof onStage === 'function' ? onStage : undefined,
        push: wantPush ? (args => pushRefs({ ...args, log: () => {} })) : null,
        // The canary: the gates again, on the merged result in the main
        // checkout. Two branches that each pass alone can fail together.
        verify: async ({ repoRoot: canaryRoot = entry.folder } = {}) =>
          verifyTask({ pool: { dirFor: () => canaryRoot }, taskId, task })
      });
      if (result.landed) {
        backlog.update(taskId, {
          status: 'landed', attempts: (task.attempts ?? 0) + 1, blockedReason: null,
          // The correction record dies with the work it was about. Left behind,
          // it would make the NEXT task to reuse this id look mid-correction.
          repairs: 0, failureSignature: null, failureCount: null, resumeStage: null
        });
      } else {
        // A failed attempt goes back up a rung rather than back at the same
        // band: retrying the same capability mostly reproduces the same answer.
        // At the top of the ladder the task parks for a human instead.
        // The rung has to be a real one. With models named per band the map
        // fills downward, so a map naming one band answers for all five and
        // every rung is the same model — four more attempts by the same
        // worker, announced as more capability.
        const workerAt = level => landingWorkerAt(level, { loopWorker, loopModels, config });
        // The REVIEWER failing is not the work failing.
        //
        // `reviewDiff` already distinguishes the two: `unavailable` means the
        // reviewer could not be reached, or answered with nothing this could
        // parse, as against reading the diff and objecting to it. Both arrive
        // here as `stage: 'review'`, and both used to spend a rung.
        //
        // Watched it: "review: The reviewer returned no usable verdict block."
        // and the task went from medium to high — a band bought with a
        // reviewer's malformed answer, and the dearer model then produced the
        // same diff for a reviewer that might garble it again.
        //
        // So the attempt goes back at the SAME band with its work preserved.
        // The attempt is still counted: a review that can never be completed
        // has to reach a person eventually, and the attempt count is what gets
        // it there.
        const reviewerFailed = result.stage === 'review' && result.review?.unavailable === true;
        // A RED GATE OVER REAL WORK IS A CORRECTION, NOT A FAILED ATTEMPT.
        //
        // This is the case the whole ladder used to swallow. A task spent forty
        // calls and a dollar fifty, `npm test` exited 1 over one stale
        // assertion, and the loop moved the task up a band — where a dearer
        // model re-read the same repository and wrote the same thing again.
        // The rung bought nothing, because more capability was never what was
        // missing; the failing test's name was.
        //
        // `assessRepair` has already decided whether there is work here worth
        // correcting (core/repair.js). When there is, the attempt goes back at
        // the SAME band with its commit and the failures attached. The attempt
        // is still counted — money was spent, and the per-task cap has to see
        // it — but no rung is, and `repairs` is what bounds it.
        const repair = result.stage === 'gates' && result.repair?.verdict === 'repair'
          ? result.repair : null;
        if (repair) {
          backlog.update(taskId, correctionFields(task, repair));
        } else if (reviewerFailed) {
          backlog.update(taskId, {
            status: 'queued',
            attempts: (task.attempts ?? 0) + 1,
            blockedReason: `The reviewer could not judge the last attempt: ${result.guidance ?? 'no verdict'}`
              + ' The work itself was not rejected — the same band gets another go at being reviewed.'
          });
        } else {
          backlog.escalate(taskId, { reason: 'failed', note: result.guidance ?? result.stage, workerAt });
        }
        // Where the next attempt should start.
        //
        // A rejection at REVIEW or at GATES is a correction case: something
        // specific is wrong with work that otherwise exists, and the objection
        // travels with the task either way — a reviewer's sentence, or the
        // assertion the suite named. Rebuilding from the base branch throws
        // away everything nobody objected to and pays a dearer model to write
        // it again; two tasks arrived with the module written, the tool
        // registered and one pinned test list not updated, and both were
        // discarded whole.
        //
        // NOT for an empty diff or a stalled attempt: there is nothing there
        // worth inheriting, and inheriting nothing is just a slower fresh
        // start. Cleared on every other outcome so a stale sha can never be
        // resumed from.
        const correctable = result.stage === 'review' || result.stage === 'gates';
        const keeping = correctable && result.attemptCommit;
        backlog.update(taskId, {
          resumeFrom: keeping ? result.attemptCommit : null,
          // Which judgement the next attempt is inheriting. Without it the brief
          // told every resumed attempt that its gates had passed and a reviewer
          // had objected — true after a review, and exactly backwards after a
          // red gate.
          resumeStage: keeping ? result.stage : null,
          // The correction record belongs to the work. When the work is not
          // being inherited there is nothing for the next attempt's failures to
          // be compared against, and a stale fingerprint would make its first
          // gate failure look like a repeat.
          ...(keeping ? {} : { repairs: 0, failureSignature: null, failureCount: null })
        });
      }
      // Landed: this attempt's tree is finished with. Scoped to the attempt
      // that produced the merge, so a slow landing cannot clean up after a
      // restart that has already begun.
      if (result.landed) await pool.remove(taskId, { deleteBranch: false, attemptId: attemptId ?? pool.owner(taskId)?.attemptId ?? null });
      return result;
    },

    // --- The loop (DESIGN-SPEC.md §8) ---------------------------------
    //
    // One supervisor per project, held here for the life of the process: it is
    // the thing that outlives a closed window, and starting a second one over
    // the same backlog would have two pickers racing for the same tasks.
    'loop:start': async ({
      projectId, parallelism = 1, maxTasks = null, dryRun = false,
      worker = null, reviewer = null, models = null, caps = null, only = null
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
      const byLevel = loopLaunchModels({
        worker,
        models,
        configuredModels: runtimeConfig.loop?.models,
      });
      // Only the caps actually named: an absent one keeps the project's, and a
      // zero is a real ceiling ("spend nothing more"), not an absent one.
      const sessionCaps = Object.fromEntries(
        ['taskUsd', 'softUsd', 'hardUsd']
          .map(k => [k, Number(caps?.[k])])
          .filter(([, v]) => Number.isFinite(v) && v >= 0));
      let pinned, sessionReviewer;
      try {
        pinned = resolveWorkerArg(worker) ?? resolveWorkerArg(runtimeConfig.workers?.loop);
        sessionReviewer = resolveWorkerArg(reviewer, { withKey: true });
        // Every model in the map is checked now, not when a task first escalates
        // into it — an unroutable model at `max` is a failure that would
        // otherwise surface hours later, on the task that most needed to work.
        for (const [band, id] of Object.entries(byLevel)) {
          const w = resolveWorkerArg({ provider: 'auto', model: id });
          const capabilityProblem = loopWorkerProblem(w);
          if (capabilityProblem) {
            throw new ApiError(`The "${band}" band is set to "${id}". ${capabilityProblem}`,
              { status: 400, code: 'worker_cannot_use_tools' });
          }
          if (w && w.provider !== 'mock' && !engine.hasKey(w.provider)) {
            throw new Error(`The "${band}" band is set to "${id}", but its provider (${w.provider}) is not connected.`);
          }
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(String(err?.message ?? err), { status: 400, code: 'no_provider_key' });
      }
      if (Object.keys(byLevel).length) pinned = null; // the map answers per attempt
      // Fail once, here, rather than per task. Levels route through
      // OpenRouter's Auto Router (§8), so without a key every task would fail
      // at its first node with a provider error and the whole backlog would
      // end the night parked for a reason that has nothing to do with the work.
      const useLevels = runtimeConfig.loop?.levels !== false && !pinned && !Object.keys(byLevel).length;
      // With levels disabled and no Loop-specific pin, Supervisor passes no
      // worker override to the flow. The authored work node then takes the
      // configured executor default. It is just as real a launch choice as an
      // explicit --model and must be preflighted before the queue is touched.
      const defaultWorker = !useLevels && !pinned && !Object.keys(byLevel).length
        ? resolveWorkerArg(runtimeConfig.workers?.executor)
        : null;
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
      if (defaultWorker && defaultWorker.provider !== 'mock' && !engine.hasKey(defaultWorker.provider)) {
        throw new ApiError(
          `The loop's default worker is "${defaultWorker.model}", but its provider (${defaultWorker.provider}) is not connected. Add a key in Settings, or choose another model.`,
          { status: 400, code: 'no_provider_key' });
      }
      // A connected subscription account can still reject a catalog id. When
      // the host supplies a bounded preflight, validate every explicit choice
      // before Supervisor is created (and therefore before any task is taken).
      if (engine.capabilityProbe) {
        const checks = [];
        if (pinned) checks.push({ provider: pinned.provider, model: pinned.model });
        if (defaultWorker) checks.push({
          provider: defaultWorker.provider, model: defaultWorker.model, defaultWorker: true
        });
        for (const [band, id] of Object.entries(byLevel)) {
          const w = resolveWorkerArg({ provider: 'auto', model: id });
          if (w) checks.push({ provider: w.provider, model: id, band });
        }
        // The reviewer is the most common subscription CLI in a Loop session.
        // Validate it now too; finding out after a worker has changed the repo
        // is precisely the late failure this preflight exists to prevent.
        const selectedReviewer = sessionReviewer ?? reviewWorker(runtimeConfig);
        if (selectedReviewer) checks.push({
          provider: selectedReviewer.provider, model: selectedReviewer.model, reviewer: true
        });
        const uniqueChecks = [...new Map(checks.map(target => [
          `${target.provider}:${target.model}`, target
        ])).values()];
        for (const target of uniqueChecks) {
          if (!SUBSCRIPTION_PROVIDERS.includes(target.provider)) continue;
          const result = await engine.capabilityCache.check(
            `${target.provider}:${target.model}`,
            () => engine.capabilityProbe({ provider: target.provider, model: target.model }));
          if (result.status === 'unsupported') {
            const role = target.reviewer ? 'reviewer ' : target.defaultWorker ? 'default worker ' : '';
            throw new ApiError(
              `The configured ${target.provider} ${role}model "${target.model}" is not usable by this signed-in account. ` +
              `Choose a supported model in Settings, run "flyt call subscription:refresh", or set an explicit manual model override.`,
              { status: 400, code: 'model_unsupported' });
          }
          if (result.status === 'unknown') {
            throw new ApiError(
              `Could not confirm that the configured ${target.provider} model "${target.model}" is usable. ` +
              `Run "flyt call subscription:refresh" and try again, or set an explicit manual model override.`,
              { status: 503, code: 'model_capability_unknown' });
          }
        }
      }
      const pinnedCapabilityProblem = loopWorkerProblem(pinned);
      if (pinnedCapabilityProblem) {
        throw new ApiError(pinnedCapabilityProblem, { status: 400, code: 'worker_cannot_use_tools' });
      }
      const defaultCapabilityProblem = loopWorkerProblem(defaultWorker);
      if (defaultCapabilityProblem) {
        throw new ApiError(defaultCapabilityProblem, { status: 400, code: 'worker_cannot_use_tools' });
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
      // ...and one running in ANOTHER process counts. This guard was per
      // process, which was harmless while a loop was invisible outside its own:
      // now that the status is published, the desktop app can SEE a loop
      // started from a terminal, and the obvious next thing a person does is
      // press Start. Two supervisors over one backlog is two pickers racing for
      // the same tasks — the exact thing "one supervisor per project" exists to
      // prevent. A dead writer's file does not count, which readLoopStatus has
      // already decided by checking the pid.
      const elsewhere = readLoopStatus(projectId);
      if (elsewhere?.running) {
        throw new ApiError(
          `A loop is already working this backlog in another process (pid ${elsewhere.pid}). Stop that one first, or watch it here.`,
          { status: 409, code: 'already_running' });
      }
      // Startup reconciliation (WR-02): a previous process that died mid-attempt
      // leaves owner records with no worktree, worktrees with no record, or
      // trees whose attempt never released. Reported into the loop log so a
      // watcher sees them, never auto-deleted — `flyt work reconcile` lists
      // them and a person decides. A pool that cannot be built (not a repo)
      // simply has nothing to reconcile.
      try {
        await releaseDeadOwners({
          pool: poolFor(projectId),
          backlog: backlogFor(projectId),
          log: line => engine.emitLoop?.(projectId, line)
        });
      } catch { /* no pool: nothing to reconcile */ }

      const sup = new Supervisor({
        invoke, projectId,
        // Where an incident is recorded, so that a provider refusal outlives
        // the process that met it (core/incidents.js).
        stateRoot: engine.configDirOf(projectId) ?? null,
        backlog: backlogFor(projectId),
        ledger: ledgerFor(projectId),
        store: proj(projectId).store,
        config: {
          ...runtimeConfig,
          workers: sessionReviewer
            ? { ...runtimeConfig.workers, reviewer: sessionReviewer }
            : runtimeConfig.workers,
          // A ceiling for THIS session, over whatever the project configured.
          // The same reason the reviewer and the band models are nameable at the
          // call: the machine starting an unattended loop is often not the
          // machine whose config holds the answer, and "how much may this cost"
          // is the one question you want answered before you walk away — not
          // after, in a ledger.
          loop: {
            ...runtimeConfig.loop, dryRun, worker: pinned, models: byLevel,
            caps: { ...(runtimeConfig.loop?.caps ?? {}), ...sessionCaps },
            // Kept apart from the merged map on purpose: a cap named HERE is
            // this session's ceiling and is measured from the moment the loop
            // starts, while a cap in the project's config guards a rolling
            // window. Merging them lost that distinction, and a session cap
            // measured over the project's window is a loop that refuses to
            // start over money it did not spend.
            sessionCaps
          }
        },
        parallelism,
        // Work only these tasks this session (the picker's order is unchanged).
        only: Array.isArray(only) ? only.map(String).filter(Boolean) : null,
        log: (msg, meta) => engine.emitLoop?.(projectId, msg, meta),
        writeStatus: status => writeLoopStatus(projectId, status),
        stopRequested: () => takeLoopStop(projectId)
      });
      // Anything left over from a previous loop is not a request to stop this
      // one before it has done anything.
      takeLoopStop(projectId);
      supervisors.set(projectId, sup);
      // Deliberately NOT awaited: the loop runs until it is stopped or capped,
      // and the caller gets an acknowledgement rather than a connection held
      // open for the length of a working day.
      sup.run({ maxTasks: maxTasks ?? Infinity }).catch(err => engine.emitLoop?.(projectId, `loop failed: ${err.message}`));
      return {
        started: true, parallelism, levels: useLevels,
        ...(sup.only ? { only: sup.only } : {}),
        model: pinned?.model ?? null,
        models: byLevel,
        reviewer: (sessionReviewer ?? reviewWorker(runtimeConfig))?.model ?? null,
        // What it may spend, said back at the moment you walk away from it.
        caps: sup.config.loop.caps
      };
    },
    'loop:stop': ({ projectId, reason = 'stopped by request' }) => {
      const sup = supervisors.get(projectId);
      if (sup) { sup.stop(reason); return { stopped: true, reason }; }
      // Not ours. If one is running elsewhere, ask it — the loop reads the
      // request once a tick and winds down the way a local stop does. Killing
      // the process instead would leave a worktree, a claimed task and a
      // half-landed merge behind, which is the thing this sequence exists to
      // avoid.
      const elsewhere = readLoopStatus(projectId);
      if (elsewhere?.running && requestLoopStop(projectId, reason)) {
        return { stopped: false, requested: true, pid: elsewhere.pid, reason };
      }
      return { stopped: false, reason: 'no loop running' };
    },
    // The loop's own account, read back after the process that wrote it is
    // gone. `date` and `taskId` are how the morning question gets asked:
    // "what happened to t-0014 last night".
    'loop:log': ({ projectId, date = null, taskId = null, tail = null }) =>
      engine.loopLog(projectId, {
        date: date ? String(date) : null,
        taskId: taskId ? String(taskId) : null,
        ...(Number.isFinite(Number(tail)) && Number(tail) > 0 ? { tail: Number(tail) } : {})
      }),
    'loop:days': ({ projectId }) => engine.loopLogFor(projectId)?.days() ?? [],
    // This process's supervisor if it has one; otherwise whatever the loop
    // running elsewhere last published. `observed: true` marks the second case,
    // because "what I am doing" and "what I can see someone else doing" are
    // different claims and a panel should be able to say which it is showing.
    'loop:status': ({ projectId }) => supervisors.get(projectId)?.status()
      ?? readLoopStatus(projectId)
      ?? { running: false, stopping: null, inFlight: [], parked: [], completed: 0, landed: 0, model: null },
    'loop:report': ({ projectId }) => renderReport({
      // The same three-way answer `loop:status` gives: mine, someone else's, or
      // none. A morning report that says "stopped, 0 landed" about a loop that
      // has been working all night is the one thing this document must not do.
      status: supervisors.get(projectId)?.status()
        ?? readLoopStatus(projectId)
        ?? { running: false, stopping: null, inFlight: [], landed: 0, completed: 0 },
      backlog: backlogFor(projectId),
      ledger: ledgerFor(projectId),
      loopLog: engine.loopLogFor(projectId),
      store: proj(projectId).store
    }),

    // --- The benchmark and the archive (DESIGN-SPEC.md §8) --------------------
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
          backlog, ledger, loopLog: engine.loopLogFor(projectId)
        }),
        log: (msg, meta) => engine.emitLoop?.(projectId, msg, meta)
      });
    },
    'archive:list': ({ projectId }) => listArchive(stateDir(projectId, 'archive')),
    'archive:read': ({ projectId, date }) => {
      const found = readArchive(stateDir(projectId, 'archive'), date);
      if (!found) throw new ApiError(`Nothing archived for ${date}.`, { status: 404, code: 'no_archive' });
      return found;
    },
    'archive:trend': ({ projectId, limit = 30 }) => trend(stateDir(projectId, 'archive'), { limit }),

    // --- Spend (DESIGN-SPEC.md §8) ----------------------------------------------
    // Settled spend PLUS what the runs in flight have already cost. A person
    // asking what a running loop is costing was getting the last settled
    // total, which is $0 for the whole first attempt of a session.
    'ledger:totals': ({ projectId, sinceMs = null, taskId = null }) =>
      totalsWithLive(ledgerFor(projectId), { sinceMs, taskId },
        { store: proj(projectId).store, runIds: inFlightRunIds(projectId) }),
    'ledger:check': ({ projectId, taskId = null }) =>
      ledgerFor(projectId).check({ caps: runtimeConfig.loop?.caps ?? {}, taskId }),

    /**
     * Where the money went.
     *
     * The totals above answer "may I keep going". This answers "what should I
     * stop doing", which is the question anyone watching a budget actually has
     * — and the ledger has been able to answer it since the first line was
     * written, because every line already carries the task, the run, the node,
     * the band and the model. Nothing read them.
     *
     * In-flight calls are included on the same terms as everywhere else: what
     * is being spent right now belongs in the answer, marked as live so a
     * reader can tell a receipt from a running meter.
     */
    'ledger:breakdown': ({ projectId, sinceMs = null, taskId = null, by = 'task', limit = null }) => {
      const ledger = ledgerFor(projectId);
      const settled = ledger.entries({ sinceMs });
      const live = liveEntries(proj(projectId).store, inFlightRuns(projectId), { prices: ledger.prices });
      const all = [...settled, ...live].filter(e => !taskId || e.taskId === taskId);
      return {
        by,
        rows: breakdown(all, { by, limit }),
        total: all.reduce((t, e) => ({
          usd: Number((t.usd + (typeof e.usd === 'number' ? e.usd : 0)).toFixed(6)),
          calls: t.calls + 1,
          unknown: t.unknown + (typeof e.usd === 'number' ? 0 : 1),
          estimated: t.estimated + (typeof e.usd === 'number' && e.estimated ? 1 : 0),
          live: Number((t.live + (e.live && typeof e.usd === 'number' ? e.usd : 0)).toFixed(6))
        }), { usd: 0, calls: 0, unknown: 0, estimated: 0, live: 0 })
      };
    },

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

    'subscription:refresh': () => {
      // Capability results are process-local and credential-free. Clearing them
      // also resets the bounded probe window so an operator can retry after a
      // sign-in, CLI update, or account/model change.
      engine.capabilityCache?.clear();
      return { refreshed: true };
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
        project = {
          id: p.id ?? projectId, folder: p.folder ?? null, runsDir: p.store.rootDir,
          // So an open incident can lead the findings (core/incidents.js).
          stateRoot: engine.configDirOf(projectId) ?? null,
        };
      } catch { /* no project bound — the rest of the report still stands */ }
      return doctor(engine, { probe, models: list, project });
    },

    // --- The reference library (DESIGN-SPEC.md §8) ------------------------------
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
