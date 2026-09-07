// Shared operational vocabulary; no filesystem or renderer dependencies.
const terminal = new Set(['done', 'failed', 'stopped', 'interrupted', 'cancelled', 'rejected']);
export function workflowActions(stage, lifecycle = null) {
  const external = lifecycle?.owner === 'external';
  const cleaning = lifecycle?.phase === 'settled' && ['running', 'failed', 'pending'].includes(lifecycle.cleanup);
  const active = Boolean(stage) && !terminal.has(stage) && stage !== 'paused';
  return {
    canPause: !external && !cleaning && active && stage !== 'stopping' && stage !== 'pausing',
    canStop: !external && !cleaning && (active || stage === 'paused'),
    canResume: !external && !cleaning && ['pausing', 'paused', 'stopped', 'interrupted'].includes(stage),
    canRetryCleanup: !external && lifecycle?.cleanup === 'failed',
    reason: external ? 'Execution is owned by another process' : cleaning ? (lifecycle.cleanupError || 'Finishing cleanup') : null,
  };
}
