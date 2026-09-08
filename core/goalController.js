// Durable orchestration above RunController. Every setup, recipe and candidate
// execution is an ordinary canonical workflow; no block scheduler lives here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import Ajv from 'ajv';
import { bootKernel } from './v2.js';
import { serializeStack } from './stackstore.js';
import { goalFolder, goalRequirements, validateRequiredPaths } from './goalRequirements.js';
import { readSessionLogFile } from '#kernel';
import { acquireOwner, ownerAlive, readOwner, writeAtomic, abortable, bounded as waitBounded } from './executionOwnership.js';

const clone = value => structuredClone(value);
const id = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safe = value => {
  if (!/^[\w-]+$/.test(String(value))) throw new Error('Invalid goal or record ID');
  return String(value);
};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// Recover only one complete, JSON-escaped candidate string. Arbitrary prose,
// ambiguous candidates and workflow source are never guessed into a result.
function repairableCandidateText(output) {
  const matches = [...String(output).matchAll(/"candidate"\s*:\s*\{\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")/g)];
  if (matches.length !== 1) return null;
  try { const text = JSON.parse(matches[0][1]); return text.length <= 24000 ? text : null; } catch { return null; }
}
const FORMAT_RECIPE = serializeStack({ id: 'goal-result-format', name: 'Repair result formatting', root: {
  kind: 'sequence', id: 'root', children: [{ kind: 'block', id: 'format-result', use: 'flyt-blocks-core:general-analysis',
    config: { inputOnly: true, maxTokens: 16384,
      systemPrompt: 'You repair JSON formatting only. STEP INPUT contains an already completed candidate as one JSON string. Return exactly {"candidate":{"text":<that exact string>}}. Preserve every character of the decoded string. Do not do the original task, add facts, satisfy checks, propose changes, or use tools. No prose or code fences.' },
  }],
} });
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${id()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}
function immutable(file, value, exclusive = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${id()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
  try {
    // Linking a fully written sibling is atomic and refuses replacement, even
    // when two independent callers passed the same revision check.
    fs.linkSync(temporary, file);
    return value;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (exclusive) throw new Error('Stale recipe revision: another edit already committed this version');
    return read(file);
  } finally { fs.unlinkSync(temporary); }
}
const terminal = new Set(['achieved', 'limit_reached', 'plateau', 'needs_input', 'failed', 'stopped']);
export function validateGoalTools(tools) {
  if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string')) throw new Error('Tools must be a list');
  const forbidden = tools.filter(tool => /task|reference|run_log|read_run|other_run|agent|workflow|goal/i.test(tool));
  if (forbidden.length) throw new Error(`Goal tools cannot enqueue work or read unrelated runs/references. Remove unavailable tools: ${forbidden.join(', ')}`);
}
export function parseGoalReply(output) {
  try { return JSON.parse(output.trim()); } catch { /* tolerate one explicitly delimited JSON artifact */ }
  const fences = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fences.length !== 1 || /[{}\[\]]/.test(output.replace(fences[0][0], ''))) return null;
  try { return JSON.parse(fences[0][1].trim()); } catch { return null; }
}
const bounded = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must contain 1–${max} characters`);
  return value;
};
function within(root, relative) {
  if (path.isAbsolute(relative)) throw new Error('Paths must be relative to the goal workspace');
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Path escapes goal workspace');
  let existing = target;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  if (fs.existsSync(existing)) {
    const real = fs.realpathSync(existing);
    const actual = path.relative(root, real);
    if (actual === '..' || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual)) throw new Error('Link escapes goal workspace');
  }
  return target;
}
function identity(folder) {
  const stat = fs.statSync(folder);
  if (!stat.isDirectory()) throw new Error('Goal workspace must be a directory');
  return { path: fs.realpathSync(folder), dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

export class GoalController {
  constructor({ runs, project, worker, sandbox = {}, emit = () => {} }) {
    this.runs = runs; this.project = project; this.worker = worker; this.sandbox = sandbox; this.emit = emit;
    this.live = new Map(); this.registry = null; this.closing = false;
  }
  root(projectId) { return path.join(this.project(projectId).store.rootDir, 'goals'); }
  file(projectId, goalId) { return path.join(this.root(projectId), safe(goalId), 'state.json'); }
  get(projectId, goalId) {
    const state = read(this.file(projectId, goalId));
    const live = this.live.get(goalId);
    const owner = readOwner(this.recordPath(state, 'owner'));
    const external = !live && ownerAlive(owner);
    const interrupted = ['running', 'pausing', 'stopping', 'finishing'].includes(state.status) && !live && !external;
    return { ...state, ...(interrupted ? {
      status: state.controlIntent === 'limit' ? 'limit_reached' : state.controlIntent === 'stop' ? 'stopped' : state.controlIntent === 'pause' ? 'paused' : 'interrupted',
      reason: state.controlIntent === 'limit' ? 'Goal budget reached' : 'Execution was interrupted. Resume to continue from saved progress, or stop this goal.',
    } : {}), live: Boolean(live || external), ownership: live ? 'local' : external ? 'external' : 'none',
      controlAvailable: !external || owner.controls === 1,
      recoverable: interrupted && !['stop', 'limit'].includes(state.controlIntent),
      elapsedMs: state.elapsedMs + (live ? Date.now() - live.began : external && state.activeSince ? Date.now() - state.activeSince : 0) };
  }
  list(projectId) {
    const root = this.root(projectId);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, 'state.json')))
      .map(name => this.get(projectId, name)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  save(state) { state.updatedAt = new Date().toISOString(); write(this.file(state.projectId, state.id), state); this.emit(state.projectId, state.id, state); }
  recordPath(state, name) { return path.join(path.dirname(this.file(state.projectId, state.id)), `${safe(name)}.json`); }
  async blocks() {
    this.registry ??= (async () => {
      const kernel = await import('#kernel');
      const host = await bootKernel({ call: true, profile: 'flyt-loop-worker', runsRoot: path.join(os.tmpdir(), 'flyt-goal-validation') });
      try { return { kernel, definitions: host.ctx.blocks.list() }; }
      finally { await host.dispose(); }
    })();
    return this.registry;
  }
  async validateSource(source, contract) {
    bounded(source, 64000, 'Workflow source');
    const { kernel, definitions } = await this.blocks();
    const stack = kernel.parseStack(source);
    const bounds = kernel.boundStack(stack.root);
    if (bounds.expansion > 100 || bounds.blocks > 50) throw new Error('Goal workflows are limited to 50 authored and 100 expanded blocks');
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const nodeIds = new Set();
    const visit = node => {
      if (nodeIds.has(node.id)) throw new Error(`Duplicate Goal node identity: ${node.id}`);
      nodeIds.add(node.id);
      if (node.kind === 'block') {
        const definition = definitions.find(block => block.use === node.use);
        if (!definition) throw new Error(`Unavailable block: ${node.use}`);
        if (node.use === 'flyt-blocks-loop:loop-handoff') throw new Error('Legacy backlog handoff cannot run in a Goal');
        if (definition.settings && !ajv.validate(definition.settings, node.config ?? {})) throw new Error(`Invalid settings for ${node.id}: ${ajv.errorsText()}`);
        if (node.config?.model || node.config?.modelFallbacks || node.config?.modelTier) throw new Error('Goal model selection belongs to the fixed contract');
      } else {
        if (node.kind === 'parallel' && (node.maxParallel ?? node.children.length) > contract.maxParallel) throw new Error('Recipe exceeds fixed parallelism limit');
        node.children.forEach(visit); node.else?.forEach(visit);
      }
    };
    visit(stack.root);
    return stack;
  }
  contract(input, projectId) {
    if (input.folderMode === 'strict') throw new Error('Strict folder isolation is unavailable: this machine has no provider with a restricted filesystem view. Choose Folder focus explicitly.');
    if (input.folderMode && input.folderMode !== 'focus') throw new Error('Unknown folder policy');
    const entry = this.project(projectId);
    const folder = fs.realpathSync(goalFolder(input, entry));
    const requiredPaths = validateRequiredPaths(input.requiredPaths);
    const criteria = input.criteria;
    if (!Array.isArray(criteria) || !criteria.length || criteria.length > 30) throw new Error('Define 1–30 fixed acceptance checks');
    for (const criterion of criteria) {
      if (!['output_contains', 'file_contains'].includes(criterion.type)) throw new Error('Checks support output_contains and file_contains');
      bounded(criterion.value, 2000, 'Expected content');
      if (criterion.type === 'file_contains') within(folder, bounded(criterion.path, 500, 'Artifact path'));
    }
    const limits = { iterations: 10, calls: 100, minutes: 30, usd: null, ...input.limits };
    for (const [key, max] of [['iterations', 1000], ['calls', 10000], ['minutes', 1440]]) {
      if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > max) throw new Error(`Invalid ${key} limit (1–${max})`);
    }
    if (limits.usd !== null && (!Number.isFinite(limits.usd) || limits.usd <= 0)) throw new Error('Dollar limit must be positive or unset');
    const tests = input.tests ?? [];
    if (!Array.isArray(tests) || tests.length > 20) throw new Error('At most 20 fixed candidate tests');
    for (const test of tests) { bounded(test.input, 8000, 'Test input'); bounded(test.contains, 2000, 'Test expected content'); }
    const maxParallel = input.maxParallel ?? 1;
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 4) throw new Error('Parallelism must be 1–4');
    const plateau = input.plateau ?? 3;
    if (!Number.isInteger(plateau) || plateau < 1 || plateau > 1000) throw new Error('Plateau must be 1–1000');
    validateGoalTools(input.tools ?? []);
    return {
      version: 1, objective: bounded(input.objective, 8000, 'Objective'),
      constraints: String(input.constraints ?? '').slice(0, 8000), criteria: clone(criteria), tests: clone(tests), requiredPaths,
      folder, folderIdentity: identity(folder), folderMode: 'focus', createFolder: Boolean(input.createFolder), limits, maxParallel, plateau,
      selfRedesign: Boolean(input.selfRedesign), reviewAi: Boolean(input.reviewAi), reviewResults: Boolean(input.reviewResults),
      authoringId: input.authoringId ?? null, tools: [...new Set(input.tools ?? [])],
      worker: clone(this.resolveWorker ? this.resolveWorker(input.worker?.model ? input.worker : this.worker()) : (input.worker?.model ? input.worker : this.worker())),
    };
  }
  async create({ projectId, definition }) {
    projectId = this.project(projectId).id;
    const contract = this.contract(definition, projectId);
    if (!contract.worker?.model) throw new Error('Select a connected model before starting a Goal');
    await this.validateSource(definition.recipe, contract);
    if (definition.setup) await this.validateSource(definition.setup, contract);
    const state = {
      id: id(), projectId, name: String(definition.name || 'New goal').slice(0, 120),
      createdAt: new Date().toISOString(), contract, status: 'ready', reason: 'Ready to start',
      definition: { setup: definition.setup || null, recipe: definition.recipe },
      activeRevision: 1, pendingRevision: null, revisionCount: 1, iteration: 0,
      setupDone: !definition.setup, workspace: null, activeChild: null,
      calls: 0, knownUsd: 0, unknownCostCalls: 0, elapsedMs: 0, plateauCount: 0,
      best: null, current: null, memory: [], history: [],
    };
    immutable(this.recordPath(state, 'recipe-1'), { version: 1, source: definition.recipe, baseRevision: null, author: 'human', rationale: 'Initial recipe' });
    this.save(state); return state;
  }
  async editSource({ projectId, goalId, baseRevision, source, commands, rationale = 'Human edit', author = 'human' }) {
    projectId = this.project(projectId).id;
    let state = this.live.get(goalId)?.state ?? read(this.file(projectId, goalId));
    if (state.projectId !== projectId) throw new Error('Goal belongs to another project');
    if (author === 'model' && !state.contract.selfRedesign) throw new Error('Self redesign is disabled');
    if (author === 'model' && state.contract.reviewAi) throw new Error('REVIEW_REQUIRED: Model revisions must go through the authoring proposal validator');
    if (baseRevision !== (state.pendingRevision ?? state.activeRevision)) throw new Error('Stale recipe revision. Reload before editing.');
    const previous = read(this.recordPath(state, `recipe-${baseRevision}`));
    if (commands) {
      if (!Array.isArray(commands) || commands.length > 30) throw new Error('At most 30 recipe commands per proposal');
      const { kernel } = await this.blocks();
      let stack = kernel.parseStack(previous.source);
      const handlers = new Map();
      kernel.registerStackCommands({ commands: { register: command => { handlers.set(command.name, command); return () => {}; } } }, {
        get: () => stack.root, set: root => { stack = { ...stack, root }; },
      });
      for (const command of commands) {
        const handler = handlers.get(command.name);
        if (!handler) throw new Error(`Unsupported recipe command: ${command.name}`);
        await handler.handler(command.args);
      }
      source = serializeStack(stack);
    }
    await this.validateSource(source, state.contract);
    // Validation awaits: recheck the compare-and-swap against concurrent edits.
    const latest = read(this.file(projectId, goalId));
    if (baseRevision !== (latest.pendingRevision ?? latest.activeRevision)) throw new Error('Stale recipe revision. Reload before editing.');
    if (!this.live.has(goalId) && fs.existsSync(this.recordPath(state, 'owner'))) throw new Error('Edit through the controller that currently owns this Goal');
    state = this.live.get(goalId)?.state ?? latest;
    const version = state.revisionCount + 1;
    immutable(this.recordPath(state, `recipe-${version}`), {
      version, source, baseRevision, author, rationale: bounded(rationale, 2000, 'Revision rationale'), commands: commands ?? [],
    }, true);
    state.revisionCount = version; state.pendingRevision = version;
    if (author === 'model') state.pendingProposal = null;
    this.save(state); return clone(state);
  }
  async draft({ source, commands = [] }) {
    const { kernel, definitions } = await this.blocks();
    let stack = kernel.parseStack(source);
    const handlers = new Map();
    kernel.registerStackCommands({ commands: { register: command => { handlers.set(command.name, command); return () => {}; } } }, {
      get: () => stack.root, set: root => { stack = { ...stack, root }; },
    });
    if (!Array.isArray(commands) || commands.length > 30) throw new Error('Too many edit commands');
    for (const command of commands) {
      if (!handlers.has(command.name)) throw new Error('Unknown workflow edit command');
      await handlers.get(command.name).handler(command.args);
    }
    const next = serializeStack(stack);
    await this.validateSource(next, { maxParallel: 4 });
    return { source: next, stack: kernel.parseStack(next), blocks: definitions.map(({ execute, ...definition }) => definition) };
  }
  history({ projectId, goalId, query = '', offset = 0, limit = 10 }) {
    const state = this.get(projectId, goalId);
    return state.history.filter(item => JSON.stringify(item).toLowerCase().includes(String(query).toLowerCase()))
      .slice(Math.max(0, Number(offset) || 0), Math.max(0, Number(offset) || 0) + Math.min(20, Math.max(1, Number(limit) || 10)));
  }
  inspect({ projectId, goalId, record }) {
    const state = this.get(projectId, goalId);
    const value = read(this.recordPath(state, record));
    if (JSON.stringify(value).length > 128000) throw new Error('Record exceeds the inspection bound');
    return value;
  }
  acquire(state) {
    const owner = acquireOwner(this.recordPath(state, 'owner'));
    return Object.assign(() => owner.release(), { token: owner.token });
  }
  async start({ projectId, goalId, retry = null }) {
    if (this.closing) throw new Error('The application is closing; no Goal can start');
    projectId = this.project(projectId).id;
    if (this.live.has(goalId)) {
      if (retry) throw new Error('Pause or stop the Goal before retrying a node');
      return this.get(projectId, goalId);
    }
    const state = read(this.file(projectId, goalId));
    if (state.pendingResult) throw new Error('Review the pending result before resuming');
    if (state.contract.reviewAi && this.hasPendingReview?.(state)) throw new Error('REVIEW_REQUIRED: Resolve and publish the draft before resuming');
    if (state.controlIntent === 'limit') {
      state.status = 'limit_reached';
      state.reason = `Recovered recorded ${state.controlIntent} request`; this.save(state);
    }
    if (retry && (state.activeChild?.runId !== retry.runId || !retry.blockId)) throw new Error('Only the pending Goal child can be retried');
    if (retry && state.pendingRevision) throw new Error('Resume the Goal to apply the published repair before retrying a node');
    if (terminal.has(state.status) && !['failed', 'stopped'].includes(state.status)) throw new Error('This Goal is terminal. Start a new instance from its saved definition.');
    const release = this.acquire(state);
    const completedChild = state.iterationIntent && this.recordPath(state, `child-${state.iterationIntent.phase}`);
    const resumeFormatting = !state.pendingRevision && !state.outputRecovery?.exhausted && !state.contract.tests.length
      && completedChild && fs.existsSync(completedChild)
      && !parseGoalReply(read(completedChild).output) && repairableCandidateText(read(completedChild).output) !== null;
    if ((state.status === 'failed' || state.failureReason) && (state.pendingRevision || (!state.activeChild && !resumeFormatting))) {
      state.repairs ??= [];
      state.repairs.push({ child: state.activeChild?.runId ?? (state.iterationIntent ? `goal-${state.id}-${state.iterationIntent.phase}` : null), reason: state.reason, revision: state.activeRevision, at: new Date().toISOString() });
      state.repairAttempt = (state.repairAttempt ?? 0) + 1;
      state.status = 'ready'; state.activeChild = null; state.iterationIntent = null;
    }
    if (retry) state.activeChild.retry = { blockId: String(retry.blockId), guidance: String(retry.guidance ?? '') };
    state.failureReason = null;
    // A closed application is not execution time. Count only activity recorded
    // before interruption; retain all previously charged calls and spend.
    if (state.activeSince) state.elapsedMs += Math.max(0, (state.elapsedCheckpointAt ?? Date.parse(state.updatedAt)) - state.activeSince) || 0;
    const record = { state, release, task: null, requested: null, began: Date.now(), timer: null, abort: new AbortController() };
    this.live.set(goalId, record);
    state.activeSince = record.began; state.elapsedCheckpointAt = record.began; state.status = 'running'; state.reason = 'Running'; this.save(state);
    record.poll = setInterval(() => {
      try {
        if (Date.now() - state.elapsedCheckpointAt >= 5000) { state.elapsedCheckpointAt = Date.now(); this.save(state); }
        const folder = path.dirname(this.file(projectId, goalId));
        for (const name of fs.readdirSync(folder).filter(name => name.startsWith('control-') && name.endsWith('.json')).sort()) {
          const file = path.join(folder, name), request = read(file); fs.unlinkSync(file);
          if (request.owner === release.token) void this.control({ projectId, goalId, action: request.action }).catch(error => { state.reason = error.message; this.save(state); });
        }
      } catch (error) { state.reason = error.message; this.save(state); }
    }, 250); record.poll.unref?.();
    record.timer = setTimeout(() => {
      void this.control({ projectId, goalId, action: 'limit' }).catch(error => {
        state.reason = String(error.message ?? error); this.save(state);
      });
    }, Math.max(1, state.contract.limits.minutes * 60000 - state.elapsedMs));
    record.task = this.drive(record).then(() => {
      if (record.requested) this.check(record);
    }).catch(error => {
      state.status = record.requested === 'limit' || error.code === 'goal_limit' ? 'limit_reached' : record.requested === 'pause' ? 'paused' : record.requested === 'stop' ? 'stopped' : error.code === 'goal_cleanup_pending' ? 'cleanup_failed' : 'failed';
      state.reason = state.status === 'limit_reached' ? this.limitReason(record) : String(error.message ?? error);
      if (state.status === 'failed') state.failureReason = state.reason;
      this.save(state);
    }).finally(() => {
      clearTimeout(record.timer); clearInterval(record.poll); state.elapsedMs += Date.now() - record.began; state.activeSince = null;
      this.live.delete(goalId); release(); this.save(state);
    });
    return clone(state);
  }
  async control({ projectId, goalId, action }) {
    projectId = this.project(projectId).id;
    if (!['pause', 'stop', 'limit'].includes(action)) throw new Error('Unknown goal control');
    const record = this.live.get(goalId);
    if (!record) {
      const state = read(this.file(projectId, goalId));
      const owner = readOwner(this.recordPath(state, 'owner'));
      if (ownerAlive(owner)) {
        if (owner.controls !== 1) throw new Error('This Goal is running in an older controller; control it from that process');
        writeAtomic(this.recordPath(state, `control-${Date.now()}-${id()}`), { owner: owner.token, action });
        return { ...this.get(projectId, goalId), requested: action };
      }
      if (['ready', 'paused', 'running', 'pausing', 'stopping', 'interrupted', 'failed', 'stopped', 'finishing', 'cleanup_failed'].includes(state.status)) {
        const release = this.acquire(state);
        try {
          if (state.status === 'failed') state.failureReason = state.reason;
          if (state.activeSince) state.elapsedMs += Math.max(0, (state.elapsedCheckpointAt ?? Date.parse(state.updatedAt)) - state.activeSince) || 0;
          state.activeSince = null; state.controlIntent = action;
          state.status = action === 'stop' ? 'stopped' : action === 'pause' ? 'paused' : 'limit_reached';
          state.reason = action === 'stop' ? 'Stopped by user' : action === 'pause' ? 'Paused by user' : 'Goal budget reached';
          this.save(state);
        } finally { release(); }
      }
      return this.get(projectId, goalId);
    }
    if (record.state.projectId !== projectId) throw new Error('Goal belongs to another project');
    // A later pause (including shutdown) must never undo an explicit stop.
    if (record.requested === 'stop' || record.requested === 'limit') action = record.requested;
    record.requested = action;
    record.abort.abort();
    record.state.status = action === 'pause' ? 'pausing' : 'stopping';
    record.state.reason = action === 'pause' ? 'Pausing execution' : 'Stopping execution';
    record.state.controlIntent = action; this.save(record.state);
    if (record.state.activeChild) {
      const result = await this.runs.stop(projectId, record.state.activeChild.runId, `Goal ${action}`);
      if (result?.ok === false && result.code !== 'run_not_live') throw new Error(result.message || 'Could not signal the child run; try Stop again');
    }
    return clone(record.state);
  }
  async shutdown() {
    this.closing = true;
    const records = [...this.live.values()];
    await Promise.allSettled(records.map(record => waitBounded(this.control({ projectId: record.state.projectId, goalId: record.state.id, action: 'pause' }), 5000, 'Goal pause acknowledgement')));
    await Promise.allSettled(records.map(record => waitBounded(record.task, 15000, 'Goal shutdown')));
  }
  reviewResult({ projectId, goalId, artifact, digest: expectedDigest, decision, feedback = '' }) {
    projectId = this.project(projectId).id;
    if (this.live.has(goalId)) throw new Error('Wait for the iteration to settle before reviewing');
    const state = read(this.file(projectId, goalId));
    if (!state.pendingResult) {
      if (state.resultReviews?.some(item => item.artifact === artifact && item.digest === expectedDigest && item.decision === decision)) return state;
      throw new Error('No matching result awaiting review');
    }
    const record = read(this.recordPath(state, artifact));
    if (state.pendingResult.artifact !== artifact || hash(JSON.stringify(record)) !== expectedDigest) throw new Error('Stale result review');
    if (!['approve', 'changes', 'stop'].includes(decision)) throw new Error('Invalid review decision');
    state.resultReviews ??= [];
    state.resultReviews.push({ artifact, digest: expectedDigest, decision, feedback: String(feedback).slice(0, 2000), at: Date.now() });
    state.pendingResult = null;
    if (decision === 'stop') { state.status = 'stopped'; state.reason = 'Stopped during human result review'; }
    else if (decision === 'approve' && record.achieved) { state.status = 'achieved'; state.reason = 'Fixed checks passed and result approved'; }
    else {
      state.status = 'paused'; state.reason = decision === 'changes' ? 'Human requested another iteration' : 'Result reviewed; mandatory checks still incomplete';
      if (feedback) state.memory = [...state.memory, { text: String(feedback).slice(0, 2000), source: 'human review', iteration: state.iteration, status: 'feedback' }].slice(-10);
    }
    this.save(state); return state;
  }
  limitReason(record) {
    const { state } = record, limits = state.contract.limits;
    const reached = [];
    if (state.calls >= limits.calls) reached.push(`${limits.calls}-call limit`);
    if (state.elapsedMs + Date.now() - record.began >= limits.minutes * 60000) reached.push(`${limits.minutes}-minute time limit`);
    if (limits.usd !== null && state.knownUsd >= limits.usd) reached.push(`$${limits.usd} spend limit`);
    return `Goal budget reached${reached.length ? `: ${reached.join(', ')}` : ''}; saved progress retained`;
  }
  check(record) {
    const state = record.state;
    const limits = state.contract.limits;
    if (record.requested) throw Object.assign(new Error(`Goal ${record.requested}`), { code: record.requested === 'limit' ? 'goal_limit' : 'goal_control' });
    if (state.calls >= limits.calls || state.elapsedMs + Date.now() - record.began >= limits.minutes * 60000
      || (limits.usd !== null && state.knownUsd >= limits.usd)) {
      record.budgetHit = true;
      throw Object.assign(new Error('Goal budget reached'), { code: 'goal_limit' });
    }
  }
  packet(state) {
    return {
      goalId: state.id, objective: state.contract.objective, constraints: state.contract.constraints,
      criteria: state.contract.criteria, tests: state.contract.tests, iteration: state.iteration + 1,
      iterationBoundary: `The controller is executing iteration ${state.iteration + 1}. Complete only this iteration's assigned work and return. Only the controller can verify it and begin iteration ${state.iteration + 2}; do not simulate future iterations inside a block or change the iteration number yourself.`,
      recipeRevision: state.activeRevision, folder: state.workspace.path, folderMode: 'focus',
      projectRequirements: goalRequirements(state.contract, this.project(state.projectId), { workspace: state.workspace.path }),
      remaining: { calls: state.contract.limits.calls - state.calls, iterations: state.contract.limits.iterations - state.iteration },
      best: state.best, current: state.current, findings: state.memory,
      recipe: state.contract.selfRedesign ? read(this.recordPath(state, `recipe-${state.activeRevision}`)).source : undefined,
      outputContract: 'The FINAL recipe step returns JSON {"candidate":{"text":"your result"},"findings":["short uncertain or observed finding"],"proposal":{"baseRevision":number,"rationale":"why","commands":[{"name":"stack:configure-block","args":{"nodeId":"id","config":{}}}]}}. Intermediate steps and setup return their ordinary block output, following their own schema (for example a task list or an Evaluation verdict); do not wrap those outputs in the Goal envelope. proposal is optional; it edits only the recipe at the next boundary. For workflow optimization, candidate.source is canonical version 2 workflow YAML; fixed tests run through the ordinary engine. Do not claim verification: runtime checks decide success.',
    };
  }
  async child(record, phase, source, input, workspace = null) {
    const state = record.state;
    this.check(record);
    const validation = this.validateSource(source, state.contract);
    const parsed = await (record.abort ? abortable(validation, record.abort.signal) : validation);
    this.check(record);
    const candidateTest = phase.startsWith('candidate-');
    // Test workers see their input and inherited policy, never expected answers
    // or the optimizer's memory. This keeps evaluation separate from building.
    const goalContext = candidateTest ? {
      goalId: state.id, role: 'candidate-test', folderMode: 'focus',
      instruction: 'Execute this workflow against the STEP INPUT. Return its ordinary result.',
    } : this.packet(state);
    if (JSON.stringify(goalContext).length > 28000) throw new Error('Goal context exceeds 28,000 characters; reduce the contract, recipe or test set');
    if (!state.activeChild) {
      state.activeChild = { runId: `goal-${state.id}-${phase}`, phase, source, input, workspace: workspace || state.workspace.path };
      this.save(state); // intent and stable child identity precede dispatch
    }
    const pending = state.activeChild;
    if (pending.phase !== phase) throw new Error('Recovery phase does not match pending child');
    const guard = {
      maxMessageChars: 96_000,
      checkpointInputTokens: 16_000,
      beforeCall: async request => {
        this.check(record);
        // The adapter compacts against this same bound before accounting and
        // dispatch. This is an invariant check, not the context recovery path.
        if (JSON.stringify(request.messages ?? []).length > guard.maxMessageChars) throw new Error('Goal context policy did not fit the model request');
        if (request.model !== state.contract.worker.model) throw new Error('A descendant cannot change the Goal model contract');
        state.calls++; state.unknownCostCalls++; this.save(state);
      },
      afterCall: async result => {
        const cost = result.usage?.cost;
        if (Number.isFinite(cost) && cost >= 0) { state.knownUsd += cost; state.unknownCostCalls--; }
        this.save(state);
      },
    };
    if (!candidateTest && state.iteration > 0) guard.history = async args => {
      if (args.iteration != null) {
        if (!Number.isInteger(args.iteration) || args.iteration < 1 || args.iteration > state.iteration) throw new Error('Only completed iterations in this Goal can be retrieved');
        const result = this.inspect({ projectId: state.projectId, goalId: state.id, record: `iteration-${args.iteration}` });
        const view = { iteration: result.number, score: result.score, candidate: result.candidate, findings: result.findings,
          checks: result.checks.map(({ content, ...check }) => check), tests: result.tests.map(({ output, ...test }) => test) };
        if (JSON.stringify(view).length > 16000) throw new Error('Iteration exceeds the retrieval bound; use a history search for its compact result');
        return view;
      }
      return this.history({ ...args, projectId: state.projectId, goalId: state.id, limit: Math.min(10, args.limit ?? 5) });
    };
    const host = {
      workspace: pending.workspace, stackSource: pending.source, goalId: state.id, goalGuard: guard,
      worker: state.contract.worker, profile: 'flyt-loop-worker', approvalMode: 'always',
      ceiling: [...state.contract.tools, ...(!candidateTest ? ['goal_history'] : [])], sandboxMode: this.sandbox.mode ?? 'workspace-write',
      sandboxEnforcement: this.sandbox.minimumEnforcement ?? 'partial',
    };
    const runDir = this.project(state.projectId).store.runDir(pending.runId);
    const exists = fs.existsSync(path.join(runDir, 'session.jsonl'));
    const past = exists ? readSessionLogFile(path.join(runDir, 'session.jsonl')).events : [];
    const lastStage = past.filter(event => event.type === 'run.stage').at(-1)?.data.stage;
    const failedBlock = lastStage === 'failed' ? past.filter(event => event.type === 'run.error').at(-1)?.data.blockId : null;
    const retry = pending.retry ?? (lastStage === 'failed' ? { blockId: failedBlock ?? parsed.root.id, guidance: '' } : null);
    if (retry) {
      const contains = node => node.id === retry.blockId || [...(node.children ?? []), ...(node.else ?? [])].some(contains);
      if (!contains(parsed.root)) throw new Error(`Unknown retry node: ${retry.blockId}`);
      const status = past.filter(event => event.type === 'block.status' && event.data.blockId === retry.blockId).at(-1)?.data.status;
      if (status === 'done') throw new Error('Retry a failed or interrupted node; completed nodes are preserved');
    }
    this.check(record);
    const existing = this.runs.get?.(state.projectId, pending.runId);
    if (existing?.phase === 'settled') {
      state.status = 'finishing'; state.reason = 'Finishing child cleanup'; this.save(state);
      if (existing.cleanup === 'failed') {
        const cleanup = this.runs.retryCleanup(state.projectId, pending.runId);
        await (record.abort ? abortable(cleanup, record.abort.signal) : cleanup);
      }
      else await (record.abort ? abortable(existing.settlement, record.abort.signal) : existing.settlement);
      if (existing.cleanup !== 'complete') throw Object.assign(new Error(existing.cleanupError || 'Child cleanup still owns resources; retry cleanup before continuing'), { code: 'goal_cleanup_pending' });
      state.status = 'running';
    }
    const launched = exists
      ? retry
        ? await this.runs.restartBlock({ projectId: state.projectId, runId: pending.runId, ...retry, hostOverrides: host })
        : await this.runs.resume({ projectId: state.projectId, runId: pending.runId, hostOverrides: host })
      : await this.runs.start({
        projectId: state.projectId, runId: pending.runId, stackId: parsed.id, input: pending.input, host,
        metadata: { goalId: state.id, parentGoalId: state.id, parentRunId: candidateTest ? `goal-${state.id}-${state.iterationIntent?.phase ?? `iteration-${state.iteration + 1}`}` : null,
          iteration: state.iteration + 1, recipeRevision: state.activeRevision, goalContext, ceiling: host.ceiling },
      });
    delete pending.retry;
    this.save(state);
    if (record.requested) await this.runs.stop(state.projectId, pending.runId, `Goal ${record.requested}`);
    const outcome = await launched.run.settled();
    const owned = this.runs.get(state.projectId, pending.runId);
    if (owned) {
      state.status = record.requested ? state.status : 'finishing'; state.reason = 'Finishing child cleanup'; this.save(state);
      await (record.abort ? abortable(owned.settlement, record.abort.signal) : owned.settlement);
      if (owned.cleanup && owned.cleanup !== 'complete') throw Object.assign(new Error(owned.cleanupError || 'Child cleanup has not completed'), { code: 'goal_cleanup_pending' });
      if (!record.requested) { state.status = 'running'; state.reason = 'Running'; }
    }
    if (record.requested) this.check(record);
    const events = readSessionLogFile(path.join(runDir, 'session.jsonl')).events;
    const output = events.filter(event => event.type === 'block.output' && !event.data.port).at(-1)?.data.content ?? '';
    if (outcome.status !== 'done') throw Object.assign(new Error(`Child ${phase} ${outcome.status}: ${outcome.error || 'interrupted'}`), { code: record.budgetHit ? 'goal_limit' : 'goal_child_failed' });
    const result = { runId: pending.runId, output: String(output) };
    immutable(this.recordPath(state, `child-${phase}`), result);
    state.activeChild = null; this.save(state);
    return result;
  }
  async once(record, phase, source, input, workspace) {
    const file = this.recordPath(record.state, `child-${phase}`);
    if (fs.existsSync(file)) {
      if (record.state.activeChild?.phase === phase) record.state.activeChild = null;
      return read(file);
    }
    return this.child(record, phase, source, input, workspace);
  }
  async repairResult(record, result) {
    const state = record.state;
    const originalText = state.contract.tests.length ? null : repairableCandidateText(result.output);
    if (originalText === null) return null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.check(record);
      const phase = `${state.iterationIntent.phase}-format-${attempt}`;
      state.outputRecovery = { originalRunId: result.runId, phase, attempt, textDigest: hash(originalText), exhausted: false };
      this.save(state);
      const repaired = await this.once(record, phase, FORMAT_RECIPE, JSON.stringify(originalText));
      const envelope = parseGoalReply(repaired.output);
      if (envelope?.candidate?.text === originalText) {
        state.outputRecovery = { ...state.outputRecovery, repairedRunId: repaired.runId, recovered: true };
        this.save(state);
        // Formatting has no authority to introduce findings, code or proposals.
        return { candidate: { text: originalText } };
      }
    }
    state.outputRecovery = { ...state.outputRecovery, exhausted: true }; this.save(state);
    return null;
  }
  async drive(record) {
    const state = record.state;
    state.controlIntent = null;
    if (!state.workspace) {
      if (JSON.stringify(identity(state.contract.folder)) !== JSON.stringify(state.contract.folderIdentity)) throw new Error('The selected parent folder identity changed');
      const target = state.contract.createFolder ? path.join(state.contract.folder, `goal-${state.id}`) : state.contract.folder;
      fs.mkdirSync(target, { recursive: true });
      state.workspace = identity(target); this.save(state);
    } else if (JSON.stringify(identity(state.workspace.path)) !== JSON.stringify(state.workspace)) throw new Error('Goal workspace identity changed; inspect before restarting');
    if (!state.setupDone) {
      const setup = await this.once(record, 'setup', state.definition.setup, state.contract.objective);
      state.setupDone = true; state.setupResult = { runId: setup.runId, summary: setup.output.slice(0, 2000) }; this.save(state);
    }
    while (state.iteration < state.contract.limits.iterations) {
      this.check(record);
      if (state.pendingProposal) {
        if (state.contract.reviewAi) {
          try { await this.queueReview?.(state, state.pendingProposal); }
          catch (error) { state.lastRevisionError = String(error.message); }
          state.pendingProposal = null; state.status = 'paused'; state.reason = 'Waiting for recipe review'; this.save(state); return;
        }
        try { await this.editSource({ ...state.pendingProposal, projectId: state.projectId, goalId: state.id, author: 'model' }); }
        catch (error) { state.lastRevisionError = String(error.message); state.pendingProposal = null; this.save(state); }
      }
      if (state.pendingRevision && !state.activeChild && !state.iterationIntent) {
        state.activeRevision = state.pendingRevision; state.pendingRevision = null;
        this.save(state); // activation is durable before the next child starts
      }
      if (state.contract.reviewAi && !state.activeChild && !state.iterationIntent && this.hasPendingReview?.(state)) {
        state.status = 'paused'; state.reason = 'Waiting for draft review at the iteration boundary'; this.save(state); return;
      }
      const number = state.iteration + 1;
      state.iterationIntent ??= { number, revision: state.activeRevision, phase: `iteration-${number}${state.repairAttempt ? `-repair-${state.repairAttempt}` : ''}` }; this.save(state);
      const recipe = read(this.recordPath(state, `recipe-${state.iterationIntent.revision}`));
      let committed;
      if (fs.existsSync(this.recordPath(state, `iteration-${number}`))) {
        committed = read(this.recordPath(state, `iteration-${number}`));
        state.activeChild = null;
      } else {
      const result = await this.once(record, state.iterationIntent.phase, recipe.source, state.setupResult?.summary || state.contract.objective);
      if (result.output.length > 64000) throw new Error('Candidate output exceeds 64,000 characters; return a smaller artifact');
      const envelope = parseGoalReply(result.output) ?? await this.repairResult(record, result);
      if (!envelope?.candidate || typeof envelope.candidate.text !== 'string') throw new Error('Recipe must return JSON with candidate.text; malformed results cannot satisfy a Goal');
      const candidate = { text: envelope.candidate.text, source: envelope.candidate.source ?? null };
      const tests = [];
      if (state.contract.tests.length) {
        await this.validateSource(candidate.source, state.contract);
        for (const [index, test] of state.contract.tests.entries()) {
          const folder = within(state.workspace.path, `.goal-tests/${state.id}/${number}-${index}-${state.repairAttempt ?? 0}`);
          fs.mkdirSync(folder, { recursive: true });
          const child = await this.once(record, `candidate-${number}-${index}${state.repairAttempt ? `-repair-${state.repairAttempt}` : ''}`, candidate.source, test.input, folder);
          tests.push({ input: test.input, expected: test.contains, passed: child.output.includes(test.contains), runId: child.runId, output: child.output.slice(0, 8000) });
        }
      }
      const checks = state.contract.criteria.map((criterion, index) => {
        let content = candidate.text;
        if (criterion.type === 'file_contains') {
          const file = within(state.workspace.path, criterion.path);
          if (!fs.existsSync(file)) return { index, passed: false, reason: 'Artifact missing' };
          if (fs.statSync(file).size > 64000) return { index, passed: false, reason: 'Artifact exceeds verification bound' };
          content = fs.readFileSync(file, 'utf8');
        }
        return { index, passed: content.includes(criterion.value), digest: hash(content), ...(criterion.path ? { path: criterion.path, content } : {}) };
      });
      const score = [...checks, ...tests].filter(check => check.passed).length / (checks.length + tests.length);
      const learned = Array.isArray(envelope.findings) ? envelope.findings.filter(finding => typeof finding === 'string').slice(0, 4).map(text => ({ text: text.slice(0, 500), iteration: number, source: result.runId, status: 'hypothesis' })) : [];
      committed = immutable(this.recordPath(state, `iteration-${number}`), {
        number, revision: state.iterationIntent.revision, runId: result.runId, candidate, checks, tests, score,
        achieved: score === 1, findings: learned, proposal: envelope.proposal ?? null, knownUsd: state.knownUsd, calls: state.calls,
        needsInput: typeof envelope.needsInput === 'string' ? envelope.needsInput.slice(0, 2000) : null,
      });
      }
      // A replay uses the same immutable record and updates all projections in
      // one atomic state replacement. It cannot increment the iteration twice.
      const improved = !state.best || committed.score > state.best.score;
      const summary = { iteration: number, revision: committed.revision, score: committed.score, runId: committed.runId,
        artifact: `iteration-${number}`, preview: committed.candidate.text.slice(0, 500), verified: committed.achieved,
        findings: committed.findings.map(finding => finding.text).slice(0, 2) };
      state.current = summary;
      if (improved) { state.best = summary; state.plateauCount = 0; } else state.plateauCount++;
      state.memory = [...state.memory, ...committed.findings].filter((item, index, all) => all.findIndex(other => other.text === item.text) === index).slice(-10);
      state.history.push(summary); state.iteration = number; state.iterationIntent = null;
      state.pendingProposal = committed.proposal;
      if (state.contract.reviewResults) {
        state.pendingResult = { artifact: `iteration-${number}`, digest: hash(JSON.stringify(committed)), iteration: number, revision: committed.revision };
        state.status = 'paused'; state.reason = 'Waiting for human result review'; this.save(state); return;
      }
      if (committed.achieved) { state.status = 'achieved'; state.reason = 'All fixed acceptance checks passed'; }
      else if (committed.needsInput) { state.status = 'needs_input'; state.reason = committed.needsInput; }
      else if (state.plateauCount >= state.contract.plateau) { state.status = 'plateau'; state.reason = 'No improvement across the configured comparable iterations'; }
      this.save(state);
      if (terminal.has(state.status)) return;
    }
    state.status = 'limit_reached'; state.reason = 'Iteration limit reached; best artifact retained'; this.save(state);
  }
}
