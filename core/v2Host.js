// The production main-process projection of a booted v2 kernel.
//
// Electron may expose `build()` over IPC and `subscribe()` as a push event.
// Both return cloned, already-validated data from the host-only projection in
// core/v2.js. No Cordis context, RPC invoke method, or plugin object is handed
// to the renderer.
import { StackStore } from './stackstore.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { serializeStack } from './stackstore.js';
import { validateWorkflowSource } from './workflowValidation.js';

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
  historyRoot = stackRoot ? path.join(path.dirname(stackRoot), 'stack-history') : null,
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
  let lastSource = active ? stacks.loadSource(activeId) : '';
  const listeners = new Set();

  const historyPath = id => historyRoot ? path.join(historyRoot, `${id}.jsonl`) : null;
  const readHistory = (nodeId = null, limit = 200) => {
    const file = activeId ? historyPath(activeId) : null;
    if (!file || !fs.existsSync(file)) return [];
    const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const filtered = nodeId ? rows.filter(row => row.nodeId === nodeId || row.args?.nodeId === nodeId) : rows;
    return filtered.slice(-Math.max(1, Math.min(Number(limit) || 200, 1000))).reverse();
  };
  const appendHistory = record => {
    if (!historyRoot || !activeId) return;
    fs.mkdirSync(historyRoot, { recursive: true });
    const afterSource = active ? serializeStack(active) : '';
    const digest = source => createHash('sha256').update(source).digest('hex');
    const entry = {
      version: 1,
      at: record.at ?? new Date().toISOString(),
      stackId: activeId,
      caller: record.caller ?? 'human',
      command: record.name,
      args: record.args ?? null,
      result: record.result ?? null,
      error: record.error ?? null,
      nodeId: record.result?.nodeId ?? record.args?.nodeId ?? null,
      before: { sha256: digest(lastSource), source: lastSource },
      after: { sha256: digest(afterSource), source: afterSource },
    };
    fs.appendFileSync(historyPath(activeId), `${JSON.stringify(entry)}\n`, 'utf8');
    lastSource = afterSource;
  };

  const validationOf = (source = active ? serializeStack(active) : '') => source
    ? validateWorkflowSource(source, {
      id: activeId ?? '', parseStack: kernel.parseStack, blocks: booted.ctx.blocks,
    })
    : { ok: false, errors: [], warnings: [], stats: null, stack: null, normalized: null };

  const detachCommands = kernel.registerStackCommands(booted.ctx, {
    get: () => {
      if (!active?.root) throw new Error('Select a stack before editing');
      return active.root;
    },
    set: root => {
      const next = { ...active, root };
      const verification = validationOf(serializeStack(next));
      if (!verification.ok) throw new Error(verification.errors.map(error => error.message).join('\n'));
      stacks.saveStack(next);
      active = next;
    },
  });
  const detachEvents = booted.ctx.on('commands/invoke', record => {
    // Include the accepted tree in the push. IPC snapshots are clones, so the
    // renderer cannot observe the host's new root merely by re-rendering an
    // object it received before the command ran.
    appendHistory(record);
    const update = {
      ...record, stack: active,
      source: active ? serializeStack(active) : '',
      validation: validationOf(),
      history: readHistory(null, 100),
    };
    for (const listener of listeners) listener(update);
  });

  const blockRows = () => booted.ctx.blocks.list().map(publicBlock);
  const stackRows = () => stacks.list().map(row => {
    try {
      const stack = stacks.load(row.id);
      return {
        id: stack.id, name: stack.name, description: stack.description,
        launchable: stack.launchable,
        presets: Object.entries(stack.presets ?? {}).map(([id, preset]) => ({
          id, name: preset.name, description: preset.description,
        })),
        blockCount: [...kernel.walk(stack.root)].filter(node => node.kind === 'block').length,
      };
    } catch {
      return { id: row.id, name: row.id, description: '', launchable: false, presets: [], blockCount: null };
    }
  });

  return {
    snapshot() {
      const blocks = blockRows();
      const source = active ? stacks.loadSource(activeId) : '';
      return {
        stack: active,
        source,
        validation: validationOf(source),
        history: readHistory(null, 100),
        blocks,
        library: { blocks, stacks: stackRows() },
      };
    },
    invoke(name, args, caller = 'human') {
      return booted.ctx.commands.invoke(name, args, caller);
    },
    open(id, caller = 'human') {
      const next = stacks.load(id);
      activeId = id;
      active = next;
      lastSource = stacks.loadSource(id);
      const record = {
        name: 'stack:open', args: { id }, caller,
        result: { stackId: id }, stack: active,
      };
      for (const listener of listeners) listener(record);
      return this.snapshot();
    },
    validate(source) {
      return validationOf(String(source ?? ''));
    },
    saveSource(source, caller = 'human') {
      const text = String(source ?? '');
      const validation = validationOf(text);
      if (!validation.ok) return validation;
      const before = lastSource;
      stacks.save(activeId, text);
      active = validation.stack;
      const record = {
        at: new Date().toISOString(), name: 'stack:save-source', caller,
        args: { id: activeId }, result: { nodeId: null },
      };
      lastSource = before;
      appendHistory(record);
      const update = { ...record, stack: active, source: text, validation, history: readHistory(null, 100) };
      for (const listener of listeners) listener(update);
      return { ...validation, stack: active, source: text, history: update.history };
    },
    history(nodeId = null, limit = 200) {
      return readHistory(nodeId == null ? null : String(nodeId), limit);
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
