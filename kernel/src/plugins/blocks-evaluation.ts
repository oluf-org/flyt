import type { BlockDefinition, BlockRun } from '../blocks/types.js';
import type { JsonValue } from '../types.js';
import { runAgentLoop } from '../blocks/run.js';
import { executeTaskGraph } from './blocks-task-graph.js';
import { evaluators, digest, JUDGE_SYSTEM, validateResult } from '../evaluation/registry.js';
import type { Request } from '../evaluation/registry.js';
import { parseListOutput } from '../blocks/list-output.js';

export const immutableArtifactBlock: BlockDefinition = {
  use: 'flyt-blocks-judgement:immutable-artifact', title: 'Immutable artifact', category: 'utility',
  description: 'Pass an authored artifact through the canonical workflow without a model call.',
  settings: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', maxLength: 64000 } }, required: ['text'] },
  ceiling: [], outputs: [{ name: 'artifact', type: 'string' }],
  async execute(run) { const text = String(run.config.text); return { status: 'done', output: text, structured: { artifact: text } }; },
};

// A versioned block keeps the original Evaluate ports and semantics intact.
export const robustEvaluationBlock: BlockDefinition = {
  use: 'flyt-blocks-judgement:robust-evaluation', title: 'Robust evaluation', category: 'judgement',
  description: 'Runtime-validated checks, measurements and reference comparisons. Required gates determine eligibility independently of ranking.',
  settings: { type: 'object', additionalProperties: false, properties: {
    request: { type: 'object' }, target: { enum: ['artifact', 'plan', 'task-graph'] },
    targetConfig: { type: 'object', additionalProperties: false, properties: { minTasks: { type: 'integer', minimum: 1, maximum: 24 }, maxTasks: { type: 'integer', minimum: 1, maximum: 24 }, parallelism: { enum: ['low', 'medium', 'high'] }, maxTokens: { type: 'integer', minimum: 1, maximum: 131072 }, maxOutputWords: { type: 'integer', minimum: 1, maximum: 100000 } } }, candidatePrompt: { type: 'string', maxLength: 24000 }, model: { type: 'string' }, modelFallbacks: { type: 'array', items: { type: 'string' } },
  }, required: ['request'] },
  ceiling: ['bash', 'read_file'],
  outputs: [{ name: 'eligible', type: 'boolean' }, { name: 'status', type: 'string' }, { name: 'report', type: 'string' }, { name: 'comparison', type: 'string' }],
  async execute(run: BlockRun) {
    const session = await run.ctx.sessions.open(run.runId);
    const request = structuredClone(run.config.request) as unknown as Request;
    evaluators.validateRequest(request); // before any candidate or judge spend
    // Authored request data cannot impersonate canonical runtime observations.
    request.rawArtifact = undefined; request.runtime = undefined;
    request.runId = run.runId; request.signal = run.signal;
    let target = run.config.target ?? 'artifact';
    const targetId = `${run.blockId}-candidate`;
    let outcome: any = null, artifact = request.artifact, runtime: any = {};
    let candidateIntent = false, savedCandidate: any = null;
    for await (const event of session.read(run.context?.after)) {
      const data = event.data as any;
      if (data.blockId !== run.blockId || event.type !== 'block.output') continue;
      if (data.port === 'evaluation-candidate-intent') candidateIntent = true;
      if (data.port === 'evaluation-candidate') savedCandidate = JSON.parse(data.content);
    }
    if (savedCandidate) { ({ outcome, artifact, runtime } = savedCandidate); request.rawArtifact = savedCandidate.rawArtifact; target = 'artifact'; }
    else if (candidateIntent) { outcome = { status: 'failed', error: 'Candidate execution was interrupted with uncertain effects. Inspect the session and use a fresh trial.' }; target = 'artifact'; }
    if (target !== 'artifact') {
      await session.append({ type: 'block.output', data: { blockId: run.blockId, port: 'evaluation-candidate-intent', content: request.trialId } });
      const config = { ...(run.config.targetConfig as Record<string, JsonValue> ?? {}), model: run.config.model ?? 'openrouter/auto', modelFallbacks: [], inputOnly: true,
        ...(run.config.candidatePrompt != null ? { systemPrompt: run.config.candidatePrompt } : {}) };
      const candidateRun = { ...run, blockId: targetId, input: request.originalRequest, config, ceiling: [] };
      const began = Date.now();
      try {
        // Candidate input contains no expected fields, references, or Goal memory.
        outcome = target === 'task-graph' ? await executeTaskGraph(candidateRun, { plannerOnly: true })
          : await run.ctx.blocks.resolve('flyt-blocks-core:plan-start')!.execute(candidateRun);
      } catch (error) { outcome = { status: 'failed', output: '', error: String((error as Error).message) }; }
      let initial: any = null; const warnings: any[] = [], calls: any[] = [], responses: any[] = [], providerAttempts: any[] = [];
      for await (const event of session.read(run.context?.after)) {
        const data = event.data as any;
        if (!String(data.blockId ?? '').startsWith(targetId)) continue;
        if (event.type === 'block.output' && data.port === 'evaluation-initial') initial = JSON.parse(data.content);
        if (event.type === 'block.warning') warnings.push(data);
        if (event.type === 'llm.request') calls.push(data);
        if (event.type === 'llm.response') responses.push(data);
        if (event.type === 'llm.telemetry' && data.kind === 'call') providerAttempts.push(data);
      }
      if (!initial && responses.length && target === 'plan') {
        const first = responses[0]; let valid = false;
        try { parseListOutput(first.content ?? '', 'tasks'); valid = Boolean(first.content); } catch { /* preserve the production failure */ }
        initial = { text: first.content ?? '', channel: 'text', contractValid: valid, finishReason: first.finishReason ?? null };
      }
      const failedProviderAttempts = providerAttempts.filter(call => !call.ok).length;
      if (initial && providerAttempts[0]?.ok === false) initial = { ...initial, contractValid: false, precedingProviderFailure: providerAttempts[0].failure ?? providerAttempts[0].error };
      const measuredTokens = !failedProviderAttempts && responses.every(r => r.usage?.promptTokens != null && r.usage?.completionTokens != null) && responses.length > 0;
      const measuredCost = !failedProviderAttempts && responses.every(r => r.usage?.costUsd != null) && responses.length > 0;
      artifact = { text: outcome.output, channel: 'text' };
      runtime = { latencyMs: Date.now() - began, repairs: warnings.filter(w => w.code === 'invalid_task_graph').length,
        fallbacks: warnings.filter(w => w.code === 'task_graph_degraded').length, unresolved: outcome.status === 'done' ? 0 : 1,
        attempted: calls.length > 0, responses: responses.length, completed: outcome.status === 'done', cancelled: Boolean(run.signal?.aborted),
        initial, failedProviderAttempts, providerAttempts: providerAttempts.length || null, finalError: outcome.error ?? null, providerRequested: String(config.model), providerObserved: null,
        responseMode: target === 'task-graph' ? 'structured task graph' : 'text JSON array', promptMode: target === 'task-graph' ? 'supplement invariant guidance' : 'replace standing guidance; retain output contract',
        targetConfig: config, transformations: warnings.filter(w => w.transformations).map(w => w.transformations),
        tokens: measuredTokens ? responses.reduce((n, r) => n + r.usage.promptTokens + r.usage.completionTokens, 0) : null,
        knownUsd: measuredCost ? responses.reduce((n, r) => n + r.usage.costUsd, 0) : null };
      if (initial) request.rawArtifact = { text: initial.text, channel: initial.channel, ...(initial.channel === 'structured' ? { structured: initial.structured } : {}) };
      if (initial?.channel === 'structured' && !runtime.repairs && !runtime.fallbacks) artifact = { text: outcome.output, structured: initial.structured, channel: 'structured' };
      await session.append({ type: 'block.output', data: { blockId: run.blockId, port: 'evaluation-candidate', content: JSON.stringify({ outcome, artifact, runtime, rawArtifact: request.rawArtifact ?? null }) } });
    }
    request.artifact = artifact; request.runtime = runtime;
    const cache = new Map<string, any>(), intents = new Set<string>();
    for await (const event of session.read(run.context?.after)) {
      const data = event.data as any;
      if (data.blockId !== run.blockId) continue;
      if (event.type === 'block.output' && data.port === 'evaluation-effect') { const item = JSON.parse(data.content); cache.set(item.key, item.value); }
      if (event.type === 'block.output' && data.port === 'evaluation-intent') intents.add(data.content);
    }
    const once = async (key: string, effect: () => Promise<any>) => {
      if (cache.has(key)) return cache.get(key);
      if (intents.has(key)) throw new Error('Interrupted evaluation effect has uncertain outcome; inspect evidence and use a fresh verification trial');
      await session.append({ type: 'block.output', data: { blockId: run.blockId, port: 'evaluation-intent', content: key } });
      const value = await effect();
      await session.append({ type: 'block.output', data: { blockId: run.blockId, port: 'evaluation-effect', content: JSON.stringify({ key, value }) } });
      cache.set(key, value); return value;
    };
    const report = await evaluators.evaluate(request, {
      readFile: async path => {
        if (!run.ceiling.includes('read_file')) throw new Error('File verification requires the read_file grant');
        return run.ctx.fs.read(path, run.signal);
      },
      command: (config, key) => once(`command-${key}`, async () => {
        if (!run.ceiling.includes('bash')) throw new Error('Command verification requires the bash grant');
        const call = { id: `${run.blockId}-${key}`, name: 'bash', args: { command: config.command, timeoutMs: config.timeoutMs } };
        await session.append({ type: 'tool.call', data: { blockId: run.blockId, callId: call.id, name: call.name, args: call.args } });
        const value = await run.ctx.tools.execute({ runId: run.runId, blockId: run.blockId, step: 1, call, ceiling: run.ceiling, signal: run.signal });
        await session.append({ type: 'tool.result', data: { blockId: run.blockId, callId: call.id, name: call.name, content: value.content ?? '', result: value.durableResult ?? null, handle: value.handle ?? null, error: value.error ?? null } });
        // Model previews include retrieval notes and may be truncated. Evaluate
        // only the canonical structured result, retaining the event handle.
        const data: any = value.durableResult ?? (value.error ? {} : JSON.parse(value.content ?? '{}'));
        return { ...data, ...(value.error ? { errorCode: data.errorCode ?? 'tool_error', error: value.error } : {}), handle: value.handle ?? null, stdout: String(data.stdout ?? '').slice(0, 8000), stderr: String(data.stderr ?? '').slice(0, 2000) };
      }),
      judge: (packet, config, key) => once(`judge-${key}-${digest(packet)}`, async () => {
        let error = '', raw = '';
        for (let attempt = 0; attempt <= (config.repairs ?? 0); attempt++) {
          const response = await runAgentLoop({ ctx: run.ctx, session, runId: run.runId, blockId: `${run.blockId}-judge-${key}-${attempt}`, turn: attempt + 1,
            model: config.model, fallbackModels: [], system: `${JUDGE_SYSTEM}\nFIXED RUBRIC: ${JSON.stringify({ rubric: config.rubric, dimensions: config.dimensions })}`,
            input: JSON.stringify({ data: packet, ...(error ? { formattingError: error } : {}) }),
            tools: [], ceiling: [], maxSteps: 1, maxTokens: 8192, temperature: 0, isolated: true, signal: run.signal });
          raw = response.content;
          if (response.stopped !== 'answered' || response.finishReason === 'length' || response.finishReason === 'content_filter') throw new Error(`Judge did not complete: ${response.reason ?? response.finishReason ?? response.stopped}`);
          try { return JSON.parse(raw); } catch { error = 'Return one strictly valid JSON object, with the fixed dimension schema.'; }
        }
        throw new Error(`Invalid judge JSON after bounded repair: ${raw.slice(0, 500)}`);
      }),
    });
    // Production/provider failure is required execution evidence, never a pass
    // merely because an empty output happens to satisfy an optional check.
    if (outcome && outcome.status !== 'done') {
      report.checks.push({ name: 'candidate-execution', mandatory: true, status: run.signal?.aborted ? 'skipped' : 'error', code: run.signal?.aborted ? 'cancelled' : 'candidate_execution_error', explanation: String(outcome.error ?? 'Incomplete execution').slice(0, 1600) });
      report.eligible = false; report.comparable = false; report.status = run.signal?.aborted ? 'inconclusive' : 'error';
    }
    validateResult(report);
    let modelCalls = 0, knownUsd = 0, unknownCost = 0, providerCalls = 0;
    for await (const event of session.read(run.context?.after)) {
      const data = event.data as any;
      if (!String(data.blockId ?? '').startsWith(run.blockId)) continue;
      if (event.type === 'llm.request') { modelCalls++; unknownCost++; }
      if (event.type === 'llm.telemetry' && data.kind === 'call') providerCalls++;
      if (event.type === 'llm.response' && typeof data.usage?.costUsd === 'number') { knownUsd += data.usage.costUsd; unknownCost--; }
    }
    if (providerCalls > modelCalls) { unknownCost += providerCalls - modelCalls; modelCalls = providerCalls; }
    report.execution = { durationMs: report.execution.durationMs + (runtime.latencyMs ?? 0), modelCalls, knownUsd, unknownUsage: unknownCost ? [`${unknownCost} calls with unknown cost; provider retries are accounted by the owning Goal`] : [] };
    const output = JSON.stringify({ ...report, artifact, runtime });
    return { status: 'done', output, structured: { eligible: report.eligible, status: report.status, report: output, comparison: report.comparison ?? 'inconclusive' } };
  },
};
