// One request stream for the active project's history. The host shares its
// snapshot with Work and Chats; switching destinations does not restart polling.
export function createHistoryFeed(api, projectId, {
  document: page = globalThis.document,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
  intervalMs = 5000,
} = {}) {
  let state = { rows: [], busy: Boolean(projectId), error: '' };
  let timer, pending = null, dirty = false, generation = 0, unsubscribe;
  const listeners = new Set();
  const publish = next => { state = next; for (const listener of listeners) listener(); };
  const refresh = () => {
    if (!listeners.size || page?.hidden || !projectId) return Promise.resolve();
    if (pending) { dirty = true; return pending; }
    cancel(timer);
    const current = generation;
    pending = Promise.resolve().then(() => api.chatHistory(projectId)).then(
      rows => { if (current === generation) publish({ rows: rows ?? [], busy: false, error: '' }); },
      error => { if (current === generation) publish({ ...state, busy: false, error: String(error?.message ?? error) }); },
    ).finally(() => {
      if (current !== generation) return;
      pending = null;
      const delay = dirty ? 0 : intervalMs;
      dirty = false;
      if (listeners.size) timer = schedule(refresh, delay);
    });
    return pending;
  };
  const visibility = () => { if (page?.hidden) cancel(timer); else void refresh(); };
  return {
    getSnapshot: () => state,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        page?.addEventListener('visibilitychange', visibility);
        unsubscribe = api.onProjectActivity?.(event => { if (event.projectId === projectId) void refresh(); });
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        generation++;
        pending = null; dirty = false;
        cancel(timer);
        unsubscribe?.();
        page?.removeEventListener('visibilitychange', visibility);
      };
    },
  };
}
