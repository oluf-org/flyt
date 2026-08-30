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
    let pluginReview = surface.pluginReview ?? null;
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
    } : surface.commands?.invoke ? {
      invoke: (name, args, caller = 'human') => surface.commands.invoke(name, args, caller),
      subscribe: listener => surface.commands.subscribe?.(record => {
        // In-process hosts expose a live `surface.stack` getter instead of
        // serialising the next tree into every command event.
        if (record?.stack?.root) stack = record.stack;
        else if (surface.stack?.root) stack = surface.stack;
        listener(record);
      }) ?? (() => {}),
    } : surface.commands;
    // The library is REPLACED on every change rather than mutated in place.
    // Library.jsx memoises on the identity of this object, so a catalog that is
    // edited through the same reference is a catalog that never redraws — which
    // is exactly what installing a plugin used to look like from the outside.
    let library = { ...(surface.library ?? {}) };
    if (Array.isArray(library.blocks)) library.blocks = blocks;
    const patchLibrary = patch => { library = { ...library, ...patch }; };
    // Opening, creating and duplicating all answer with the same snapshot, so
    // they all land here: whatever the host says is open IS what Build edits,
    // and the gallery's list is taken from the same reply rather than fetched
    // again a moment later.
    const accept = next => {
      if (next?.stack?.root) stack = next.stack;
      if (typeof next?.source === 'string') source = next.source;
      if (next?.validation) validation = next.validation;
      if (Array.isArray(next?.history)) history = next.history;
      if (Array.isArray(next?.library?.stacks)) patchLibrary({ stacks: next.library.stacks });
      return next;
    };
    const onAct = typeof host.v2OpenStack === 'function' ? async entry => {
      if (entry?.kind !== 'stack' || entry?.action !== 'open') return null;
      return accept(await host.v2OpenStack(entry.id, 'human'));
    } : surface.onAct;
    const live = { ...surface, blocks, commands, onAct };
    if (typeof host.v2CreateStack === 'function') {
      live.createStack = async (input = {}) => accept(await host.v2CreateStack(input, 'human'));
    } else if (typeof surface.createStack === 'function') {
      live.createStack = async (input = {}) => accept(await surface.createStack(input));
    }
    Object.defineProperty(live, 'library', { enumerable: true, get: () => library });

    // The four plugin verbs, as the manager needs them: each returns the host's
    // answer and lets the error through. A manager that swallowed a rejection
    // would report every failed uninstall as a success.
    if (typeof host.v2Plugins === 'function') {
      live.plugins = {
        list: () => host.v2Plugins(),
        configure: (id, config) => host.v2ConfigurePlugin(id, config),
        restart: id => host.v2RestartPlugin(id),
        uninstall: id => host.v2UninstallPlugin(id),
      };
    } else if (surface.plugins?.list) {
      live.plugins = surface.plugins;
    }
    if (typeof host.onV2PluginsChange === 'function') {
      live.subscribePlugins = listener => host.onV2PluginsChange(plugins => {
        patchLibrary({ plugins: Array.isArray(plugins) ? plugins : [] });
        listener(library.plugins);
      });
    } else if (typeof surface.plugins?.subscribe === 'function') {
      // An in-process host pushes a bare "something changed" and keeps the
      // catalog; over IPC the rows come with the event. Both end up replacing
      // the same library object, so the renderer cannot tell which host it has.
      live.subscribePlugins = listener => surface.plugins.subscribe(() => {
        patchLibrary({ plugins: surface.plugins.list() });
        listener(library.plugins);
      });
    }
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
    if (typeof host.onV2PluginReviewChange === 'function') {
      const attachDecision = review => review?.proposals?.length ? {
        ...review,
        decide: decisions => host.v2DecidePluginReview?.(decisions) ?? false,
      } : null;
      pluginReview = attachDecision(pluginReview);
      Object.defineProperty(live, 'pluginReview', { enumerable: true, get: () => pluginReview });
      live.subscribePluginReview = listener => {
        const detachReview = host.onV2PluginReviewChange(review => {
          pluginReview = attachDecision(review);
          listener(pluginReview);
        });
        // Close the small subscribe/snapshot race: package installation may
        // publish between v2:build's reply and this listener attaching.
        host.v2PluginReview?.().then(review => {
          const current = attachDecision(review);
          if (current?.pluginName === pluginReview?.pluginName) return;
          pluginReview = current;
          listener(pluginReview);
        }).catch(() => {});
        return () => detachReview?.();
      };
      return live;
    }
    if (!surface.pluginReviews?.snapshot) return live;
    // A live bridge, not a copied proposal: installation is awaiting the same
    // coordinator this getter reads and the modal settles. Spreading `live`
    // reads its getters once, so the live ones are re-declared here rather than
    // frozen at the value they happened to hold.
    const bridged = {
      ...live,
      get uiExtensions() { return uiExtensions; },
      get pluginReview() { return surface.pluginReviews.snapshot(); },
      subscribePluginReview: listener => surface.pluginReviews.subscribe(listener),
    };
    Object.defineProperty(bridged, 'library', { enumerable: true, get: () => library });
    return bridged;
  } catch {
    // A host that cannot answer leaves Build empty rather than broken. There is
    // nothing a person can do about it from inside the editor, and an error
    // where a blank canvas belongs reads as the feature being broken.
    return null;
  }
}
