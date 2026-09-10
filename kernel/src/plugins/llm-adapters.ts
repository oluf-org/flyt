/**
 * `flyt-adapters` — `ctx.llm` over the adapters that already exist.
 *
 * The seam is new; the providers are not. `core/adapters/` has been calling
 * OpenRouter, Anthropic, OpenAI, Kimi and two CLI delegations for a year, with
 * the retry budget, the idle deadline, the streamed-character accounting and
 * the aborted-spend record all in it. Reimplementing any of that against the
 * seam would be a second set of bugs in the same shape.
 *
 * So this is a BRIDGE, and it is deliberately thin: translate the request,
 * translate the answer, and let the thing that knows how to talk to providers
 * do the talking. The one thing it adds is the route record — the honest
 * account of what was asked for, what answered, and whether that is what the
 * caller wanted (D40). A degraded fallback that renders like a success is the
 * failure mode Trace exists to prevent, and it can only be prevented by the
 * layer that can see both halves.
 *
 * Injected rather than imported: the kernel is TypeScript and `core/` is JS,
 * and the boundary is the seam (D53). A static import of `core/adapters` from
 * here would put the JS core inside the typed tree and make the direction of
 * the dependency exactly backwards.
 *
 * @module #kernel/plugins/llm-adapters
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FailureMetadata, JsonValue, ProviderReplay, Usage } from '../types.js';
import type { LlmChunk, RouteRecord } from '../events.js';
import type { LlmRequest, LlmResponse, LlmSeam, LlmStream, ModelInfo } from '../seams/llm.js';
import { provideSeam } from '../seams/index.js';
import {
  defaultModelCapabilityRegistry, manageContextBudget, type ModelCapabilityProfile,
} from '../models/capabilities.js';

/** What the JS core's `callModel` accepts, as much of it as this bridge uses. */
export interface CallModel {
  (request: {
    provider: string;
    model: string;
    messages?: unknown;
    system?: string;
    prompt?: string;
    tools?: unknown;
    maxTokens?: number;
    temperature?: number;
    apiKey?: string;
    keyKind?: string;
    cliHome?: string;
    cliPath?: string;
    retry?: { attempts?: number; baseMs?: number; maxMs?: number };
    responseFormat?: { name: string; description?: string; schema: JsonValue; strict?: boolean };
    reasoning?: { effort?: string; mode?: string; context?: string; summary?: string };
    toolChoice?: unknown;
    signal?: AbortSignal;
    onRetry?: (record: Record<string, unknown>) => void;
    onCall?: (record: Record<string, unknown>) => void;
    requestedOutputBudget?: number;
    effectiveOutputBudget?: number;
    contextUtilization?: number;
    contextTokens?: number;
    contextLimit?: number;
    onText?: (text: string, options?: {
      final?: boolean;
      content?: string;
      reasoning?: string;
      telemetry?: { contentChars?: number; reasoningChars?: number; toolInputChars?: number };
      toolInputEvents?: readonly {
        phase: 'start' | 'delta' | 'end';
        index: number;
        id?: string;
        name?: string;
        delta?: string;
        arguments?: string;
      }[];
    }) => void;
  }): Promise<{
    text?: string;
    reasoning?: string;
    usage?: unknown;
    finishReason?: string | null;
    resolvedModel?: string | null;
    provider?: string;
    model?: string;
    unparsedToolCall?: string | null;
    replay?: ProviderReplay;
    message?: { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
  }>;
}

/** How a model id becomes a provider and a key. `core/modelSource.js` already knows. */
export interface ResolveSource {
  (model: string): {
    provider: string; model: string; apiKey?: string; reason?: string;
    keyKind?: string; cliHome?: string; cliPath?: string;
  } | null;
}

/** What this plugin is given. Both come from the JS core; neither is imported. */
export interface LlmAdaptersConfig {
  callModel: CallModel;
  resolve: ResolveSource;
  /** What the seam can reach, for `models()`. */
  models?: () => Promise<ModelInfo[]> | ModelInfo[];
  capability?: (model: string, provider: string) => Promise<ModelCapabilityProfile> | ModelCapabilityProfile;
  resolveAsset?: (assetId: string, request: LlmRequest) => Promise<{ dataUrl: string; estimatedTokens: number; byteLength: number }>;
  maxMessageChars?: number;
  checkpointInputTokens?: number;
}

/** Cordis plugin name. */
export const name = 'flyt-adapters';

/** OpenAI-shaped tool schemas, which is what every adapter here speaks. */
function toolsFor(request: LlmRequest): unknown {
  if (!request.tools?.length) return undefined;
  return request.tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Translate the kernel's provider-neutral messages to OpenAI chat wire shape. */
function messagesFor(request: LlmRequest, messages = request.messages, assets = new Map<string, string>()): unknown[] {
  return messages.map(message => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant', content: message.content || null,
        ...(message.replay ? { replay: message.replay } : {}),
        tool_calls: message.toolCalls.map(call => ({
          id: call.id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool', content: message.content,
        tool_call_id: message.toolCallId ?? '',
        ...(message.name ? { name: message.name } : {}),
        ...(message.handle ? { handle: message.handle } : {}),
      };
    }
    return { role: message.role, content: message.parts ? message.parts.map(part => part.type === 'text' ? part : { type: 'image_url', image_url: { url: assets.get(part.assetId) ?? `asset:${part.assetId}` } }) : message.content, ...(message.replay ? { replay: message.replay } : {}) };
  });
}

function usageFrom(raw: unknown): Usage | undefined {
  const u = raw as Record<string, unknown> | null;
  if (!u) return undefined;
  const n = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const usage: Usage = {};
  const input = n(u.prompt_tokens) ?? n(u.input_tokens);
  const output = n(u.completion_tokens) ?? n(u.output_tokens);
  if (input !== undefined) usage.promptTokens = input;
  if (output !== undefined) usage.completionTokens = output;
  const reasoning = n((u.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  const cached = n((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  if (cached !== undefined) usage.cachedTokens = cached;
  const cacheWrite = n((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cache_write_tokens)
    ?? n(u.cache_write_tokens);
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  const cost = n(u.cost) ?? n(u.total_cost);
  if (cost !== undefined) usage.costUsd = cost;
  return usage;
}

/**
 * The honest account of who answered.
 *
 * `degraded` is true when what answered is not what was asked for — a different
 * provider from the one named, or the Auto Router resolving to a model the
 * caller never mentioned. Not an error, and not something to hide: a person
 * reading a surprising answer asks this question first, and a surface that
 * cannot answer it will be believed anyway.
 */
export function routeOf(
  requested: string,
  answered: { provider?: string; model?: string; resolvedModel?: string | null },
  reason = '',
): RouteRecord {
  const effective = `${answered.provider ?? '?'}/${answered.resolvedModel || answered.model || '?'}`;
  const asked = requested.includes('/') ? requested : `?/${requested}`;
  const degraded = !effective.endsWith(`/${requested}`) && effective !== asked;
  return {
    requested,
    effective,
    reason: reason || (degraded
      ? 'the provider answered as a different model than the one requested'
      : 'the model asked for is the model that answered'),
    degraded,
  };
}

/** A finish reason the event contract recognises. Anything else is `unknown`. */
function finishOf(raw: string | null | undefined): LlmResponse['finishReason'] {
  const known = ['stop', 'length', 'tool_calls', 'content_filter', 'error'];
  return known.includes(String(raw)) ? String(raw) : 'unknown';
}

/**
 * Provide `ctx.llm`.
 *
 * @param ctx — the context to provide in.
 * @param config — the JS core's `callModel` and model resolver.
 * @returns a disposer withdrawing the seam.
 */
export function apply(ctx: Context, config: LlmAdaptersConfig): () => void {
  if (typeof config?.callModel !== 'function') throw new Error('flyt-adapters needs a callModel');
  if (typeof config?.resolve !== 'function') throw new Error('flyt-adapters needs a model resolver');

  type TextOptions = Parameters<NonNullable<Parameters<CallModel>[0]['onText']>>[1];
  const failureOf = (error: unknown, source: ReturnType<ResolveSource>, request: LlmRequest, extra: Partial<FailureMetadata> = {}): FailureMetadata => {
    const raw = error as { failure?: Partial<FailureMetadata>; message?: string; failureCode?: string };
    const inherited = raw?.failure ?? {};
    return {
      code: String(inherited.code ?? raw?.failureCode ?? 'unknown'),
      source: String(inherited.source ?? 'provider'),
      provider: inherited.provider ?? source?.provider ?? null,
      model: inherited.model ?? source?.model ?? request.model,
      callId: inherited.callId ?? null,
      step: inherited.step ?? null,
      retryable: Boolean(inherited.retryable),
      userInitiated: Boolean(inherited.userInitiated ?? request.signal?.aborted),
      visibleOutputProduced: Boolean(extra.visibleOutputProduced ?? inherited.visibleOutputProduced),
      reasoningOutputProduced: Boolean(extra.reasoningOutputProduced ?? inherited.reasoningOutputProduced),
      toolCallProduced: Boolean(extra.toolCallProduced ?? inherited.toolCallProduced),
      durableWriteProduced: Boolean(extra.durableWriteProduced ?? inherited.durableWriteProduced),
      detail: inherited.detail ?? String(raw?.message ?? error).slice(0, 500),
      remedy: inherited.remedy ?? null,
    };
  };
  const complete = async (
    request: LlmRequest,
    onText?: (text: string, options?: TextOptions) => void,
  ): Promise<LlmResponse> => {
    const candidates = [request.model, ...(request.fallbackModels ?? [])]
      .filter((model, index, all) => Boolean(model) && all.indexOf(model) === index);
    let source: ReturnType<ResolveSource> = null;
    let answered: Awaited<ReturnType<CallModel>> | null = null;
    let fallbackReason = '';
    const failures: string[] = [];
    let lastFailure: unknown = null;

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      source = null;
      let emittedVisible = false;
      let emittedReasoning = false;
      let emittedToolInput = false;
      const telemetryWrites: Promise<unknown>[] = [];
      try {
        source = config.resolve(candidate);
        if (!source?.provider) {
          throw new Error(`No connected provider can serve "${candidate}".`);
        }
        await request.onAttempt?.({
          index, model: candidate, provider: source.provider, resolvedModel: source.model,
          status: 'started',
        });
        const profile = await config.capability?.(source.model, source.provider)
          ?? defaultModelCapabilityRegistry.get(source.model, source.provider);
        const imageIds = request.messages.flatMap(message => message.parts?.filter(part => part.type === 'image').map(part => part.assetId) ?? []);
        const assets = new Map<string, string>();
        const imageBudgets: { handle: string; estimatedTokens: number }[] = [];
        if (imageIds.length) {
          if (!['openai', 'openrouter', 'anthropic', 'codex', 'mock'].includes(source.provider)) throw new Error(`Image transport is not implemented for ${source.provider}. Choose an image-capable API model; your attachments are retained.`);
          if (source.provider !== 'mock' && profile.modalities.image.value !== true) throw new Error(`Image support for ${source.provider}/${source.model} is ${profile.modalities.image.value === false ? 'unavailable' : 'unknown'}. Choose a verified image-capable model; your attachments are retained.`);
          if (source.provider === 'codex' && request.tools?.length) throw new Error('Codex image delegation cannot execute Flyt tools. Choose an API model for this worker.');
          if (!config.resolveAsset) throw new Error('No scoped asset resolver is available');
          let bytes = 0;
          for (const id of new Set(imageIds)) {
            const asset = await config.resolveAsset(id, request);
            assets.set(id, asset.dataUrl); bytes += asset.byteLength;
            imageBudgets.push({ handle: id, estimatedTokens: asset.estimatedTokens * imageIds.filter(value => value === id).length });
          }
          // Conservative wire limit, including base64 overhead; never truncate evidence.
          if (imageIds.length > 10 || bytes * 4 / 3 > 20 * 1024 ** 2) throw new Error('Image request exceeds the transport budget (10 images / 20 MiB encoded). Use smaller images.');
        }
        const offeredTools = [...(request.tools ?? [])];
        const structured = request.structuredOutput;
        const canSchema = structured && profile.structuredOutput.jsonSchema.value === true;
        const canSynthetic = structured && !canSchema && profile.tools.native.value === true;
        const structuredMode = canSchema ? 'provider_json_schema' : canSynthetic ? 'synthetic_tool' : structured ? 'textual_json' : 'none';
        const acceptedReasoning = new Set(profile.reasoning.acceptedRequestFields.value);
        const endpointReasoning = source.provider === 'openai'
          ? new Set(['reasoning.effort'])
          : ['openrouter', 'anthropic'].includes(source.provider)
            ? new Set(['reasoning.effort'])
            : null;
        const effectiveReasoning = request.reasoning ? Object.fromEntries(Object.entries(request.reasoning).filter(([key, value]) =>
          value !== undefined
          && (acceptedReasoning.has(`reasoning.${key}`) || profile.reasoning.acceptedRequestFields.confidence === 'unknown')
          && (!endpointReasoning || endpointReasoning.has(`reasoning.${key}`))))
          : undefined;
        if (canSynthetic) offeredTools.push({
          name: structured.name,
          description: structured.description ?? 'Submit the validated structured response.',
          parameters: structured.schema,
        });
        const candidateMessages = structured && !canSchema && !canSynthetic
          ? [...request.messages, {
              role: 'system' as const,
              content: `This provider has no usable native structured channel. Return only the JSON value matching schema "${structured.name}" as a textual fallback; do not wrap it in prose or a code fence.`,
            }]
          : request.messages;
        const budget = manageContextBudget({
          messages: candidateMessages,
          tools: offeredTools,
          attachments: [...(request.attachments ?? []), ...imageBudgets],
          requestedOutput: request.maxTokens,
          profile,
          checkpointInputTokens: Math.min(request.checkpointInputTokens ?? Infinity, config.checkpointInputTokens ?? Infinity),
          maxMessageChars: config.maxMessageChars,
          measureMessages: messages => JSON.stringify(messagesFor(request, messages)).length,
        });
        if (structured) budget.resolutions.push({
          field: 'structured_output', requested: 'json_schema',
          modelLimit: profile.structuredOutput.jsonSchema.value,
          providerLimit: profile.structuredOutput.syntheticTool.value,
          effective: structuredMode,
          reason: canSchema
            ? 'the model/provider reports native JSON Schema support'
            : canSynthetic
              ? 'native schema was unavailable, so the reserved submission tool is forced'
              : 'neither native schema nor native tool submission is known usable',
        });
        for (const [key, value] of Object.entries(request.reasoning ?? {})) {
          if (value === undefined) continue;
          const path = `reasoning.${key}`;
          const accepted = Object.hasOwn(effectiveReasoning ?? {}, key);
          budget.resolutions.push({
            field: path, requested: value, modelLimit: key === 'effort' ? profile.reasoning.variants.value : null,
            providerLimit: endpointReasoning ? [...endpointReasoning] : profile.reasoning.acceptedRequestFields.value,
            effective: accepted ? value : null,
            reason: accepted ? 'the attributed model/provider contract accepts this request field' : 'unsupported request field was omitted before dispatch',
          });
        }
        await request.onBudget?.(budget);
        if (budget.messages.some(message => message.parts && message.parts.filter(part => part.type === 'text').map(part => part.text).join('') !== message.content)) throw new Error('Image message text exceeds the context budget. Shorten the message.');
        const retainedImages = budget.messages.flatMap(message => message.parts?.filter(part => part.type === 'image').map(part => part.assetId) ?? []);
        if (imageIds.some(id => !retainedImages.includes(id))) throw new Error('Context compaction would remove required images. Start a shorter conversation.');
        if (imageIds.length) await request.onTelemetry?.({ kind: 'assets', mode: 'native', assetIds: [...new Set(imageIds)], provider: source.provider, model: source.model });
        answered = await config.callModel({
          provider: source.provider,
          model: source.model,
          messages: messagesFor(request, budget.messages, assets),
          ...(source.apiKey ? { apiKey: source.apiKey } : {}),
          ...(source.keyKind ? { keyKind: source.keyKind } : {}),
          ...(source.cliHome ? { cliHome: source.cliHome } : {}),
          ...(source.cliPath ? { cliPath: source.cliPath } : {}),
          ...(offeredTools.length ? { tools: offeredTools.map(t => ({
            type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters },
          })) } : {}),
          maxTokens: budget.effectiveOutput,
          ...(canSchema ? { responseFormat: structured } : {}),
          ...(canSynthetic ? { toolChoice: { type: 'function', function: { name: structured.name } } } : {}),
          ...(effectiveReasoning && Object.keys(effectiveReasoning).length ? { reasoning: effectiveReasoning } : {}),
          onRetry: record => {
            if (request.onTelemetry) telemetryWrites.push(Promise.resolve(request.onTelemetry({ kind: 'retry', ...(record as Record<string, JsonValue>) })));
          },
          onCall: record => {
            if (request.onTelemetry) telemetryWrites.push(Promise.resolve(request.onTelemetry({ kind: 'call', ...(record as Record<string, JsonValue>) })));
          },
          requestedOutputBudget: budget.requestedOutput,
          effectiveOutputBudget: budget.effectiveOutput,
          contextUtilization: budget.contextUtilization,
          contextTokens: budget.effective.total,
          contextLimit: budget.contextLimit,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.retry ? { retry: request.retry } : {}),
          // An explicit fallback chain is already the retry budget at this
          // layer. Intermediate candidates get one provider attempt so a 429
          // becomes a visible fallback promptly; the final candidate retains
          // the core adapter's ordinary retry/backoff resilience.
          ...(index < candidates.length - 1 ? { retry: { attempts: 1 } } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          ...(onText ? { onText: (text: string, options?: TextOptions) => {
            const telemetry = options?.telemetry ?? {};
            emittedVisible ||= Number(telemetry.contentChars ?? 0) > 0
              || (options?.content === undefined && Boolean(text) && !String(text).startsWith('⟢ thinking…'));
            emittedReasoning ||= Number(telemetry.reasoningChars ?? 0) > 0 || Boolean(options?.reasoning);
            emittedToolInput ||= Number(telemetry.toolInputChars ?? 0) > 0 || Boolean(options?.toolInputEvents?.length);
            onText(text, options);
          } } : {}),
        });
        await Promise.allSettled(telemetryWrites);
        await request.onAttempt?.({
          index, model: candidate, provider: answered.provider ?? source.provider,
          resolvedModel: answered.resolvedModel || answered.model || source.model,
          status: 'succeeded',
        });
        if (index > 0) {
          fallbackReason = `the configured Free fallback ${candidate} answered after ${failures.join('; ')}`;
        }
        break;
      } catch (error) {
        await Promise.allSettled(telemetryWrites);
        lastFailure = error;
        const message = String((error as Error)?.message ?? error).replace(/\s+/g, ' ').slice(0, 500);
        failures.push(`${candidate} failed: ${message}`);
        const failure = failureOf(error, source, request, {
          visibleOutputProduced: emittedVisible,
          reasoningOutputProduced: emittedReasoning,
          toolCallProduced: emittedToolInput,
        });
        if (error && typeof error === 'object') (error as { failure?: FailureMetadata }).failure = failure;
        await request.onAttempt?.({
          index, model: candidate,
          ...(source?.provider ? { provider: source.provider } : {}),
          ...(source?.model ? { resolvedModel: source.model } : {}),
          status: 'failed', error: message, failure,
        });
        // Never combine text from two models in one visible stream, and never
        // turn an explicit cancellation into another provider call.
        if (emittedVisible || emittedToolInput || request.signal?.aborted || index === candidates.length - 1) throw error;
      }
    }
    if (!answered || !source) throw lastFailure ?? new Error(`No connected provider can serve "${request.model}".`);

    const calls = answered.message?.tool_calls ?? [];
    const structuredCall = request.structuredOutput
      ? calls.find(call => call.function?.name === request.structuredOutput?.name)
      : undefined;
    const structuredOutput = structuredCall
      ? parseArgs(structuredCall.function?.arguments)
      : request.structuredOutput ? parseStructured(answered.text) : undefined;
    const ordinaryCalls = structuredCall ? calls.filter(call => call !== structuredCall) : calls;
    return {
      content: answered.text ?? '',
      ...(answered.reasoning ? { reasoning: answered.reasoning } : {}),
      ...(ordinaryCalls.length ? {
        toolCalls: ordinaryCalls.map((c, i) => ({
          id: String(c.id ?? `call-${i}`),
          name: String(c.function?.name ?? ''),
          // Arguments arrive as a JSON STRING. A call whose arguments will not
          // parse is still a call the model made, and the gate has to see it —
          // dropping it here would look to everyone downstream like the model
          // never asked.
          args: parseArgs(c.function?.arguments),
        })),
      } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(answered.replay ? { replay: answered.replay } : {}),
      ...(answered.unparsedToolCall ? { unparsedToolCall: answered.unparsedToolCall } : {}),
      finishReason: finishOf(answered.finishReason),
      ...(usageFrom(answered.usage) ? { usage: usageFrom(answered.usage) } : {}),
      route: routeOf(request.model, answered, fallbackReason || source.reason || ''),
    };
  };

  const seam: LlmSeam = {
    complete: request => complete(request),

    /**
     * Stream, and settle with the whole record.
     *
     * The adapters below deliver the WHOLE TURN on each emission rather than a
     * delta, so the chunk this yields is the difference — a consumer that
     * concatenated what it was given would count the turn quadratically.
     */
    stream(request: LlmRequest): LlmStream {
      const queue: LlmChunk[] = [];
      let wake: (() => void) | null = null;
      let seen = '';
      let seenContent = '';
      let seenReasoning = '';
      let done = false;
      let failure: unknown = null;
      let nextInputId = 0;
      const activeInputs = new Map<number, string>();

      const push = (chunk: LlmChunk): void => { queue.push(chunk); wake?.(); wake = null; };
      const settledPromise = complete(request, (whole, options) => {
        for (const event of options?.toolInputEvents ?? []) {
          let inputId = activeInputs.get(event.index);
          if (event.phase === 'start' || !inputId) {
            inputId = `input-${++nextInputId}`;
            activeInputs.set(event.index, inputId);
            // A provider should start before it sends a delta/end. Preserve a
            // useful lifecycle even for a third-party bridge that does not.
            if (event.phase !== 'start') push({ toolInput: {
              inputId, index: event.index, phase: 'start',
              ...(event.id ? { toolCallId: event.id } : {}),
              ...(event.name ? { name: event.name } : {}),
            } });
          }
          push({ toolInput: {
            inputId, index: event.index, phase: event.phase,
            ...(event.id ? { toolCallId: event.id } : {}),
            ...(event.name ? { name: event.name } : {}),
            ...(event.delta !== undefined ? { delta: event.delta } : {}),
            ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
          } });
          if (event.phase === 'end') activeInputs.delete(event.index);
        }
        if (typeof options?.content === 'string' || typeof options?.reasoning === 'string') {
          if (typeof options.reasoning === 'string') {
            const delta = options.reasoning.startsWith(seenReasoning)
              ? options.reasoning.slice(seenReasoning.length) : '';
            seenReasoning = options.reasoning;
            if (delta) push({ reasoning: delta });
          }
          if (typeof options.content === 'string') {
            const delta = options.content.startsWith(seenContent)
              ? options.content.slice(seenContent.length) : '';
            seenContent = options.content;
            if (delta) push({ text: delta });
          }
          seen = whole ?? '';
          return;
        }
        if (typeof whole !== 'string' || !whole.startsWith(seen)) { seen = whole ?? ''; return; }
        const delta = whole.slice(seen.length);
        seen = whole;
        if (delta) push({ text: delta });
      }).then(
        answer => { done = true; wake?.(); wake = null; return answer; },
        err => { failure = err; done = true; wake?.(); wake = null; throw err; },
      );
      // Nobody may await this later and find an unhandled rejection from now.
      settledPromise.catch(() => {});

      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length) yield queue.shift() as LlmChunk;
            if (done) {
              if (failure) throw failure;
              return;
            }
            await new Promise<void>(resolve => { wake = resolve; });
          }
        },
        settled: () => settledPromise,
      };
    },

    async models(): Promise<ModelInfo[]> {
      return (await config.models?.()) ?? [];
    },
    async capability(model: string): Promise<ModelCapabilityProfile> {
      const source = config.resolve(model);
      if (!source?.provider) return defaultModelCapabilityRegistry.get(model);
      return await config.capability?.(source.model, source.provider)
        ?? defaultModelCapabilityRegistry.get(source.model, source.provider);
    },
  };

  return provideSeam(ctx, 'llm', seam);
}

function parseArgs(raw: unknown): import('../types.js').JsonValue {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return raw as import('../types.js').JsonValue;
  try { return JSON.parse(raw); } catch { return { _unparsed: raw }; }
}

function parseStructured(raw: unknown): JsonValue | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try { return JSON.parse(raw) as JsonValue; } catch { return undefined; }
}
