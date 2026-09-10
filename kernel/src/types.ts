/**
 * Types shared across the seams. Deliberately small: a seam should describe a
 * capability, not drag a domain model behind it.
 *
 * @module #kernel/types
 */

/** Anything that survives a round trip through the session log. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Stable failure facts used for recovery and diagnostics; never parse `detail` for policy. */
export interface FailureMetadata {
  code: string;
  source: 'provider' | 'user' | 'tool' | 'scheduler' | 'application' | string;
  provider?: string | null;
  model?: string | null;
  callId?: string | null;
  step?: number | null;
  retryable: boolean;
  userInitiated: boolean;
  visibleOutputProduced: boolean;
  reasoningOutputProduced?: boolean;
  toolCallProduced?: boolean;
  durableWriteProduced: boolean;
  detail?: string | null;
  remedy?: string | null;
}

/** Who produced a message. `tool` carries a tool result back to the model. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Generic durable references; format-specific properties remain optional for future importers. */
export type AssetRef = { assetId: string; kind: string; name: string; mimeType: string; byteLength: number; width?: number; height?: number };
export type ChatSubmission = { requestId: string; text: string; attachments: AssetRef[] };
export type MessagePart = { type: 'text'; text: string } | { type: 'image'; assetId: string };

/** One model-visible message. Reconstructable from the log, or it did not happen (D55). */
export interface Message {
  role: MessageRole;
  /** The text the model saw. Reasoning is kept apart from content (D40). */
  content: string;
  parts?: MessagePart[];
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
  parts?: MessagePart[];
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
