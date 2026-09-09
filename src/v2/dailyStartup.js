// Hydrate independent resources as they arrive. Recent folders cannot hold
// back settings, project tabs, or run readiness.
export function hydrateDaily(api, { onProjects, onWorkflows, onSettings, onRecents, onSelection, onReady, onError }) {
  let live = true, selected = false, ready = false;
  const values = new Map();
  const accept = (key, value, handler) => {
    if (!live) return;
    values.set(key, value); handler?.(value);
    if (!selected && values.has('projects') && values.has('workflows')) {
      selected = true; onSelection?.(values.get('projects'), values.get('workflows'));
    }
    if (!ready && ['projects', 'workflows', 'settings'].every(name => values.has(name))) {
      ready = true; onReady?.();
    }
  };
  for (const [key, method, handler] of [
    ['projects', 'listProjects', onProjects], ['workflows', 'listWorkflows', onWorkflows],
    ['settings', 'getSettings', onSettings], ['recents', 'projectRecents', onRecents],
  ]) Promise.resolve().then(() => api[method]()).then(value => accept(key, value, handler), error => { if (live) onError?.(error, key); });
  return () => { live = false; };
}
