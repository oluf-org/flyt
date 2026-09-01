/**
 * The durable session vocabulary and the payload carried by every event.
 *
 * Cordis process events live in `kernel/src/events.ts`; these dotted events
 * are persisted facts. Keeping the map here makes writers, projections and
 * recovery share one contract instead of synchronising string literals.
 */
import type { JsonValue, ToolCall, Usage } from '../types.js';

type Data = Record<string, JsonValue>;

export interface SessionEventMap {
  'run.created': Data & {
    stackId: string;
    input: string;
    createdAt?: string;
    workspace?: string;
    approvalMode?: string;
    profile?: 'flyt-desktop' | 'flyt-cli' | 'flyt-loop-worker';
  };
  'run.named': { name: string | null };
  'run.reconfigured': Data;
  'stack.resolved': Data & { stackId: string; stack: JsonValue };
  'run.stage': Data & { stage: string };
  'run.error': Data & { error: string };
  'child.session': Data;
  'turn.start': Data & { runId: string; turn: number; blockId: string };
  'step.start': Data & { runId: string; blockId: string; step: number };
  'step.prompt': Data;
  'step.end': Data & { runId: string; blockId: string; step: number; finishReason: string };
  'turn.end': Data;
  'message.system': Data & { content: string };
  'message.user': Data & { content: string };
  'llm.request': Data & { callId: string; blockId: string };
  'llm.attempt': Data;
  'context.budget': Data;
  'context.checkpoint': Data;
  'llm.telemetry': Data;
  'plugin.interception': Data;
  'llm.stream': Data;
  'tool.input.start': Data;
  'tool.input.delta': Data;
  'tool.input.end': Data;
  'llm.response': Data & {
    callId: string;
    content: string;
    toolCalls?: ToolCall[];
    usage?: Usage;
  };
  'tool.call': Data & { callId: string; name: string; args: JsonValue };
  'tool.state': Data & { callId: string; state: string };
  'permission.decision': Data;
  'tool.result': Data & { callId: string; name: string; content: string };
  'tool.repetition': Data;
  'block.status': Data & { blockId: string; status: string };
  'block.warning': Data & { blockId: string };
  'block.output': Data & { blockId: string; content: string };
  'workspace.observed': Data & { changed: boolean; kind: string; tool: string };
  'supervisor.summary': Data & { content: string };
}

export const SESSION_EVENTS = [
  'run.created', 'run.named', 'run.reconfigured', 'stack.resolved', 'run.stage', 'run.error',
  'child.session', 'turn.start', 'step.start', 'step.prompt', 'step.end', 'turn.end',
  'message.system', 'message.user', 'llm.request', 'llm.attempt', 'context.budget',
  'context.checkpoint', 'llm.telemetry', 'plugin.interception', 'llm.stream',
  'tool.input.start', 'tool.input.delta', 'tool.input.end', 'llm.response',
  'tool.call', 'tool.state', 'permission.decision', 'tool.result', 'tool.repetition',
  'block.status', 'block.warning', 'block.output', 'workspace.observed', 'supervisor.summary',
] as const satisfies readonly (keyof SessionEventMap)[];

export type SessionEventType = keyof SessionEventMap;

export type SessionExtensionData = Data & {
  _extension: { ignorable: true; [key: string]: JsonValue };
};

export type SessionExtensionEventInput = {
  type: `extension.${string}`;
  data: SessionExtensionData;
  at?: string;
};

export type DurableSessionEventInput = ({
  [K in SessionEventType]: { type: K; data: SessionEventMap[K]; at?: string }
}[SessionEventType]) | SessionExtensionEventInput;

export type DurableSessionEvent = ({
  [K in SessionEventType]: { seq: number; at: string; type: K; data: SessionEventMap[K] }
}[SessionEventType]) | {
  seq: number;
  at: string;
  type: `extension.${string}`;
  data: SessionExtensionData;
};

export const SESSION_EVENT_SET: ReadonlySet<string> = new Set(SESSION_EVENTS);
