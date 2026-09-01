// The one process-local owner for canonical Flyt runs.
//
// Product surfaces resolve a launch and hand it here. This component owns
// Cordis host reuse, AgentRun identity, leases, controls and teardown; it does
// not choose workflows, models, approval policy, or Electron behaviour.
import os from 'node:os';
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
  #repaired = new Set();

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
  }

  #hostKey(projectId, request) {
    const authority = {
      projectId,
      runsRoot: request.runsRoot,
      workspace: request.workspace,
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
    };
    return JSON.stringify(stable(authority));
  }

  async #repair(projectId) {
    if (!this.#repairStored) return;
    const root = this.#runsRootForProject(projectId);
    if (this.#repaired.has(root)) return;
    this.#repaired.add(root);
    try { await this.#repairStored(root); }
    catch (error) { this.#repaired.delete(root); throw error; }
  }

  async #acquireHost(projectId, request) {
    const hostKey = this.#hostKey(projectId, request);
    let record = this.#hosts.get(hostKey);
    if (record) return { hostKey, record };
    let pending = this.#hostBoots.get(hostKey);
    if (!pending) {
      pending = Promise.resolve(this.#bootHost(projectId, request)).then(host => {
        const created = { host, runIds: new Set(), owners: new Map() };
        this.#hosts.set(hostKey, created);
        return created;
      }).finally(() => this.#hostBoots.delete(hostKey));
      this.#hostBoots.set(hostKey, pending);
    }
    record = await pending;
    return { hostKey, record };
  }

  async #disposeIfUnused(hostKey, record) {
    if (record.owners.size || this.#hosts.get(hostKey) !== record) return;
    this.#hosts.delete(hostKey);
    try { await record.host.dispose(); } catch { /* a durable run outlives host cleanup */ }
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

  #register(projectId, hostKey, hostRecord, run, afterSettled = null) {
    const key = runKey(projectId, run.runId);
    const watchToken = run;
    const record = {
      runId: run.runId, projectId, hostKey, host: hostRecord.host, run, watchToken,
      leaseTimer: null, settlement: null, startedAt: new Date(this.#now()).toISOString(),
    };
    this.#live.set(key, record);
    hostRecord.runIds.add(key);
    hostRecord.owners.set(watchToken, key);
    this.#beat(record);
    record.leaseTimer = setInterval(() => this.#beat(record), 5_000);
    record.leaseTimer.unref?.();
    this.#onActivity?.(projectId);

    record.settlement = Promise.resolve(run.settled()).then(async outcome => {
      try { await afterSettled?.(outcome, record); }
      catch (error) { await this.#onSettled?.({ phase: 'afterSettled', error, record }); }
      try { await this.#snapshotLive(record.host.ctx, record.runId, record.host.kernelModule); }
      catch (error) { await this.#onSettled?.({ phase: 'projection', error, record }); }
      return outcome;
    }).finally(async () => {
      clearInterval(record.leaseTimer);
      const owns = this.#live.get(key)?.watchToken === watchToken;
      if (owns) {
        this.#storeForProject(projectId).clearLease(record.runId);
        this.#live.delete(key);
      }
      hostRecord.owners.delete(watchToken);
      if (![...hostRecord.owners.values()].includes(key)) hostRecord.runIds.delete(key);
      await this.#disposeIfUnused(hostKey, hostRecord);
      if (owns) this.#onActivity?.(projectId);
    });
    return record;
  }

  async start(launch) {
    await this.#repair(launch.projectId);
    if (launch.runId && this.isLive(launch.projectId, launch.runId)) {
      throw coded(`Run "${launch.runId}" is already live in this process.`, 'run_already_live');
    }
    const request = { ...launch.host, runsRoot: launch.host?.runsRoot ?? this.#runsRootForProject(launch.projectId) };
    const { hostKey, record: hostRecord } = await this.#acquireHost(launch.projectId, request);
    try {
      const { runId, run } = await this.#startRun({
        host: hostRecord.host,
        stackId: launch.stackId,
        input: launch.input,
        id: launch.runId ?? null,
        metadata: launch.metadata ?? null,
      });
      this.#register(launch.projectId, hostKey, hostRecord, run, launch.afterSettled ?? null);
      return { runId, run };
    } catch (error) {
      await this.#disposeIfUnused(hostKey, hostRecord);
      throw error;
    }
  }

  #leaseLive(projectId, runId) {
    const lease = this.#storeForProject(projectId).readLease(runId);
    if (!lease || this.#now() - Number(lease.beatAt ?? 0) >= 60_000) return false;
    if (lease.host && lease.host !== this.#hostname()) return true;
    try { process.kill(Number(lease.pid), 0); return true; }
    catch (error) { return error?.code === 'EPERM'; }
  }

  async #storedHost(projectId, runId, workerOverride = null, blockId = null) {
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
    };
    const acquired = await this.#acquireHost(projectId, host);
    return { hostKey: acquired.hostKey, hostRecord: acquired.record, meta, desktopBlockOverride };
  }

  async resume({ projectId, runId, workerOverride = null, blockId = null }) {
    await this.#repair(projectId);
    const existing = this.get(projectId, runId);
    if (existing && !workerOverride) return { runId, run: existing.run, control: await this.continue(projectId, runId) };
    const { hostKey, hostRecord } = await this.#storedHost(projectId, runId, workerOverride, blockId);
    try {
      const { run } = await this.#resumeRun(hostRecord.host, runId);
      this.#register(projectId, hostKey, hostRecord, run);
      return { runId, run };
    } catch (error) {
      await this.#disposeIfUnused(hostKey, hostRecord);
      throw error;
    }
  }

  async restartBlock({ projectId, runId, blockId, guidance = '', worker = null }) {
    await this.#repair(projectId);
    const { hostKey, hostRecord, desktopBlockOverride } = await this.#storedHost(projectId, runId, worker, blockId);
    const reconfigured = worker?.model
      ? desktopBlockOverride
        ? { blockWorkers: hostRecord.host.metadata.blockWorkers, blockFallbacks: hostRecord.host.metadata.blockFallbacks }
        : { model: worker.model, provider: worker.provider ?? 'auto', routing: worker.routing ?? null }
      : null;
    try {
      const { run } = await this.#restartBlock(hostRecord.host, runId, blockId, String(guidance ?? ''), reconfigured);
      this.#register(projectId, hostKey, hostRecord, run);
      return { runId, run };
    } catch (error) {
      await this.#disposeIfUnused(hostKey, hostRecord);
      throw error;
    }
  }

  async stop(projectId, runId, reason = 'stopped by request') {
    const record = this.get(projectId, runId);
    if (!record) return { ok: false, code: 'run_not_live', error: 'not-live', message: `Run ${runId} is not live in this process.` };
    const result = await stopStackRun(record.host.ctx, runId, reason);
    return result.ok ? result : { ...result, code: 'run_control_failed' };
  }

  async pause(projectId, runId, reason = 'paused by request') {
    const record = this.get(projectId, runId);
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
      .filter(record => projectId == null || record.projectId === projectId)
      .map(record => record.runId);
  }

  isLive(projectId, runId) { return this.#live.has(runKey(projectId, runId)); }

  async shutdown(reason = 'application closing') {
    const records = [...this.#live.values()];
    await Promise.allSettled(records.map(record => this.stop(record.projectId, record.runId, reason)));
    await Promise.allSettled(records.map(record => record.settlement));
    return { stopped: records.length };
  }
}

export { runKey };
