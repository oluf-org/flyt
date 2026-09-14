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
  private evidenceVersion = 0;
  private novelReads = new Set<string>();
  private readVersions = new Map<string, number>();
  constructor(
    readonly warnAfter = 3,
    readonly failWarnAfter = 2,
    readonly requirePermissionAfter = 5,
    readonly failurePermissionAfter = 3,
  ) {}

  durableProgress(): void {
    this.durableVersion += 1;
    this.novelReads.clear();
    this.readVersions.clear();
  }

  record(call: ToolCall, failed: boolean, tokens: number, readOnly = false): RepetitionEvidence {
    const fingerprint = callFingerprint(call);
    // A missing file retried after discovering new evidence is not a stalled
    // run. Only novel successful reads advance this version: alternating old
    // queries must still hit the bound, and writes keep their strict policy.
    if (readOnly && !failed && !this.novelReads.has(fingerprint)) {
      this.novelReads.add(fingerprint);
      this.evidenceVersion += 1;
    }
    const newEvidence = readOnly && this.readVersions.has(fingerprint)
      && this.readVersions.get(fingerprint) !== this.evidenceVersion;
    if (readOnly) this.readVersions.set(fingerprint, this.evidenceVersion);
    const previous = this.seen.get(fingerprint) ?? { count: 0, failureCount: 0, durableVersion: this.durableVersion };
    const durableStateChanged = previous.durableVersion !== this.durableVersion;
    const base = durableStateChanged || newEvidence ? { count: 0, failureCount: 0 } : previous;
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
