/**
 * `ctx.llm` — model requests, and the honest record of who answered.
 *
 * A degraded fallback is never silent: the route record names what was
 * requested, what answered, and why that rung won.
 *
 * @module #kernel/seams/llm
 */
import type { Message, Usage } from '../types.js';
import type { LlmChunk, RouteRecord } from '../events.js';

/** One model request. */
export interface LlmRequest {
  /** The model id as the caller asked for it, before routing. */
  model: string;
  messages: readonly Message[];
  /** Tool schemas offered for this request — the ceiling, already applied. */
  tools?: readonly { name: string; description: string; parameters: unknown }[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** A settled model response. */
export interface LlmResponse {
  content: string;
  reasoning?: string;
  toolCalls?: readonly { id: string; name: string; args: unknown }[];
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
}

/** The seam. Providers: `flyt-adapters-*`, one per provider family. */
export interface LlmSeam {
  /** Stream a request, chunk by chunk. */
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
  /** Run a request to completion. */
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** What this seam can reach right now, including what it cannot and why. */
  models(): Promise<ModelInfo[]>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmSeam;
  }
}
