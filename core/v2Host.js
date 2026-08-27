// The production main-process projection of a booted v2 kernel.
//
// Electron may expose `build()` over IPC and `subscribe()` as a push event.
// Both return cloned, already-validated data from the host-only projection in
// core/v2.js. No Cordis context, RPC invoke method, or plugin object is handed
// to the renderer.
import { StackStore } from './stackstore.js';

export function createV2HostBridge(booted, { build = null } = {}) {
  if (!booted?.uiExtensions?.list) throw new Error('A v2 host bridge needs a booted UI-extension projection');

  const snapshot = () => booted.uiExtensions.list();
  return {
    build() {
      return {
        // Null is the honest clean-slate state BlockEditor handles before a
        // file-backed stack is available; never manufacture a partial root.
        stack: null,
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

const publicBlock = block => ({
  use: block.use,
  title: block.title,
  description: block.description,
  category: block.category,
  settings: block.settings ?? {},
  ceiling: block.ceiling ?? null,
  outputs: block.outputs ?? null,
});

/**
 * Bind the production kernel to the file-backed stack Build edits.
 *
 * The renderer receives only cloned data plus IPC methods. The live Cordis
 * context, block executors, and command handlers remain in the main process.
 */
export async function createV2BuildController(booted, {
  stacks = null,
  stackRoot = null,
  preferredId = 'pipeline',
} = {}) {
  if (!booted?.ctx?.commands) throw new Error('A Build controller needs a booted command seam');
  const kernel = await import('#kernel');
  if (!stacks && stackRoot) stacks = new StackStore(stackRoot, {
    parseStack: kernel.parseStack,
    // Resolve at migration time, after the plugins below mount. Canonical
    // files may still open with a missing plugin so Build can show the broken
    // reference; a v1 conversion may not create one silently.
    resolveBlock: use => booted.ctx.blocks.resolve(use),
  });
  if (!stacks?.list || !stacks?.load || !stacks?.saveStack) {
    throw new Error('A Build controller needs a file-backed stack store');
  }

  await booted.ctx.plugin(kernel.flytBlocks);
  await booted.ctx.plugin(kernel.flytBlocksCore);
  await booted.ctx.plugin(kernel.flytBlocksJudgement);
  await booted.ctx.plugin(kernel.flytBlocksInquiry);
  await booted.ctx.plugin(kernel.flytBlocksLoop);

  const rows = stacks.list();
  let activeId = rows.some(row => row.id === preferredId) ? preferredId : rows[0]?.id ?? null;
  let active = activeId ? stacks.load(activeId) : null;
  const listeners = new Set();

  const detachCommands = active ? kernel.registerStackCommands(booted.ctx, {
    get: () => active.root,
    set: root => {
      active = { ...active, root };
      stacks.saveStack(active);
    },
  }) : () => {};
  const detachEvents = booted.ctx.on('commands/invoke', record => {
    // Include the accepted tree in the push. IPC snapshots are clones, so the
    // renderer cannot observe the host's new root merely by re-rendering an
    // object it received before the command ran.
    const update = { ...record, stack: active };
    for (const listener of listeners) listener(update);
  });

  const blockRows = () => booted.ctx.blocks.list().map(publicBlock);
  const stackRows = () => stacks.list().map(row => {
    try {
      const stack = stacks.load(row.id);
      return {
        id: stack.id, name: stack.name, description: stack.description,
        blockCount: [...kernel.walk(stack.root)].filter(node => node.kind === 'block').length,
      };
    } catch {
      return { id: row.id, name: row.id, description: '', blockCount: null };
    }
  });

  return {
    snapshot() {
      const blocks = blockRows();
      return {
        stack: active,
        blocks,
        library: { blocks, stacks: stackRows() },
      };
    },
    invoke(name, args, caller = 'human') {
      return booted.ctx.commands.invoke(name, args, caller);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      detachEvents?.();
      detachCommands?.();
    },
  };
}
