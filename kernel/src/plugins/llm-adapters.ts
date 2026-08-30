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
import type { Usage } from '../types.js';
import type { LlmChunk, RouteRecord } from '../events.js';
import type { LlmRequest, LlmResponse, LlmSeam, LlmStream, ModelInfo } from '../seams/llm.js';
import { provideSeam } from '../seams/index.js';

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
    signal?: AbortSignal;
    onText?: (text: string, options?: { final?: boolean }) => void;
  }): Promise<{
    text?: string;
    reasoning?: string;
    usage?: unknown;
    finishReason?: string | null;
    resolvedModel?: string | null;
    provider?: string;
    model?: string;
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

  const complete = async (request: LlmRequest, onText?: (t: string) => void): Promise<LlmResponse> => {
    const candidates = [request.model, ...(request.fallbackModels ?? [])]
      .filter((model, index, all) => Boolean(model) && all.indexOf(model) === index);
    let source: ReturnType<ResolveSource> = null;
    let answered: Awaited<ReturnType<CallModel>> | null = null;
    let fallbackReason = '';
    let lastFailure: unknown = null;

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      let emittedText = false;
      try {
        source = config.resolve(candidate);
        if (!source?.provider) {
          throw new Error(`No connected provider can serve "${candidate}".`);
        }
        answered = await config.callModel({
          provider: source.provider,
          model: source.model,
          messages: request.messages,
          ...(source.apiKey ? { apiKey: source.apiKey } : {}),
          ...(source.keyKind ? { keyKind: source.keyKind } : {}),
          ...(source.cliHome ? { cliHome: source.cliHome } : {}),
          ...(source.cliPath ? { cliPath: source.cliPath } : {}),
          ...(toolsFor(request) ? { tools: toolsFor(request) } : {}),
          ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          ...(onText ? { onText: (text: string) => { emittedText = true; onText(text); } } : {}),
        });
        if (index > 0) {
          fallbackReason = `the configured Free fallback ${candidate} answered after ${index} earlier candidate${index === 1 ? '' : 's'} failed before output`;
        }
        break;
      } catch (error) {
        lastFailure = error;
        // Never combine text from two models in one visible stream, and never
        // turn an explicit cancellation into another provider call.
        if (emittedText || request.signal?.aborted || index === candidates.length - 1) throw error;
      }
    }
    if (!answered || !source) throw lastFailure ?? new Error(`No connected provider can serve "${request.model}".`);

    const calls = answered.message?.tool_calls ?? [];
    return {
      content: answered.text ?? '',
      ...(answered.reasoning ? { reasoning: answered.reasoning } : {}),
      ...(calls.length ? {
        toolCalls: calls.map((c, i) => ({
          id: String(c.id ?? `call-${i}`),
          name: String(c.function?.name ?? ''),
          // Arguments arrive as a JSON STRING. A call whose arguments will not
          // parse is still a call the model made, and the gate has to see it —
          // dropping it here would look to everyone downstream like the model
          // never asked.
          args: parseArgs(c.function?.arguments),
        })),
      } : {}),
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
      let done = false;
      let failure: unknown = null;

      const push = (chunk: LlmChunk): void => { queue.push(chunk); wake?.(); wake = null; };
      const settledPromise = complete(request, whole => {
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
  };

  return provideSeam(ctx, 'llm', seam);
}

function parseArgs(raw: unknown): import('../types.js').JsonValue {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return raw as import('../types.js').JsonValue;
  try { return JSON.parse(raw); } catch { return { _unparsed: raw }; }
}
