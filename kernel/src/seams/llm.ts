/**
 * `ctx.llm` — model requests, and the honest record of who answered.
 *
 * A degraded fallback is never silent: the route record names what was
 * requested, what answered, and why that rung won.
 *
 * @module #kernel/seams/llm
 */
import type { FailureMetadata, Message, Usage } from '../types.js';
import type { JsonValue, ProviderReplay } from '../types.js';
import type { LlmChunk, RouteRecord } from '../events.js';
import type {
  AttachmentBudget, ContextBudgetDecision, ModelCapabilityProfile,
} from '../models/capabilities.js';

/** One durable change in the provider/model attempt ladder for a request. */
export interface LlmAttempt {
  index: number;
  model: string;
  provider?: string;
  resolvedModel?: string;
  status: 'started' | 'failed' | 'succeeded';
  error?: string;
  retryDelayMs?: number;
  reason?: string;
  failure?: FailureMetadata;
}

export interface StructuredOutputRequest {
  name: string;
  description?: string;
  schema: JsonValue;
  strict?: boolean;
}

export interface ReasoningRequest {
  effort?: string;
  mode?: string;
  context?: string;
  summary?: string;
}

/** One model request. */
export interface LlmRequest {
  /** The model id as the caller asked for it, before routing. */
  model: string;
  /** Ordered, same-budget alternatives. The seam tries these only if the
   * primary fails before producing any streamed text. */
  fallbackModels?: readonly string[];
  messages: readonly Message[];
  /** Tool schemas offered for this request — the ceiling, already applied. */
  tools?: readonly { name: string; description: string; parameters: unknown }[];
  temperature?: number;
  maxTokens?: number;
  attachments?: readonly AttachmentBudget[];
  structuredOutput?: StructuredOutputRequest;
  reasoning?: ReasoningRequest;
  /** Adapter retries for this request. Task schedulers may own this budget. */
  retry?: { attempts?: number; baseMs?: number; maxMs?: number };
  /** Compact model-visible history once estimated input reaches this threshold. */
  checkpointInputTokens?: number;
  signal?: AbortSignal;
  /** Observability hook. The runner persists each callback before continuing. */
  onAttempt?: (attempt: LlmAttempt) => Promise<void> | void;
  /** The exact requested/effective budget record, emitted before dispatch. */
  onBudget?: (decision: ContextBudgetDecision) => Promise<void> | void;
  /** Transport/retry telemetry from the provider adapter. */
  onTelemetry?: (record: Record<string, JsonValue>) => Promise<void> | void;
}

/** A settled model response. */
export interface LlmResponse {
  content: string;
  reasoning?: string;
  toolCalls?: readonly { id: string; name: string; args: unknown }[];
  structuredOutput?: JsonValue;
  replay?: ProviderReplay;
  /** Provider-native tool markup that reached content instead of a parsed call.
   * Kept as evidence so the loop can request one native-call repair without
   * guessing arguments or pretending the attempted tool ran. */
  unparsedToolCall?: string;
  finishReason: string;
  usage?: Usage;
  route: RouteRecord;
}

/** One model the seam can reach. */
export interface ModelInfo {
  id: string;
  provider: string;
  /** False when the provider is configured but unreachable — stated, not hidden. */
  available: boolean;
  /** Why it is unavailable, when it is. */
  unavailableReason?: string;
  capability?: ModelCapabilityProfile;
}

/**
 * A streaming request in flight.
 *
 * Iterating gives the chunks; `settled()` gives what the request ended as.
 * Both, because the scheduler needs both and a caller that has to choose is a
 * caller that logs a stream it cannot price or prices a call it cannot show.
 * D55 asks for the whole record — finish reason, usage and route included —
 * and D40 asks for the reasoning kept apart from the content; neither survives
 * a stream that ends by simply stopping.
 */
export interface LlmStream extends AsyncIterable<LlmChunk> {
  /** Resolves when the stream ends, with the same record `complete()` returns. */
  settled(): Promise<LlmResponse>;
}

/** The seam. Providers: `flyt-adapters-*`, one per provider family. */
export interface LlmSeam {
  /** Stream a request, chunk by chunk, and settle with the whole record. */
  stream(request: LlmRequest): LlmStream;
  /** Run a request to completion. */
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** What this seam can reach right now, including what it cannot and why. */
  models(): Promise<ModelInfo[]>;
  /** Complete attributed facts, including explicit unknowns. */
  capability(model: string): Promise<ModelCapabilityProfile>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmSeam;
  }
}
