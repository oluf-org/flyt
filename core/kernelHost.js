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
import { executeTool, getTools, refusedResult } from './tools/index.js';
import { previewResult } from './tools/preview.js';
import { loadSkills, skillsSection } from './skills.js';
import { captureWorkspaceSignature } from './effect.js';
import { snapshotStackRun } from './runProjection.js';

const safeJson = value => {
  try { return JSON.stringify(value); } catch { return String(value ?? ''); }
};

const jsonValue = value => {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return String(value ?? ''); }
};

// Starting a workflow from the attended chat is an immediate action. Queue
// writes are a separate, explicit composer choice; keeping them out of the
// desktop ceiling prevents a model from silently turning "run this now" into
// "leave this for the Loop". Loop workers retain the full ceiling below.
export const DESKTOP_QUEUE_WRITERS = new Set([
  'create_task', 'enqueue_task', 'update_task', 'write_task_md',
]);

export const desktopWorkflowCeiling = blocks => [...new Set(
  (blocks ?? []).flatMap(block => block.ceiling ?? [])
)].filter(tool => !DESKTOP_QUEUE_WRITERS.has(tool));

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

function configuredTree(root, {
  model = null, level = null, skillText = '', overrides = {}, blockWorkers = {},
  defaultFallbacks = [], blockFallbacks = {}, tierWorkers = {}, useAuthoredTiers = false,
} = {}) {
  const visit = node => {
    if (node.kind === 'block') {
      const base = { ...node.config, ...(overrides[node.id] ?? {}) };
      // Every shipped leaf except the explicit human checkpoint is model-backed.
      // Pinning only `work` left plan, judgement, and inquiry blocks on their schema default
      // (`openrouter/auto`), so a workflow could silently use a different
      // provider from the executor selected for the run.
      const instructions = node.use === 'flyt-blocks-core:work'
        ? [base.instructions, skillText].filter(Boolean).join('\n\n')
        : base.instructions;
      const tier = useAuthoredTiers && typeof base.modelTier === 'string' ? base.modelTier : null;
      const modelBacked = node.use !== 'flyt-blocks-judgement:human-checkpoint';
      const authored = tier
        ? (Array.isArray(tierWorkers?.[tier]) ? tierWorkers[tier] : [tierWorkers?.[tier]]).filter(worker => worker?.model)
        : [];
      if (modelBacked && tier === 'free' && authored.length === 0) {
        throw new Error(`Block "${node.title ?? node.id}" uses the Free tier, but no Free models are configured.`);
      }
      const selectedWorker = blockWorkers?.[node.id] ?? authored[0] ?? null;
      const selectedModel = modelBacked ? (selectedWorker?.model ?? model) : null;
      const selectedFallbacks = blockWorkers?.[node.id]
        ? (blockFallbacks?.[node.id] ?? [])
        : authored.length > 1 ? authored.slice(1) : defaultFallbacks;
      return {
        ...node,
        config: {
          ...base,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(modelBacked && selectedFallbacks.length ? { modelFallbacks: selectedFallbacks.map(worker => worker.model) } : {}),
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

/** Boot one already-resolved Flyt run host. */
export async function bootRunKernel({
  runsRoot, workspaceDir, stackRoot = null, store = null,
  approvalMode = 'always', runtimeConfig = {}, resolveModelSource = null,
  worker = null, blockWorkers = {}, defaultFallbacks = [], blockFallbacks = {},
  tierWorkers = {},
  level = null, loopTaskId = null, skills = null,
  backlog = null, pool = null, references = null, settings = {},
  profile = 'flyt-loop-worker', ceiling = null, presetId = null, askHuman = null,
  requireLaunchable = false, askBlock = null,
  sandboxMode = 'workspace-write', sandboxEnforcement = 'partial', forwardedEnv = [],
  windowsSandboxRunner = null,
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
    profile,
    runsRoot,
    approvalMode,
    approvalConfig: (typeof askHuman === 'function' || typeof askBlock === 'function') ? {
      ...(typeof askHuman === 'function' ? { ask: askHuman } : {}),
      ...(typeof askBlock === 'function' ? { bypass: ['ask_human'] } : {}),
    } : null,
    load: importer,
  });
  if (!booted) throw Object.assign(new Error('The required kernel profile could not be composed.'), { code: 'kernel_unavailable' });

  // A seam-only test can inspect the composed profile. Production execution
  // supplies the rest and fails closed if any is absent.
  if (!workspaceDir || !stackRoot || !store) return booted;

  const kernel = await importer();
  // Boot is observation, not a workspace mutation. A fresh repository may
  // have no .flyt/config.json; creating one here puts a protected path in the
  // task diff before the model has made its first call.
  // macOS exposes temporary directories through both /var and /private/var.
  // Compose every seam with one canonical identity so capability checks do
  // not reject the same directory merely because it arrived through an alias.
  const workspace = new Workspace(fs.realpathSync(path.resolve(workspaceDir)));
  const baselines = new Map();
  const skillLoad = loadSkills(workspace, skills);
  const skillText = skillsSection(skillLoad.found);
  const model = worker?.model ?? null;
  const pinnedProvider = worker?.provider && worker.provider !== 'auto' ? worker.provider : null;
  const routedWorkers = [
    worker,
    ...Object.values(blockWorkers ?? {}),
    ...(defaultFallbacks ?? []),
    ...Object.values(blockFallbacks ?? {}).flat(),
    ...Object.values(tierWorkers ?? {}).flatMap(candidate => Array.isArray(candidate) ? candidate : [candidate]),
  ];
  const workerByModel = new Map(routedWorkers
    .filter(candidate => candidate?.model)
    .map(candidate => [candidate.model, candidate]));
  const resolve = requested => {
    if (typeof resolveModelSource !== 'function') return null;
    const selected = workerByModel.get(requested);
    const provider = selected?.provider && selected.provider !== 'auto'
      ? selected.provider
      : (requested === model ? pinnedProvider : null);
    return resolveModelSource(requested, provider);
  };
  const capability = (resolvedModel, provider) => {
    const profile = kernel.defaultModelCapabilityRegistry.get(resolvedModel, provider);
    const facts = runtimeConfig.modelFacts?.[resolvedModel]
      ?? runtimeConfig.modelFacts?.[`${provider}/${resolvedModel}`]
      ?? {};
    const catalogSource = `Persisted ${provider} model catalog fact`;
    profile.provenance = {
      value: `${provider}/${resolvedModel}`,
      confidence: 'reported',
      source: Object.keys(facts).length ? catalogSource : profile.provenance.source,
    };
    if (Number.isFinite(facts.contextLength) && facts.contextLength > 0) {
      profile.limits.contextTokens = { value: facts.contextLength, confidence: 'reported', source: catalogSource };
      profile.limits.maxInputTokens = { value: facts.contextLength, confidence: 'inferred', source: catalogSource };
    }
    if (typeof facts.supportsTools === 'boolean') {
      profile.tools.native = { value: facts.supportsTools, confidence: 'reported', source: catalogSource };
      profile.structuredOutput.syntheticTool = { value: facts.supportsTools, confidence: 'inferred', source: catalogSource };
    }
    if (Number.isFinite(facts.inUsdPerM)) profile.pricing.inputPerMillion = {
      value: facts.inUsdPerM, confidence: 'reported', source: catalogSource,
    };
    if (Number.isFinite(facts.outUsdPerM)) profile.pricing.outputPerMillion = {
      value: facts.outUsdPerM, confidence: 'reported', source: catalogSource,
    };
    return profile;
  };
  const callThrough = request => call({
    ...(runtimeConfig.retry ? { retry: runtimeConfig.retry } : {}),
    ...(runtimeConfig.timeout ? { timeout: runtimeConfig.timeout } : {}),
    ...request,
    // OpenRouter's Auto Router band is part of the worker selection, not the
    // model id. Dropping it makes low/high/max all send the same request while
    // the Supervisor and ledger claim they ran different rungs.
    ...((workerByModel.get(request.model)?.routing
      ?? (request.model === model ? worker?.routing : null)) ? {
      routing: workerByModel.get(request.model)?.routing ?? worker.routing,
    } : {}),
  });

  await booted.install([
    { id: 'run-projection', name: kernel.BUILTIN.runProjection, config: { root: runsRoot } },
    { id: 'execution-world', name: kernel.BUILTIN.executionWorldLocal, config: {
      workspaceRoot: workspace.root,
      mode: sandboxMode,
      minimumEnforcement: sandboxEnforcement,
      allowAttendedEscalation: profile !== 'flyt-loop-worker' && typeof askHuman === 'function',
      forwardedEnv,
      runsTempRoot: runsRoot,
      ...(windowsSandboxRunner ? { windowsRunnerPath: windowsSandboxRunner } : {}),
      ...(typeof askHuman === 'function' ? { approveEscalation: async request => {
        const allowed = await askHuman({
          runId: request.runId, blockId: 'sandbox', step: 0,
          call: { id: request.callId, name: request.tool, args: {
            sandbox_permissions: request.to, justification: request.justification,
          } }, ceiling: [request.tool],
        }, `Allow this one call to widen its sandbox from ${request.from} to ${request.to}? ${request.justification}`);
        return allowed ? 'allowed-once' : 'rejected';
      } } : {}),
    } },
    { id: 'llm-adapters', name: kernel.BUILTIN.adapters, config: { callModel: callThrough, resolve, capability } },
  ]);
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
        if (tool.name === 'ask_human' && typeof askBlock === 'function') {
          const answer = await askBlock({
            runId: execution.runId, blockId: execution.blockId,
            question: String(args?.question ?? ''),
            options: Array.isArray(args?.options) ? args.options.map(String) : [],
            context: String(args?.context ?? ''),
          });
          return { content: safeJson({ answered: true, answer: String(answer ?? '') }) };
        }
        const record = await executeTool(tool.name, args, {
          store, runId: execution.runId, nodeId: execution.blockId,
          taskId: loopTaskId, workspace, backlog, pool, references,
          defaultWorker: worker, projectConfig: workspace.readConfig(), settings,
          gateTimeoutMs: runtimeConfig.gateTimeoutMs,
          config: runtimeConfig, signal: execution.signal,
          fs: booted.ctx.fs,
          shell: booted.ctx.shell,
          subprocess: booted.ctx.subprocess,
          sandbox: booted.ctx.sandbox,
          sandboxPolicy: booted.ctx.sandboxPolicy,
          execution: {
            owner: { runId: execution.runId, callId: execution.call.id },
            tool: tool.name,
            attended: profile !== 'flyt-loop-worker' && typeof askHuman === 'function',
            ...(args?.sandbox_permissions ? { requestedMode: args.sandbox_permissions } : {}),
            ...(args?.justification ? { justification: args.justification } : {}),
            ...(execution.signal ? { signal: execution.signal } : {}),
          },
          canonicalSession: true,
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
        const complete = jsonValue(record.ok ? record.result : { error: record.error });
        const preview = previewResult(complete, tool.result ?? {});
        // The structured preview stays what the model reads; the error flag is
        // what the loop's progress accounting reads.
        const refused = record.ok ? refusedResult(record.result) : null;
        return {
          content: `${safeJson(preview.value)}${preview.truncated ? '\n[Preview truncated; the complete result is retained in the run trace.]' : ''}`,
          durableResult: complete,
          ...(record.handle ? { handle: record.handle } : {}),
          ...(record.ok ? (refused ? { error: refused } : {}) : { error: record.error ?? 'tool failed' }),
        };
      },
    });
  }

  const stacks = new StackStore(stackRoot, {
    parseStack: kernel.parseStack,
    resolveBlock: use => booted.ctx.blocks.resolve(use),
  });
  await booted.install([{ id: 'stack-runner', name: kernel.BUILTIN.stackRunner, config: {
    stacks: {
      resolve(id) {
        // Preserve parser/resolution diagnostics. Returning null here would
        // collapse a malformed stack, a missing block plugin, and a missing
        // file into the same "There is no stack" message precisely where the
        // unattended harness most needs a repairable cause.
        const stack = stacks.load(id);
        if (requireLaunchable && !stack.launchable) {
          throw new Error(`Workflow "${id}" is internal and cannot be launched from chat.`);
        }
        const preset = presetId ? stack.presets?.[presetId] : null;
        if (presetId && !preset) throw new Error(`Workflow "${id}" has no preset "${presetId}".`);
        return configuredTree(stack.root, {
          model, level, skillText, blockWorkers, defaultFallbacks, blockFallbacks,
          tierWorkers, useAuthoredTiers: profile !== 'flyt-loop-worker',
          overrides: preset?.overrides ?? {},
        });
      },
    },
    ceiling: ceiling ?? (profile === 'flyt-loop-worker'
      ? kernel.LOOP_CEILING
      : desktopWorkflowCeiling(booted.ctx.blocks.list())),
  } }]);

  // Host-only facts used by snapshotStackRun; never exposed to a renderer.
  booted.ctx.__flytRunsRoot = runsRoot;
  return {
    ...booted,
    kernelModule: kernel,
    workspace: workspace.root,
    metadata: {
      workspace: workspace.root, approvalMode, loopTaskId, model,
      executionWorld: {
        id: booted.ctx.fs.world.id, provider: booted.ctx.fs.world.provider,
        workspaceId: booted.ctx.fs.world.workspaceId, processRoot: booted.ctx.fs.world.processRoot,
      },
      sandbox: {
        requestedMode: sandboxMode, effectiveMode: booted.ctx.fs.world.sandbox.standingMode,
        backend: booted.ctx.fs.world.sandbox.backend, enforcement: booted.ctx.fs.world.sandbox.enforcement,
        minimumEnforcement: sandboxEnforcement, network: 'ambient',
      },
      ...(worker?.provider ? { provider: worker.provider } : {}),
      ...(worker?.routing ? { routing: worker.routing } : {}),
      blockWorkers,
      defaultFallbacks,
      blockFallbacks,
      tierWorkers,
      level, skills: skills ?? [], presetId,
      profile, requireLaunchable,
    },
    skillLoad,
    beginRun(id) { baselines.set(id, captureWorkspaceSignature(workspace.root)); },
  };
}

export async function startStackRun({ host = null, ctx = host?.ctx, stackId, input, id = null, metadata = null } = {}) {
  if (!ctx?.agents) {
    throw Object.assign(new Error('The kernel has no agents seam; the production run host did not compose.'), { code: 'kernel_unavailable' });
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

export async function pauseStackRun(ctx, id, reason = 'paused by request') {
  if (!ctx?.agents) return { ok: false, error: 'kernel-unavailable', message: 'No agents seam.' };
  try {
    const paused = await ctx.agents.pause(id, reason);
    return paused
      ? { ok: true, state: 'pausing' }
      : { ok: false, error: 'not-live-or-paused', message: `Kernel run ${id} is not live or is already pausing.` };
  } catch (err) {
    return { ok: false, error: 'pause-failed', message: String(err?.message ?? err) };
  }
}

export async function continueStackRun(ctx, id) {
  if (!ctx?.agents) return { ok: false, error: 'kernel-unavailable', message: 'No agents seam.' };
  try {
    const continued = await ctx.agents.continue(id);
    return continued
      ? { ok: true, state: 'resuming' }
      : { ok: false, error: 'not-paused', message: `Kernel run ${id} is not paused.` };
  } catch (err) {
    return { ok: false, error: 'resume-failed', message: String(err?.message ?? err) };
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
    data: { blockId, status: 'pending', reason: 'restarted by supervisor',
      ...(String(guidance ?? '').trim() ? { guidance: String(guidance) } : {}) },
  });
  if (String(guidance ?? '').trim()) {
    await session.append({ type: 'message.user', data: { blockId, content: String(guidance), modelVisible: false } });
  }
  return resumeStackRun(host, id);
}
