// Production Loop execution on the v2 kernel.
//
// This is the host boundary, not another runner. The kernel owns scheduling,
// permission checks and the canonical JSONL session. The JS application lends
// it the already battle-tested provider adapters and built-in tool bodies,
// each wrapped behind the kernel seams. Every fact needed to reopen a run is
// written in run.created before execution begins.
import fs from 'node:fs';
import path from 'node:path';
import { bootKernel } from './v2.js';
import { StackStore } from './stackstore.js';
import { Workspace } from './workspace.js';
import { callModel } from './adapters/index.js';
import { executeTool, getTools } from './tools/index.js';
import { loadSkills, skillsSection } from './skills.js';
import { captureWorkspaceSignature } from './effect.js';

const safeJson = value => {
  try { return JSON.stringify(value); } catch { return String(value ?? ''); }
};

const newRunId = () => {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  return `${now}-${Math.random().toString(36).slice(2, 6)}`;
};

const classificationOf = tool => {
  const effects = new Set(tool.effects ?? ['read']);
  return {
    effect: effects.has('shell') ? 'shell' : (effects.has('write') || effects.has('destructive')) ? 'write' : 'read',
    destructive: effects.has('destructive'),
    untrustedInput: effects.has('network') || tool.trust === 'untrusted',
    source: 'confirmed',
  };
};

function configuredTree(root, { model = null, level = null, skillText = '' } = {}) {
  const visit = node => {
    if (node.kind === 'block') {
      if (node.use !== 'flyt-blocks-core:work') return { ...node, config: { ...node.config } };
      const instructions = [node.config?.instructions, skillText].filter(Boolean).join('\n\n');
      return {
        ...node,
        config: {
          ...node.config,
          ...(model ? { model } : {}),
          ...(['low', 'medium', 'high'].includes(level) ? { effort: level } : {}),
          ...(instructions ? { instructions } : {}),
        },
      };
    }
    return {
      ...node,
      children: (node.children ?? []).map(visit),
      ...(node.else ? { else: node.else.map(visit) } : {}),
    };
  };
  return visit(root);
}

async function eventsFor(ctx, id) {
  const session = await ctx.sessions.read(id);
  const events = [];
  for await (const event of session.read()) events.push(event);
  return events;
}

function compatibilitySnapshot(kernel, events, id, runsRoot) {
  const projected = kernel.projectRun(events, id);
  kernel.materialise(path.join(runsRoot, id), projected);

  const toolCalls = events.filter(event => event.type === 'tool.result').map(event => ({
    tool: event.data?.name ?? 'tool',
    ok: !event.data?.error,
    error: event.data?.error ?? null,
    at: event.at,
  }));
  const usage = projected.calls.reduce((total, call) => {
    const raw = call.usage ?? {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
    }
    return total;
  }, {});
  const blocks = Object.keys(projected.meta.blockStatus);
  const retrospectives = Object.fromEntries(blocks.map(blockId => [blockId, {
    status: projected.meta.blockStatus[blockId],
    toolCalls,
    usage,
  }]));

  return {
    meta: {
      ...projected.meta,
      nodeStatus: { ...projected.meta.blockStatus },
      currentNodeId: projected.meta.currentBlockId,
    },
    prompt: projected.prompt,
    stack: projected.stack,
    flow: null,
    tasks: null,
    retrospectives,
    nodeOutputs: { ...projected.blocks },
    taskOutputs: {},
    followups: [],
    summaries: [],
    session: { head: events.at(-1)?.seq ?? 0, canonical: true },
  };
}

/** A Supervisor-shaped snapshot derived only from the canonical session. */
export async function snapshotStackRun(ctx, id, kernelModule = null) {
  const kernel = kernelModule ?? await import('#kernel');
  return compatibilitySnapshot(kernel, await eventsFor(ctx, id), id, ctx.__flytRunsRoot);
}

/** Read a kernel run after its process is gone; no live host is required. */
export async function snapshotStoredStackRun(runsRoot, id, kernelModule = null) {
  const file = path.join(runsRoot, id, 'session.jsonl');
  if (!fs.existsSync(file)) throw new Error(`Run "${id}" has no kernel session log.`);
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const kernel = kernelModule ?? await import('#kernel');
  return compatibilitySnapshot(kernel, events, id, runsRoot);
}

/** Durable launch metadata, used to reconstruct a host for resume. */
export function storedStackRunMetadata(runsRoot, id) {
  const file = path.join(runsRoot, id, 'session.jsonl');
  if (!fs.existsSync(file)) return null;
  let metadata = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'run.created') metadata = { ...(event.data ?? {}) };
    if (event.type === 'run.reconfigured' && metadata) metadata = { ...metadata, ...(event.data ?? {}) };
  }
  return metadata;
}

/** Does this run folder contain the kernel's canonical record? */
export function isKernelRun(store, id) {
  return Boolean(store && fs.existsSync(path.join(store.runDir(id), 'session.jsonl')));
}

/** Boot one worktree-scoped Loop host. */
export async function bootLoopKernel({
  runsRoot, workspaceDir, stackRoot = null, store = null,
  approvalMode = 'always', runtimeConfig = {}, resolveModelSource = null,
  worker = null, level = null, loopTaskId = null, skills = null,
  backlog = null, pool = null, references = null, settings = {},
  load = null, call = callModel,
  onSessionEvent = null,
} = {}) {
  let kernelModule = null;
  const importer = async () => {
    kernelModule ??= await (load ? load() : import('#kernel'));
    return kernelModule;
  };
  const booted = await bootKernel({
    call: true,
    profile: 'flyt-loop-worker',
    runsRoot,
    approvalMode,
    load: importer,
  });
  if (!booted) throw Object.assign(new Error('The kernel is off, so Loop cannot start a task.'), { code: 'kernel_unavailable' });

  // A seam-only test can inspect the composed profile. Production execution
  // supplies the rest and fails closed if any is absent.
  if (!workspaceDir || !stackRoot || !store) return booted;

  const kernel = await importer();
  // Boot is observation, not a workspace mutation. A fresh repository may
  // have no .flyt/config.json; creating one here puts a protected path in the
  // task diff before the model has made its first call.
  const workspace = new Workspace(workspaceDir);
  const baselines = new Map();
  const skillLoad = loadSkills(workspace, skills);
  const skillText = skillsSection(skillLoad.found);
  const model = worker?.model ?? null;
  const pinnedProvider = worker?.provider && worker.provider !== 'auto' ? worker.provider : null;
  const resolve = requested => {
    if (typeof resolveModelSource !== 'function') return null;
    return resolveModelSource(requested, requested === model ? pinnedProvider : null);
  };
  const callThrough = request => call({
    ...(runtimeConfig.retry ? { retry: runtimeConfig.retry } : {}),
    ...(runtimeConfig.timeout ? { timeout: runtimeConfig.timeout } : {}),
    ...request,
    // OpenRouter's Auto Router band is part of the worker selection, not the
    // model id. Dropping it makes low/high/max all send the same request while
    // the Supervisor and ledger claim they ran different rungs.
    ...(worker?.routing && request.model === model ? { routing: worker.routing } : {}),
  });

  await booted.ctx.plugin(kernel.flytRunProjection, { root: runsRoot });
  await booted.ctx.plugin(kernel.flytFs, { root: workspace.root });
  await booted.ctx.plugin(kernel.flytBlocks);
  await booted.ctx.plugin(kernel.flytBlocksCore);
  await booted.ctx.plugin(kernel.flytBlocksJudgement);
  await booted.ctx.plugin(kernel.flytBlocksInquiry);
  await booted.ctx.plugin(kernel.flytBlocksLoop);
  await booted.ctx.plugin(kernel.flytAdapters, { callModel: callThrough, resolve });
  if (typeof onSessionEvent === 'function') {
    booted.ctx.on('session/append', (runId, event) => onSessionEvent(runId, event));
  }

  // Built-ins are application code, registered on the root context. They are
  // trusted definitions, but still require the block ceiling and approvals.
  for (const tool of getTools()) {
    booted.ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      classification: classificationOf(tool),
      async execute(args, execution) {
        if (booted.ctx.fs.root !== workspace.root) throw new Error('Kernel filesystem binding does not match the task worktree.');
        const record = await executeTool(tool.name, args, {
          store, runId: execution.runId, nodeId: execution.blockId,
          taskId: loopTaskId, workspace, backlog, pool, references,
          defaultWorker: worker, projectConfig: workspace.readConfig(), settings,
          gateTimeoutMs: runtimeConfig.gateTimeoutMs,
          config: runtimeConfig, signal: execution.signal,
          // Long tools use this between their durable call/result boundaries.
          // It deliberately reuses the host's coalesced session observer.
          notify: () => onSessionEvent?.(execution.runId, { type: 'tool.progress', data: null }),
        });
        const baseline = baselines.get(execution.runId);
        if (baseline) {
          const current = captureWorkspaceSignature(workspace.root);
          const changed = safeJson(current) !== safeJson(baseline);
          const session = await booted.ctx.sessions.open(execution.runId);
          await session.append({
            type: 'workspace.observed',
            data: { changed, kind: current.kind, tool: tool.name },
          });
        }
        return {
          content: safeJson(record.ok ? record.result : { error: record.error }),
          ...(record.handle ? { handle: record.handle } : {}),
          ...(record.ok ? {} : { error: record.error ?? 'tool failed' }),
        };
      },
    });
  }

  const stacks = new StackStore(stackRoot, {
    parseStack: kernel.parseStack,
    resolveBlock: use => booted.ctx.blocks.resolve(use),
  });
  await booted.ctx.plugin(kernel.flytStackRunner, {
    stacks: {
      resolve(id) {
        // Preserve parser/resolution diagnostics. Returning null here would
        // collapse a malformed stack, a missing block plugin, and a missing
        // file into the same "There is no stack" message precisely where the
        // unattended harness most needs a repairable cause.
        return configuredTree(stacks.load(id).root, { model, level, skillText });
      },
    },
    ceiling: kernel.LOOP_CEILING,
  });

  // Host-only facts used by snapshotStackRun; never exposed to a renderer.
  booted.ctx.__flytRunsRoot = runsRoot;
  return {
    ...booted,
    kernelModule: kernel,
    workspace: workspace.root,
    metadata: {
      workspace: workspace.root, approvalMode, loopTaskId, model,
      ...(worker?.provider ? { provider: worker.provider } : {}),
      ...(worker?.routing ? { routing: worker.routing } : {}),
      level, skills: skills ?? [],
    },
    skillLoad,
    beginRun(id) { baselines.set(id, captureWorkspaceSignature(workspace.root)); },
  };
}

export async function startStackRun({ host = null, ctx = host?.ctx, stackId, input, id = null, metadata = null } = {}) {
  if (!ctx?.agents) {
    throw Object.assign(new Error('The kernel has no agents seam; the production Loop host did not compose.'), { code: 'kernel_unavailable' });
  }
  const startedId = id ?? newRunId();
  host?.beginRun?.(startedId);
  const run = await ctx.agents.start({
    id: stackId,
    runId: startedId,
    metadata: { ...(host?.metadata ?? {}), ...(metadata ?? {}) },
  }, String(input ?? ''));
  if (host?.kernelModule) await snapshotStackRun(ctx, startedId, host.kernelModule);
  return { runId: run.runId, run };
}

export async function stopStackRun(ctx, id, reason = 'stopped by request') {
  if (!ctx?.agents) return { ok: false, error: 'kernel-unavailable', message: 'No agents seam.' };
  try {
    const stopped = await ctx.agents.stop(id, reason);
    return stopped
      ? { ok: true }
      : { ok: false, error: 'not-live', message: `Kernel run ${id} is not live in this process.` };
  } catch (err) {
    return { ok: false, error: 'stop-failed', message: String(err?.message ?? err) };
  }
}

export async function resumeStackRun(host, id) {
  if (!host?.ctx?.agents) throw Object.assign(new Error('The kernel host is unavailable.'), { code: 'kernel_unavailable' });
  host.beginRun?.(id);
  const run = await host.ctx.agents.resume(id);
  return { runId: run.runId, run };
}

export async function restartStackBlock(host, id, blockId, guidance = '', reconfigured = null) {
  if (!host?.ctx?.agents) throw Object.assign(new Error('The kernel host is unavailable.'), { code: 'kernel_unavailable' });
  if (host.ctx.agents.get(id)) throw new Error(`Kernel run "${id}" is still live; stop it before restarting a block.`);
  const session = await host.ctx.sessions.open(id);
  if (reconfigured) {
    await session.append({ type: 'run.reconfigured', data: reconfigured });
  }
  await session.append({
    type: 'block.status',
    data: { blockId, status: 'pending', reason: 'restarted by supervisor' },
  });
  if (String(guidance ?? '').trim()) {
    await session.append({ type: 'message.user', data: { content: String(guidance) } });
  }
  return resumeStackRun(host, id);
}
