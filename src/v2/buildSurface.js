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
          listener(record);
        })
        : () => {},
    } : surface.commands;
    const library = { ...(surface.library ?? {}) };
    if (Array.isArray(library.blocks)) library.blocks = blocks;
    const live = { ...surface, blocks, commands, library };
    Object.defineProperty(live, 'stack', { enumerable: true, get: () => stack });
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
