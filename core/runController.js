// The one process-local owner for canonical Flyt runs.
//
// Product surfaces resolve a launch and hand it here. This component owns
// Cordis host reuse, AgentRun identity, leases, controls and teardown; it does
// not choose workflows, models, approval policy, or Electron behaviour.
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireOwner, ownerAlive, readOwner, writeAtomic, bounded, abortable } from './executionOwnership.js';
import { workflowActions } from './lifecycle.js';
import {
  startStackRun, resumeStackRun, restartStackBlock,
  stopStackRun, pauseStackRun, continueStackRun,
} from './kernelHost.js';
import {
  snapshotStackRun, snapshotStoredStackRun, storedStackRunMetadata,
} from './runProjection.js';

const stable = value => {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return '[function]';
    return value;
  }
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort()
    .filter(key => typeof value[key] !== 'undefined')
    .map(key => [key, stable(value[key])]));
};

const runKey = (projectId, runId) => `${String(projectId).length}:${projectId}${runId}`;

const coded = (message, code, status = 409) => Object.assign(new Error(message), { code, status });

/**
 * @typedef {object} RunLaunch
 * @property {string} projectId
 * @property {string=} runId
 * @property {string} stackId
 * @property {string=} input
 * @property {object} host Resolved composition request. Functions are live-only.
 * @property {object=} metadata Serializable per-run launch metadata.
 * @property {((outcome: unknown) => Promise<unknown>)=} afterSettled
 */

export class RunController {
  #bootHost;
  #startRun;
  #resumeRun;
  #restartBlock;
  #snapshotLive;
  #snapshotStored;
  #metadataStored;
  #runsRootForProject;
  #storeForProject;
  #repairStored;
  #onSettled;
  #onActivity;
  #now;
  #hostname;
  #live = new Map();
  #hosts = new Map();
  #hostBoots = new Map();
  #repairs = new Map();
  // Rebuildable recovery hints, scoped to this controller rather than execution
  // authority. Explicit per-run reconciliation always validates the log again.
  #terminalSessions = new Map();
  #lifecycleHints = new Map();
  #operations = new Map();
  #closing = false;
  #cleanupTimeoutMs;
  #disposeReads;

  constructor({
    bootHost,
    startRun = startStackRun,
    resumeRun = resumeStackRun,
    restartBlock = restartStackBlock,
    snapshotLive = snapshotStackRun,
    snapshotStored = snapshotStoredStackRun,
    metadataStored = storedStackRunMetadata,
    runsRootForProject,
    storeForProject,
    repairStored = null,
    onSettled = null,
    onActivity = null,
    now = () => Date.now(),
    hostname = () => os.hostname(),
    cleanupTimeoutMs = 10000,
    disposeReads = null,
  } = {}) {
    if (typeof bootHost !== 'function') throw new Error('RunController needs bootHost');
    if (typeof runsRootForProject !== 'function') throw new Error('RunController needs runsRootForProject');
    if (typeof storeForProject !== 'function') throw new Error('RunController needs storeForProject');
    this.#bootHost = bootHost;
    this.#startRun = startRun;
    this.#resumeRun = resumeRun;
    this.#restartBlock = restartBlock;
    this.#snapshotLive = snapshotLive;
    this.#snapshotStored = snapshotStored;
    this.#metadataStored = metadataStored;
    this.#runsRootForProject = runsRootForProject;
    this.#storeForProject = storeForProject;
    this.#repairStored = repairStored;
    this.#onSettled = onSettled;
    this.#onActivity = onActivity;
    this.#now = now;
    this.#hostname = hostname;
    this.#cleanupTimeoutMs = cleanupTimeoutMs;
    this.#disposeReads = disposeReads;
  }

  #hostKey(projectId, request) {
    const workspace = request.workspace ? canonicalWorkspace(request.workspace) : null;
    const forwardedEnvNameHash = crypto.createHash('sha256')
      .update([...(request.forwardedEnv ?? [])].map(String).sort().join('\0')).digest('hex').slice(0, 16);
    const authority = {
      projectId,
      runsRoot: request.runsRoot,
      workspace,
      profile: request.profile,
      approvalMode: request.approvalMode,
      worker: request.worker,
      blockWorkers: request.blockWorkers ?? {},
      defaultFallbacks: request.defaultFallbacks ?? [],
      blockFallbacks: request.blockFallbacks ?? {},
      tierWorkers: request.tierWorkers ?? {},
      level: request.level ?? null,
      loopTaskId: request.loopTaskId ?? null,
      presetId: request.presetId ?? null,
      skills: request.skills ?? [],
      requireLaunchable: Boolean(request.requireLaunchable),
      ceiling: request.ceiling ?? null,
      toolsContextIdentity: request.toolsContextIdentity ?? null,
      stackSource: request.stackSource ?? null,
      goalId: request.goalId ?? null,
      executionWorldProvider: request.executionWorldProvider ?? 'local',
      sandboxMode: request.sandboxMode ?? 'workspace-write',
      sandboxEnforcement: request.sandboxEnforcement ?? 'partial',
      allowAttendedEscalation: Boolean(request.allowAttendedEscalation),
      forwardedEnvNameHash,
    };
    return JSON.stringify(stable(authority));
  }

  async reconcile(projectId, runId = null, { signal } = {}) {
    if (!this.#repairStored) return;
    const root = this.#runsRootForProject(projectId);
    const key = `${root}\n${runId ?? '*'}`;
    // Wait for a broad scan, then validate the requested run without its hints.
    // A mutation must not inherit a cached terminal skip from an overlapping poll.
    if (runId && this.#repairs.has(`${root}\n*`)) {
      try { await this.#repairs.get(`${root}\n*`); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
    if (!this.#repairs.has(key)) {
      const pending = runId ? [] : [...this.#repairs].filter(([at]) => at.startsWith(`${root}\n`)).map(([, promise]) => promise);
      const promise = Promise.all(pending).then(() => this.#repairStored(root, {
        ...(runId ? { runIds: [runId] } : {}),
        ...(!runId ? { terminalCache: this.#terminalSessions } : {}),
        ...(signal ? { signal } : {}),
        claim: id => {
          const file = this.#file(projectId, id, 'execution-owner.json');
          if (!file) return () => {};
          try { return acquireOwner(file).release; }
          catch (error) { if (['run_already_live', 'EEXIST'].includes(error.code)) return null; throw error; }
        },
      }))
        .finally(() => this.#repairs.delete(key));
      this.#repairs.set(key, promise);
    }
    try { return await this.#repairs.get(key); }
    catch (error) {
      // A mutation may have joined a display read just before project switch.
      // Cancellation belongs to that reader; canonical execution validation
      // must retry independently, never inherit its aborted worker request.
      if (!signal && !this.#closing && error.name === 'AbortError') return this.reconcile(projectId, runId);
      throw error;
    }
  }

  #file(projectId, runId, name) {
    const store = this.#storeForProject(projectId);
    return store.runDir ? path.join(store.runDir(runId), name) : null;
  }

  #launch(projectId, runId, action) {
    const key = runKey(projectId, runId);
    if (this.#closing) return Promise.reject(coded('The application is closing; no new execution can start.', 'run_closing'));
    if (this.#operations.has(key) || this.#live.has(key)) return Promise.reject(coded(`Run "${runId}" is already owned; wait for execution and cleanup to finish.`, 'run_already_live'));
    const op = { projectId, runId, abort: new AbortController(), requested: null, owner: null, task: null };
    this.#operations.set(key, op);
    op.task = Promise.resolve().then(async () => {
      const file = this.#file(projectId, runId, 'execution-owner.json');
      if (this.#leaseLive(projectId, runId)) throw coded('Run is owned by another live process.', 'run_already_live');
      if (file) op.owner = acquireOwner(file);
      return await action(op);
    }).finally(async () => {
      this.#operations.delete(key);
      if (op.owner && !this.#live.has(key)) op.owner.release();
      if (op.hostRecord) {
        op.hostRecord.owners.delete(op);
        await this.#disposeIfUnused(op.hostKey, op.hostRecord);
      }
      this.#onActivity?.(projectId);
    });
    return op.task;
  }

  #checkLaunch(op) {
    if (this.#closing || op.abort.signal.aborted) throw coded('Execution cancelled before dispatch', 'run_cancelled');
  }

  async #acquireHost(projectId, request, op = null) {
    const hostKey = this.#hostKey(projectId, request);
    let record = this.#hosts.get(hostKey);
    if (record) {
      if (op) { this.#checkLaunch(op); record.owners.set(op, runKey(projectId, op.runId)); op.hostRecord = record; op.hostKey = hostKey; }
      return { hostKey, record };
    }
    let pending = this.#hostBoots.get(hostKey);
    if (!pending) {
      pending = Promise.resolve(this.#bootHost(projectId, request)).then(host => {
        if (this.#closing) {
          void bounded(Promise.resolve().then(() => host.dispose()), this.#cleanupTimeoutMs, 'Host cleanup').catch(() => {});
          throw coded('The application closed during host startup', 'run_closing');
        }
        const created = { host, runIds: new Set(), owners: new Map() };
        this.#hosts.set(hostKey, created);
        return created;
      }).finally(() => this.#hostBoots.delete(hostKey));
      this.#hostBoots.set(hostKey, pending);
    }
    record = await pending;
    if (op) {
      if (op.abort.signal.aborted) { await this.#disposeIfUnused(hostKey, record); this.#checkLaunch(op); }
      record.owners.set(op, runKey(projectId, op.runId)); op.hostRecord = record; op.hostKey = hostKey;
    }
    return { hostKey, record };
  }

  async #disposeIfUnused(hostKey, record) {
    if (record.owners.size || this.#hosts.get(hostKey) !== record) return;
    this.#hosts.delete(hostKey);
    try { await bounded(Promise.resolve().then(() => record.host.dispose()), this.#cleanupTimeoutMs, 'Host cleanup'); } catch { /* a durable run outlives host cleanup */ }
  }

  #beat(record) {
    const store = this.#storeForProject(record.projectId);
    store.writeLease(record.runId, {
      pid: process.pid,
      host: this.#hostname(),
      startedAt: record.startedAt,
      beatAt: this.#now(),
      runtime: 'kernel',
      profile: record.host?.metadata?.profile ?? null,
    });
  }

  #register(projectId, hostKey, hostRecord, run, afterSettled = null, op = null) {
    const key = runKey(projectId, run.runId);
    const watchToken = run;
    const record = {
      runId: run.runId, projectId, hostKey, host: hostRecord.host, run, watchToken,
      leaseTimer: null, settlement: null, startedAt: new Date(this.#now()).toISOString(),
      phase: 'running', cleanup: 'pending', outcome: null, owner: op?.owner ?? null, hostRecord,
      completedCleanup: new Set(), cleanupPending: null, afterSettled,
    };
    this.#live.set(key, record);
    hostRecord.runIds.add(key);
    if (op) hostRecord.owners.delete(op);
    hostRecord.owners.set(watchToken, key);
    this.#beat(record);
    record.leaseTimer = setInterval(() => this.#beat(record), 5_000);
    record.leaseTimer.unref?.();
    this.#onActivity?.(projectId);

    record.settlement = Promise.resolve().then(() => run.settled()).catch(error => ({ status: 'failed', error: String(error?.message ?? error) })).then(async outcome => {
      record.outcome = outcome; record.phase = 'settled'; record.cleanup = 'running';
      this.#publishLifecycle(record);
      await this.#cleanup(record);
      return outcome;
    });
    return record;
  }

  #publishLifecycle(record) {
    const file = this.#file(record.projectId, record.runId, 'lifecycle.json');
    if (file) writeAtomic(file, { phase: record.phase, cleanup: record.cleanup, cleanupError: record.cleanupError ?? null, outcome: { status: record.outcome?.status, error: record.outcome?.error }, updatedAt: new Date().toISOString() });
    this.#onActivity?.(record.projectId);
  }

  async #cleanup(record) {
    if (record.cleanupTask) return record.cleanupTask;
    record.cleanupTask = this.#doCleanup(record).finally(() => { record.cleanupTask = null; });
    return record.cleanupTask;
  }

  async #doCleanup(record) {
    record.cleanup = 'running'; record.cleanupError = null; this.#publishLifecycle(record);
    const steps = [
      ['subprocess cleanup', () => record.host.ctx.subprocess?.terminateOwner(record.runId, 'run settled')],
      ['sandbox cleanup', () => record.host.ctx.sandbox?.disposeOwner(record.runId)],
      ['sandbox policy cleanup', () => record.host.ctx.sandboxPolicy?.disposeOwner?.(record.runId)],
      ['afterSettled', () => record.afterSettled?.(record.outcome, record)],
      ['projection', () => this.#snapshotLive(record.host.ctx, record.runId, record.host.kernelModule)],
      ['host cleanup', async () => {
        const hostRecord = record.hostRecord;
        if ([...hostRecord.owners.keys()].some(owner => owner !== record.watchToken)) {
          hostRecord.owners.delete(record.watchToken);
          hostRecord.runIds.delete(runKey(record.projectId, record.runId));
          return;
        }
        if (this.#hosts.get(record.hostKey) === hostRecord) this.#hosts.delete(record.hostKey);
        await hostRecord.host.dispose();
      }],
    ];
    for (const [phase, action] of steps) {
      if (record.completedCleanup.has(phase)) continue;
      const pending = record.cleanupPending ?? { phase, promise: Promise.resolve().then(action) };
      record.cleanupPending = pending;
      try {
        await bounded(pending.promise, this.#cleanupTimeoutMs, phase);
        record.completedCleanup.add(phase); record.cleanupPending = null;
      } catch (error) {
        record.cleanup = 'failed'; record.cleanupError = `${phase}: ${error.message}`;
        this.#publishLifecycle(record);
        try { await bounded(Promise.resolve().then(() => this.#onSettled?.({ phase, error, record })), this.#cleanupTimeoutMs, 'Cleanup reporting'); } catch { /* the original error remains inspectable */ }
        if (error.code === 'cleanup_timeout') {
          // Reuse the original operation; never run a second cleanup over resources
          // that the first one is still using. Late success resumes teardown.
          pending.promise.then(() => {
            if (record.cleanupPending !== pending) return;
            record.completedCleanup.add(phase); record.cleanupPending = null;
            setTimeout(() => { void this.#cleanup(record).catch(() => {}); }, 0);
          }, () => { if (record.cleanupPending === pending) record.cleanupPending = null; });
        } else record.cleanupPending = null;
        return;
      }
    }
    record.cleanup = 'complete'; this.#publishLifecycle(record);
    clearInterval(record.leaseTimer);
    const key = runKey(record.projectId, record.runId);
    this.#storeForProject(record.projectId).clearLease(record.runId);
    this.#live.delete(key); record.owner?.release();
    const hostRecord = this.#hosts.get(record.hostKey);
    if (hostRecord) {
      hostRecord.owners.delete(record.watchToken); hostRecord.runIds.delete(key);
      await this.#disposeIfUnused(record.hostKey, hostRecord);
    }
    this.#onActivity?.(record.projectId);
  }

  async retryCleanup(projectId, runId) {
    const record = this.get(projectId, runId);
    if (!record || record.phase !== 'settled') return { ok: false, code: 'cleanup_unavailable', message: 'No settled run awaiting cleanup in this process.' };
    await this.#cleanup(record);
    return { ok: record.cleanup === 'complete', state: record.cleanup, message: record.cleanupError };
  }

  async start(launch) {
    launch = { ...launch, runId: launch.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}` };
    return this.#launch(launch.projectId, launch.runId, async op => {
    await this.reconcile(launch.projectId);
    this.#checkLaunch(op);
    const request = { ...launch.host, runsRoot: launch.host?.runsRoot ?? this.#runsRootForProject(launch.projectId) };
    const { hostKey, record: hostRecord } = await abortable(this.#acquireHost(launch.projectId, request, op), op.abort.signal);
    try {
      this.#checkLaunch(op);
      const { runId, run } = await this.#startRun({
        host: hostRecord.host,
        stackId: launch.stackId,
        input: launch.input,
        id: launch.runId ?? null,
        metadata: launch.metadata ?? null,
      });
      this.#register(launch.projectId, hostKey, hostRecord, run, launch.afterSettled ?? null, op);
      if (this.#closing || op.abort.signal.aborted) await this.stop(launch.projectId, runId);
      else if (op.requested === 'pause') await this.pause(launch.projectId, runId);
      return { runId, run };
    } catch (error) {
      await this.#disposeIfUnused(hostKey, hostRecord);
      throw error;
    }
    });
  }

  #leaseLive(projectId, runId) {
    const lease = this.#storeForProject(projectId).readLease?.(runId);
    if (!lease || this.#now() - Number(lease.beatAt ?? 0) >= 60_000) return false;
    if (lease.host && lease.host !== this.#hostname()) return true;
    try { process.kill(Number(lease.pid), 0); return true; }
    catch (error) { return error?.code === 'EPERM'; }
  }

  async #storedHost(projectId, runId, workerOverride = null, blockId = null, hostOverrides = null, op = null) {
    const live = this.get(projectId, runId);
    if (live && !workerOverride) return { live, hostKey: live.hostKey, hostRecord: this.#hosts.get(live.hostKey) };
    if (live) throw coded(`Run "${runId}" is already live; stop it before changing its worker.`, 'run_already_live');
    if (this.#leaseLive(projectId, runId)) {
      throw coded(`Run "${runId}" is owned by another live process.`, 'run_already_live');
    }
    const root = this.#runsRootForProject(projectId);
    const meta = this.#metadataStored(root, runId);
    if (!meta?.workspace) {
      throw coded(`Run "${runId}" does not record a workspace and cannot be resumed safely.`, 'run_resume_metadata_missing');
    }
    const desktopBlockOverride = Boolean(workerOverride?.model && blockId && meta.profile === 'flyt-desktop');
    const blockWorkers = desktopBlockOverride
      ? { ...(meta.blockWorkers ?? {}), [blockId]: workerOverride }
      : (meta.blockWorkers ?? {});
    const blockFallbacks = desktopBlockOverride
      ? { ...(meta.blockFallbacks ?? {}), [blockId]: [] }
      : (meta.blockFallbacks ?? {});
    const host = {
      runsRoot: root,
      workspace: meta.workspace,
      approvalMode: meta.approvalMode ?? 'always',
      worker: workerOverride?.model && !desktopBlockOverride ? {
        provider: workerOverride.provider ?? 'auto', model: workerOverride.model,
        ...(workerOverride.routing ? { routing: workerOverride.routing } : {}),
      } : meta.model ? {
        provider: meta.provider ?? 'auto', model: meta.model,
        ...(meta.routing ? { routing: meta.routing } : {}),
      } : null,
      blockWorkers,
      defaultFallbacks: meta.defaultFallbacks ?? [],
      blockFallbacks,
      tierWorkers: meta.tierWorkers ?? {},
      level: meta.level ?? null,
      loopTaskId: meta.loopTaskId ?? null,
      skills: Array.isArray(meta.skills) ? meta.skills : [],
      profile: meta.profile ?? 'flyt-loop-worker',
      presetId: meta.presetId ?? null,
      requireLaunchable: Boolean(meta.requireLaunchable),
      executionWorldProvider: meta.executionWorld?.provider ?? 'local',
      sandboxMode: meta.sandbox?.effectiveMode ?? 'workspace-write',
      sandboxEnforcement: meta.sandbox?.enforcement === 'full'
        ? 'full' : meta.sandbox?.minimumEnforcement ?? 'partial',
      allowAttendedEscalation: meta.profile !== 'flyt-loop-worker',
      forwardedEnv: [],
      ceiling: meta.ceiling ?? null,
      ...(hostOverrides ?? {}),
    };
    const acquired = await this.#acquireHost(projectId, host, op);
    return { hostKey: acquired.hostKey, hostRecord: acquired.record, meta, desktopBlockOverride };
  }

  async resume({ projectId, runId, workerOverride = null, blockId = null, hostOverrides = null, afterSettled = null }) {
    const existing = this.get(projectId, runId);
    if (existing?.phase !== 'settled' && existing && !workerOverride) return { runId, run: existing.run, control: await this.continue(projectId, runId) };
    return this.#launch(projectId, runId, async op => {
    await this.reconcile(projectId, runId);
    this.#checkLaunch(op);
    const { hostKey, hostRecord, meta } = await abortable(this.#storedHost(projectId, runId, workerOverride, blockId, hostOverrides, op), op.abort.signal);
    try {
      this.#checkLaunch(op);
      const { run } = await this.#resumeRun(hostRecord.host, runId);
      const previous = meta.sandbox ?? null;
      const current = hostRecord.host.metadata?.sandbox ?? null;
      if (previous && current && (previous.backend !== current.backend || previous.enforcement !== current.enforcement)) {
        const session = await hostRecord.host.ctx.sessions.open(runId);
        await session.append({ type: 'run.reconfigured', data: {
          sandbox: current,
          executionWorld: hostRecord.host.metadata?.executionWorld ?? meta.executionWorld ?? null,
        } });
      }
      this.#register(projectId, hostKey, hostRecord, run, afterSettled, op);
      if (this.#closing || op.abort.signal.aborted) await this.stop(projectId, runId);
      else if (op.requested === 'pause') await this.pause(projectId, runId);
      return { runId, run };
    } catch (error) {
      await this.#disposeIfUnused(hostKey, hostRecord);
      throw error;
    }
    });
  }

  async restartBlock({ projectId, runId, blockId, guidance = '', worker = null, hostOverrides = null, afterSettled = null }) {
    return this.#launch(projectId, runId, async op => {
    await this.reconcile(projectId, runId);
    this.#checkLaunch(op);
    const { hostKey, hostRecord, desktopBlockOverride } = await abortable(this.#storedHost(projectId, runId, worker, blockId, hostOverrides, op), op.abort.signal);
    const reconfigured = worker?.model
      ? desktopBlockOverride
        ? { blockWorkers: hostRecord.host.metadata.blockWorkers, blockFallbacks: hostRecord.host.metadata.blockFallbacks }
        : { model: worker.model, provider: worker.provider ?? 'auto', routing: worker.routing ?? null }
      : null;
    try {
      this.#checkLaunch(op);
      const { run } = await this.#restartBlock(hostRecord.host, runId, blockId, String(guidance ?? ''), reconfigured);
      this.#register(projectId, hostKey, hostRecord, run, afterSettled, op);
      if (this.#closing || op.abort.signal.aborted) await this.stop(projectId, runId);
      else if (op.requested === 'pause') await this.pause(projectId, runId);
      return { runId, run };
    } catch (error) {
      await this.#disposeIfUnused(hostKey, hostRecord);
      throw error;
    }
    });
  }

  async stop(projectId, runId, reason = 'stopped by request') {
    const record = this.get(projectId, runId);
    const pending = this.#operations.get(runKey(projectId, runId));
    if (pending && !record) { pending.requested = 'stop'; pending.abort.abort(); return { ok: true, state: 'stopping' }; }
    if (record?.phase === 'settled') return { ok: true, state: 'settled', cleanup: record.cleanup };
    if (!record) return { ok: false, code: 'run_not_live', error: 'not-live', message: `Run ${runId} is not live in this process.` };
    const result = await stopStackRun(record.host.ctx, runId, reason);
    return result.ok ? result : { ...result, code: 'run_control_failed' };
  }

  async pause(projectId, runId, reason = 'paused by request') {
    const record = this.get(projectId, runId);
    const pending = this.#operations.get(runKey(projectId, runId));
    if (pending && !record) { if (pending.requested !== 'stop') pending.requested = 'pause'; return { ok: true, state: pending.requested === 'stop' ? 'stopping' : 'pausing' }; }
    if (!record) return { ok: false, code: 'run_not_live', error: 'not-live', message: `Run ${runId} is not live in this process.` };
    const result = await pauseStackRun(record.host.ctx, runId, reason);
    return result.ok ? result : { ...result, code: 'run_control_failed' };
  }

  async continue(projectId, runId) {
    const record = this.get(projectId, runId);
    if (!record) return { ok: false, code: 'run_not_live', error: 'not-live', message: `Run ${runId} is not live in this process.` };
    const result = await continueStackRun(record.host.ctx, runId);
    return result.ok ? result : { ...result, code: 'run_control_failed' };
  }

  get(projectId, runId) { return this.#live.get(runKey(projectId, runId)); }

  list(projectId = null) {
    return [...this.#live.values()]
      .filter(record => record.phase !== 'settled' && (projectId == null || record.projectId === projectId))
      .map(record => record.runId);
  }

  isLive(projectId, runId) { return this.#operations.has(runKey(projectId, runId)) || Boolean(this.get(projectId, runId) && this.get(projectId, runId).phase !== 'settled'); }

  lifecycle(projectId, runId, observation = null) {
    const record = this.get(projectId, runId);
    const op = this.#operations.get(runKey(projectId, runId));
    if (record) return { phase: record.phase, cleanup: record.cleanup, cleanupError: record.cleanupError, outcome: record.outcome, owner: 'local' };
    if (op) return { phase: 'starting', requested: op.requested, owner: 'local', cleanup: null };
    const key = runKey(projectId, runId);
    const stamp = observation && !observation.hasOwner ? observation.lifecycleStamp : null;
    const cached = this.#lifecycleHints.get(key);
    if (stamp != null && cached?.stamp === stamp) return cached.value;
    const saved = this.#file(projectId, runId, 'lifecycle.json');
    const ownerFile = this.#file(projectId, runId, 'execution-owner.json');
    const external = ownerFile && ownerAlive(readOwner(ownerFile)) || this.#leaseLive(projectId, runId);
    const lifecycle = saved ? readOwner(saved) : null;
    const value = external ? { ...lifecycle, owner: 'external' }
      : saved ? { ...lifecycle, owner: 'none', cleanup: lifecycle?.cleanup === 'complete' ? 'complete' : 'interrupted' } : null;
    if (stamp != null && !external) {
      this.#lifecycleHints.set(key, { stamp, value });
      if (this.#lifecycleHints.size > 10000) this.#lifecycleHints.delete(this.#lifecycleHints.keys().next().value);
    } else this.#lifecycleHints.delete(key);
    return value;
  }

  decorate(projectId, runId, snapshot) {
    const lifecycle = this.lifecycle(projectId, runId);
    return { ...snapshot, meta: { ...snapshot.meta, lifecycle, actions: workflowActions(snapshot.meta?.stage, lifecycle) } };
  }

  async shutdown(reason = 'application closing') {
    this.#closing = true;
    const operations = [...this.#operations.values()];
    operations.forEach(op => { op.requested = 'stop'; op.abort.abort(); });
    const records = [...this.#live.values()];
    await Promise.allSettled(records.map(record => bounded(this.stop(record.projectId, record.runId, reason), this.#cleanupTimeoutMs, 'Stop acknowledgement')));
    await Promise.allSettled([...operations.map(op => bounded(op.task, this.#cleanupTimeoutMs, 'Startup cancellation')), ...records.map(record => bounded(record.settlement, this.#cleanupTimeoutMs * 2, 'Run shutdown'))]);
    await this.#disposeReads?.();
    return { stopped: records.length, cancelledStarts: operations.length, pendingCleanup: [...this.#live.values()].map(record => record.runId) };
  }
}

function canonicalWorkspace(value) {
  const resolved = path.resolve(String(value ?? ''));
  try { return fs.realpathSync(resolved); }
  catch { return resolved; }
}

export { runKey };
