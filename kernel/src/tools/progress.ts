/** Duplicate-call evidence and durable-progress accounting. */
import type { JsonValue, ToolCall } from '../types.js';

export interface RepetitionEvidence {
  fingerprint: string;
  call: ToolCall;
  count: number;
  failureCount: number;
  tokensSinceDurableProgress: number;
  durableStateChanged: boolean;
  warning: boolean;
  clearLoop: boolean;
}

function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function callFingerprint(call: ToolCall): string { return `${call.name}:${stable(call.args)}`; }

interface Seen { count: number; failureCount: number; durableVersion: number; }

export class ProgressDetector {
  private seen = new Map<string, Seen>();
  private durableVersion = 0;
  constructor(
    readonly warnAfter = 3,
    readonly failWarnAfter = 2,
    readonly requirePermissionAfter = 5,
    readonly failurePermissionAfter = 3,
  ) {}

  durableProgress(): void { this.durableVersion += 1; }

  record(call: ToolCall, failed: boolean, tokens: number): RepetitionEvidence {
    const fingerprint = callFingerprint(call);
    const previous = this.seen.get(fingerprint) ?? { count: 0, failureCount: 0, durableVersion: this.durableVersion };
    const durableStateChanged = previous.durableVersion !== this.durableVersion;
    const base = durableStateChanged ? { count: 0, failureCount: 0 } : previous;
    const next = {
      count: base.count + 1,
      failureCount: failed ? base.failureCount + 1 : 0,
      durableVersion: this.durableVersion,
    };
    this.seen.set(fingerprint, next);
    return {
      fingerprint, call, count: next.count, failureCount: next.failureCount,
      tokensSinceDurableProgress: tokens, durableStateChanged,
      warning: next.count >= this.warnAfter || next.failureCount >= this.failWarnAfter,
      clearLoop: !durableStateChanged
        && (next.count >= this.requirePermissionAfter || next.failureCount >= this.failurePermissionAfter),
    };
  }
}
