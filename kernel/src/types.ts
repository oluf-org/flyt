/**
 * Types shared across the seams. Deliberately small: a seam should describe a
 * capability, not drag a domain model behind it.
 *
 * @module #kernel/types
 */

/** Anything that survives a round trip through the session log. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Who produced a message. `tool` carries a tool result back to the model. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** One model-visible message. Reconstructable from the log, or it did not happen (D55). */
export interface Message {
  role: MessageRole;
  /** The text the model saw. Reasoning is kept apart from content (D40). */
  content: string;
  /** Reasoning, when the provider returned it separately from content. */
  reasoning?: string;
  /** Tool calls this assistant message requested. */
  toolCalls?: ToolCall[];
  /** For a `tool` message, the call it answers. */
  toolCallId?: string;
  /** For a `tool` message, the tool that produced it. */
  name?: string;
  /** Durable artifact handle for a bounded tool preview. */
  handle?: string;
  /** Opaque provider-native items required to replay signed/encrypted reasoning. */
  replay?: ProviderReplay;
}

/** Provider-native replay data. It is persisted verbatim and never interpreted by another provider. */
export interface ProviderReplay {
  provider: string;
  items: JsonValue[];
  required: boolean;
  protection: 'none' | 'signed' | 'encrypted' | 'provider-dependent';
}

/** A model's request to run one tool. */
export interface ToolCall {
  /** Stable within a run; the id a `tool` message answers. */
  id: string;
  name: string;
  /** Parsed arguments. Unparseable arguments are logged raw and refused. */
  args: JsonValue;
}

/** What a tool returned. `error` and a result are not exclusive: a tool may fail loudly and still say something. */
export interface ToolResult {
  /** The bounded preview the model receives. */
  content: string;
  /** Complete JSON-safe result persisted with the durable event, never sent to the model. */
  durableResult?: JsonValue;
  /** The handle resolving to the complete stored result (`@tool:<seq>`). */
  handle?: string;
  /** Present when the call failed. */
  error?: string;
}

/** Usage as the provider reported it. Absent fields are unknown, never zero. */
export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}
