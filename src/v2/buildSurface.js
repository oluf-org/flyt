// What Build is given to edit, and where it comes from.
//
// One place, so there is one answer. The renderer cannot hold a cordis context
// — the kernel lives in the main process — so the command surface arrives here
// as a bridge with the shape `ctx.commands` has: `invoke(name, args, caller)`
// and a subscription to `commands/invoke`. In tests the real service is passed
// straight in, which is the point: the editor cannot tell the difference, and
// neither can a model (D63).
//
// Until Phase 2 puts stacks on disk (`stacks/<id>.stack.yaml`), a project has
// none, and Build renders an empty editor. That is the honest answer for a
// project with no stacks in it, and it is a different thing from a broken one.

/**
 * Ask the host what Build should edit.
 *
 * @param host — `window.flyt`, or anything with the same shape.
 * @returns `{ stack, blocks, commands }`, or null when the host offers none.
 */
export async function buildSurface(host = globalThis.window?.flyt ?? null) {
  if (typeof host?.v2Build !== 'function') return null;
  try {
    const surface = await host.v2Build();
    if (!surface || typeof surface !== 'object') return null;
    let uiExtensions = Array.isArray(surface.uiExtensions) ? surface.uiExtensions : [];
    let stack = surface.stack ?? null;
    let source = surface.source ?? '';
    let validation = surface.validation ?? null;
    let history = Array.isArray(surface.history) ? surface.history : [];
    const blockRows = Array.isArray(surface.blocks) ? surface.blocks : null;
    const blocks = blockRows ? {
      list: () => blockRows,
      resolve: use => blockRows.find(block => block.use === use),
    } : surface.blocks;
    const commands = typeof host.v2InvokeCommand === 'function' ? {
      invoke: (name, args, caller = 'human') => host.v2InvokeCommand(name, args, caller),
      subscribe: listener => typeof host.onV2Command === 'function'
        ? host.onV2Command(record => {
          if (record?.stack?.root) stack = record.stack;
          if (typeof record?.source === 'string') source = record.source;
          if (record?.validation) validation = record.validation;
          if (Array.isArray(record?.history)) history = record.history;
          listener(record);
        })
        : () => {},
    } : surface.commands;
    const library = { ...(surface.library ?? {}) };
    if (Array.isArray(library.blocks)) library.blocks = blocks;
    const onAct = typeof host.v2OpenStack === 'function' ? async entry => {
      if (entry?.kind !== 'stack' || entry?.action !== 'open') return null;
      const next = await host.v2OpenStack(entry.id, 'human');
      if (next?.stack?.root) stack = next.stack;
      if (typeof next?.source === 'string') source = next.source;
      if (next?.validation) validation = next.validation;
      if (Array.isArray(next?.history)) history = next.history;
      if (Array.isArray(next?.library?.stacks)) library.stacks = next.library.stacks;
      return next;
    } : surface.onAct;
    const live = { ...surface, blocks, commands, library, onAct };
    if (typeof host.v2ValidateStackSource === 'function') {
      live.validateSource = source => host.v2ValidateStackSource(source);
    }
    if (typeof host.v2SaveStackSource === 'function') {
      live.saveSource = async (nextSource, caller = 'human') => {
        const next = await host.v2SaveStackSource(nextSource, caller);
        if (next?.ok) {
          source = next.source ?? nextSource;
          validation = next;
          if (Array.isArray(next.history)) history = next.history;
          if (next.stack?.root) stack = next.stack;
        }
        return next;
      };
    }
    if (typeof host.v2StackHistory === 'function') {
      live.loadHistory = (nodeId = null, limit = 200) => host.v2StackHistory(nodeId, limit);
    }
    Object.defineProperty(live, 'stack', { enumerable: true, get: () => stack });
    Object.defineProperty(live, 'source', { enumerable: true, get: () => source });
    Object.defineProperty(live, 'validation', { enumerable: true, get: () => validation });
    Object.defineProperty(live, 'history', { enumerable: true, get: () => history });
    Object.defineProperty(live, 'uiExtensions', { enumerable: true, get: () => uiExtensions });
    if (typeof host.onV2UiExtensionsChange === 'function') {
      live.subscribeUiExtensions = listener => host.onV2UiExtensionsChange(rows => {
        uiExtensions = Array.isArray(rows) ? rows : [];
        listener(uiExtensions);
      });
    }
    if (!surface.pluginReviews?.snapshot) return live;
    // A live bridge, not a copied proposal: installation is awaiting the same
    // coordinator this getter reads and the modal settles.
    return {
      ...live,
      get uiExtensions() { return uiExtensions; },
      get pluginReview() { return surface.pluginReviews.snapshot(); },
      subscribePluginReview: listener => surface.pluginReviews.subscribe(listener),
    };
  } catch {
    // A host that cannot answer leaves Build empty rather than broken. There is
    // nothing a person can do about it from inside the editor, and an error
    // where a blank canvas belongs reads as the feature being broken.
    return null;
  }
}
