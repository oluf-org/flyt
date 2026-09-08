export const count = value => value == null ? '—' : Math.round(value).toLocaleString();
export const cost = value => value == null ? '—' : `$${Number(value).toFixed(value < 1 ? 4 : 2)}`;
export function elapsed(ms) {
  if (ms == null) return '—';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export const loopLabel = status => ({ achieved: 'Achieved', plateau: 'No further gain', limit_reached: 'Budget reached',
  needs_input: 'Needs input', cleanup_failed: 'Cleanup needs attention', finishing: 'Finishing', ready: 'Ready',
  running: 'Running', paused: 'Paused', interrupted: 'Interrupted', stopped: 'Stopped', failed: 'Failed',
  stopping: 'Stopping', pausing: 'Pausing' }[status] ?? status);
