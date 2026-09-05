/** Deterministic identities and lifecycle records for generated child sessions. */
import { createHash } from 'node:crypto';

export type ChildSessionStage = 'created' | 'active' | 'done' | 'failed' | 'interrupted';

export interface ChildSessionIdentity {
  sessionId: string;
  parentRunId: string;
  parentBlockId: string;
  parentExecutionId?: string;
  parentContextAfter?: number;
  taskId: string;
  profileId: string;
  contextBoundary: 'isolated' | 'parent-summary' | 'shared';
}

const CHILD_SUFFIX = /--child-[0-9a-f]{16}$/;

export function childSessionIdentity(input: Omit<ChildSessionIdentity, 'sessionId'>): ChildSessionIdentity {
  const hash = createHash('sha256')
    .update([input.parentRunId, input.parentExecutionId ?? input.parentBlockId, input.taskId, input.profileId,
      ...(input.parentContextAfter !== undefined ? [String(input.parentContextAfter)] : [])].join('\0'))
    .digest('hex').slice(0, 16);
  return { ...input, sessionId: `${input.parentRunId}--child-${hash}` };
}

/** Whether a session id names a generated child rather than a launched run. */
export function isChildSessionId(sessionId: string): boolean {
  return CHILD_SUFFIX.test(String(sessionId ?? ''));
}

/**
 * The run a session belongs to for anything a person interacts with.
 *
 * A generated child asks for approval, answers and attention under the run
 * the person launched; its own id is a durable detail of the trace, not a
 * second run to watch. A top-level run id is returned unchanged.
 */
export function parentRunIdOf(sessionId: string): string {
  return String(sessionId ?? '').replace(CHILD_SUFFIX, '');
}
