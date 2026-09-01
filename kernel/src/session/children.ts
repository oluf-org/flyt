/** Deterministic identities and lifecycle records for generated child sessions. */
import { createHash } from 'node:crypto';

export type ChildSessionStage = 'created' | 'active' | 'done' | 'failed' | 'interrupted';

export interface ChildSessionIdentity {
  sessionId: string;
  parentRunId: string;
  parentBlockId: string;
  taskId: string;
  profileId: string;
  contextBoundary: 'isolated' | 'parent-summary' | 'shared';
}

export function childSessionIdentity(input: Omit<ChildSessionIdentity, 'sessionId'>): ChildSessionIdentity {
  const hash = createHash('sha256')
    .update([input.parentRunId, input.parentBlockId, input.taskId, input.profileId].join('\0'))
    .digest('hex').slice(0, 16);
  return { ...input, sessionId: `${input.parentRunId}--child-${hash}` };
}
