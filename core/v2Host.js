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

const validationErrorKey = error => `${error?.code ?? ''}\n${error?.message ?? ''}`;

/**
 * Errors an edit introduced, excluding problems already present in the source.
 *
 * Build must be able to repair a stack whose plugin disappeared or whose
 * schema moved forward. Refusing every command until unrelated old errors are
 * gone turns Remove — often the repair itself — into a dead end.
 */
export function introducedWorkflowErrors(before, after) {
  const remaining = new Map();
  for (const error of before?.errors ?? []) {
    const key = validationErrorKey(error);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return (after?.errors ?? []).filter(error => {
    const key = validationErrorKey(error);
    const count = remaining.get(key) ?? 0;
    if (!count) return true;
    if (count === 1) remaining.delete(key);
    else remaining.set(key, count - 1);
    return false;
  });
}

/**
 * A file id for a workflow somebody named in a dialog.
 *
 * The id is what the file is called and what a run record names, so it is
 * derived once, here, and never asked for in the UI: a New dialog with a
 * "slug" field is a dialog that makes the person do the computer's filing.
 *
 * @param name — what they typed.
 * @param taken — ids already in the store.
 */
export function workflowIdFrom(name, taken = []) {
  const base = String(name ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workflow';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

/**
 * The same YAML, under a new id and name.
 *
 * A duplicate is edited by the person who made it, so it is a TEXT rewrite of
 * the two lines that identify the file rather than a parse-and-reserialize:
 * round-tripping through the tree is lossless about structure and lossless
 * about nothing else — block comments, `|` prose and the author's spacing all
 * come back as one quoted line.
 */
export function rewriteStackIdentity(source, { id, name }) {
  const lines = String(source ?? '').split(/\r?\n/);
  const eol = /\r\n/.test(String(source ?? '')) ? '\r\n' : '\n';
  let sawId = false;
  let sawName = false;
  const next = lines.map(line => {
    if (!sawId && /^id:\s/.test(line)) { sawId = true; return `id: ${id}`; }
    if (!sawName && /^name:\s/.test(line)) { sawName = true; return `name: ${JSON.stringify(name)}`; }
    return line;
  });
  if (!sawId) next.unshift(`id: ${id}`);
  if (!sawName) next.splice(next.findIndex(line => line.startsWith('id: ')) + 1, 0, `name: ${JSON.stringify(name)}`);
  return next.join(eol);
}

/**
 * The workflow a New button makes: one block, launchable, and nothing else.
 *
 * A starter with a plan/work pair pre-wired would be a second Pipeline that
 * nobody chose. One step is the smallest thing that runs, and the palette is
 * right there.
 *
 * @param blocks — `ctx.blocks`, so the starter block is one this profile
 *   actually has rather than a name that parses and cannot resolve.
 */
export function starterWorkflowSource({ id, name, description = '', blocks = null }) {
  const preferred = blocks?.resolve?.('flyt-blocks-core:work') ?? null;
  const use = preferred?.use ?? blocks?.list?.()?.[0]?.use ?? null;
  if (!use) throw new Error('This profile contributes no blocks, so a new workflow would have nothing to run');
  const lines = [
    'version: 2',
    `id: ${id}`,
    `name: ${JSON.stringify(name)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    'launchable: true',
    'blocks:',
    '  - id: step-1',
    `    use: ${use}`,
    `    title: ${JSON.stringify(preferred?.title ?? 'First step')}`,
  ];
  return `${lines.join('\n')}\n`;
}

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
  preferredId = 'make-change',
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

  if (!booted.ctx.blocks) {
    throw new Error('The selected plugin profile does not provide the block registry');
  }

  const rows = stacks.list();
  let activeId = rows.some(row => row.id === preferredId) ? preferredId : rows[0]?.id ?? null;
  // A canonical stack that will not parse must not take Build down with it:
  // Build opens on the gallery, which lists that file WITH its reason and is
  // the one surface from which somebody could go and repair it.
  //
  // A LEGACY file is the other case and still refuses loudly. Opening one is a
  // migration, and a migration that cannot resolve its blocks must not proceed
  // quietly beside a surface that looks fine.
  const openingLegacy = rows.find(row => row.id === activeId)?.legacy === true;
  let active = null;
  let lastSource = '';
  try {
    active = activeId ? stacks.load(activeId) : null;
    lastSource = active ? stacks.loadSource(activeId) : '';
  } catch (error) {
    if (openingLegacy) throw error;
    active = null;
    lastSource = '';
  }
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
      const before = validationOf();
      const verification = validationOf(serializeStack(next));
      const introduced = introducedWorkflowErrors(before, verification);
      if (introduced.length) throw new Error(introduced.map(error => error.message).join('\n'));
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
  const changedAt = id => {
    try { return fs.statSync(stacks.stackPath(id)).mtime.toISOString(); } catch { return null; }
  };
  const stackRows = () => stacks.list().map(row => {
    try {
      const stack = stacks.load(row.id);
      // Which mode runs when nobody picked one is the kernel's answer, not a
      // guess made again here: a gallery that marked a different mode default
      // from the one the runner applies would be a lie with a checkmark on it.
      const fallbackPreset = kernel.defaultPresetId(stack);
      return {
        id: stack.id, name: stack.name, description: stack.description,
        launchable: stack.launchable,
        presets: Object.entries(stack.presets ?? {}).map(([id, preset]) => ({
          id, name: preset.name, description: preset.description,
          default: id === fallbackPreset,
          // The block ids a mode changes, so the gallery and the editor can say
          // what a mode DOES without reopening the file to find out.
          targets: Object.keys(preset.overrides ?? {}),
          overrides: preset.overrides ?? {},
        })),
        blockCount: [...kernel.walk(stack.root)].filter(node => node.kind === 'block').length,
        updatedAt: changedAt(row.id),
        legacy: row.legacy === true,
        error: null,
      };
    } catch (error) {
      // A stack whose plugin is missing still belongs in the list. Hiding it
      // makes the file look deleted; naming the reason is what lets somebody
      // open it and repair it.
      return {
        id: row.id, name: row.id, description: '', launchable: false, presets: [],
        blockCount: null, updatedAt: changedAt(row.id), legacy: row.legacy === true,
        error: String(error?.message ?? error),
      };
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
        library: { blocks, stacks: stackRows(), plugins: booted.plugins?.list?.() ?? [] },
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
    /**
     * Make a workflow, and open it.
     *
     * New and Duplicate are one operation with one difference — where the YAML
     * comes from — so they are one method. Both end with the new file open in
     * Build, because a New button that leaves you looking at the old workflow
     * has not finished the thing it started.
     *
     * @param from — an existing stack id to copy, or null for the starter.
     */
    create({ name, description = '', from = null } = {}, caller = 'human') {
      const label = String(name ?? '').trim();
      if (!label) throw new Error('A workflow needs a name');
      const id = workflowIdFrom(label, stacks.list().map(row => row.id));
      const source = from
        ? rewriteStackIdentity(stacks.loadSource(String(from)), { id, name: label })
        : starterWorkflowSource({ id, name: label, description, blocks: booted.ctx.blocks });
      const verification = validateWorkflowSource(source, {
        id, parseStack: kernel.parseStack, blocks: booted.ctx.blocks,
      });
      // A copy of a workflow whose plugin is missing is still a legal copy: it
      // is refused only for what the copying introduced, the same line
      // `set` holds an edit to.
      const before = from
        ? validateWorkflowSource(stacks.loadSource(String(from)), {
          id: String(from), parseStack: kernel.parseStack, blocks: booted.ctx.blocks,
        })
        : { errors: [] };
      const introduced = introducedWorkflowErrors(before, verification);
      if (introduced.length) throw new Error(introduced.map(error => error.message).join('\n'));
      stacks.create(id, source);
      const record = {
        at: new Date().toISOString(),
        name: from ? 'stack:duplicate' : 'stack:create',
        args: { id, from: from ?? null, name: label }, caller, result: { stackId: id },
      };
      const opened = this.open(id, caller);
      for (const listener of listeners) listener({ ...record, stack: active, source, validation: verification });
      return { ...opened, stackId: id };
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
