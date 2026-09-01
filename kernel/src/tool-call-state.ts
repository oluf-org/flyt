/** Canonical, append-only tool-call lifecycle. */
import type { JsonValue, ToolCall } from './types.js';
import type { SessionEvent } from './seams/sessions.js';

export const TOOL_CALL_STATES = [
  'received', 'normalized', 'validated', 'authorized', 'running',
  'completed', 'failed', 'interrupted',
] as const;
export type ToolCallState = (typeof TOOL_CALL_STATES)[number];

const TERMINAL = new Set<ToolCallState>(['completed', 'failed', 'interrupted']);
const ALLOWED: Record<ToolCallState, readonly ToolCallState[]> = {
  received: ['normalized', 'failed', 'interrupted'],
  normalized: ['validated', 'failed', 'interrupted'],
  validated: ['authorized', 'failed', 'interrupted'],
  authorized: ['running', 'failed', 'interrupted'],
  running: ['completed', 'failed', 'interrupted'],
  completed: [], failed: [], interrupted: [],
};

export interface ToolStateTransition {
  callId: string;
  state: ToolCallState;
  reason?: string;
  diagnostics?: string[];
}

export function assertToolTransition(from: ToolCallState | null, to: ToolCallState): void {
  if (from === null) {
    if (to !== 'received') throw new Error(`Tool call must begin at received, not ${to}`);
    return;
  }
  if (!ALLOWED[from].includes(to)) throw new Error(`Invalid tool-call transition ${from} -> ${to}`);
}

/** Normalize name and arguments before either is persisted as a callable fact. */
export function normalizeToolCall(call: ToolCall, offered: readonly string[]): ToolCall {
  const rawName = String(call.name ?? '').trim();
  const exact = offered.includes(rawName) ? rawName : null;
  const insensitive = offered.filter(name => name.toLowerCase() === rawName.toLowerCase());
  const name = exact ?? (insensitive.length === 1 ? insensitive[0] : rawName);
  let args: JsonValue = (call.args ?? {}) as JsonValue;
  if (typeof args === 'string') {
    try { args = JSON.parse(args) as JsonValue; }
    catch { args = { _unparsed: args }; }
  }
  if (args === null) args = {};
  return { id: String(call.id), name, args };
}

export interface ReconciledToolCall {
  callId: string;
  state: ToolCallState;
}

/** Last known state of every call; callers append interrupted for nonterminal rows. */
export function reconcileToolCallStates(events: readonly SessionEvent[], blockId?: string): ReconciledToolCall[] {
  const states = new Map<string, ToolCallState>();
  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    if (blockId !== undefined && data.blockId !== blockId) continue;
    if (event.type === 'llm.response' && Array.isArray(data.toolCalls)) {
      for (const call of data.toolCalls as Record<string, unknown>[]) {
        const callId = String(call?.id ?? '');
        if (callId && !states.has(callId)) states.set(callId, 'received');
      }
      continue;
    }
    if (event.type === 'tool.call') {
      const callId = String(data.callId ?? data.id ?? '');
      if (callId && !states.has(callId)) states.set(callId, 'normalized');
      continue;
    }
    if (event.type === 'tool.result') {
      const callId = String(data.callId ?? data.id ?? '');
      if (callId) states.set(callId, data.error ? 'failed' : 'completed');
      continue;
    }
    if (event.type !== 'tool.state') continue;
    const callId = String(data.callId ?? '');
    const state = String(data.state ?? '') as ToolCallState;
    if (!callId || !(TOOL_CALL_STATES as readonly string[]).includes(state)) continue;
    states.set(callId, state);
  }
  return [...states].map(([callId, state]) => ({ callId, state }));
}

export const terminalToolState = (state: ToolCallState): boolean => TERMINAL.has(state);
