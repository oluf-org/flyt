// The production main-process projection of a booted v2 kernel.
//
// Electron may expose `build()` over IPC and `subscribe()` as a push event.
// Both return cloned, already-validated data from the host-only projection in
// core/v2.js. No Cordis context, RPC invoke method, or plugin object is handed
// to the renderer.

export function createV2HostBridge(booted, { build = null } = {}) {
  if (!booted?.uiExtensions?.list) throw new Error('A v2 host bridge needs a booted UI-extension projection');

  const snapshot = () => booted.uiExtensions.list();
  return {
    build() {
      return {
        // Phase 2 will replace this honest empty source with the active
        // project's stack source. A shaped value lets Build distinguish "no
        // stack yet" from "the host bridge is absent".
        stack: { id: 'empty' },
        blocks: null,
        commands: null,
        library: {},
        ...(typeof build === 'function' ? build() : {}),
        uiExtensions: snapshot(),
      };
    },
    subscribe(listener) {
      return booted.uiExtensions.subscribe(() => listener(snapshot()));
    },
  };
}
