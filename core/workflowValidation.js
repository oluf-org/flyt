import { boundStack, MAX_DEPTH, MAX_EXPANSION, missingBlocks, walk } from '#kernel';
import { validateArgs } from './tools/schema.js';
import { serializeStack } from './stackstore.js';

const cleanNode = node => {
  if (node.kind === 'block') {
    return {
      kind: node.kind, id: node.id, use: node.use, title: node.title,
      config: node.config, outputs: node.outputs ?? [],
    };
  }
  return {
    kind: node.kind, id: node.id,
    ...(node.kind === 'parallel' ? { maxParallel: node.maxParallel } : {}),
    ...(node.kind === 'repeat' ? { count: node.count } : {}),
    ...(node.kind === 'foreach' ? { roster: node.roster, max: node.max } : {}),
    ...(node.kind === 'until' ? { condition: node.condition, max: node.max } : {}),
    ...(node.kind === 'if' ? { predicate: node.predicate } : {}),
    children: node.children.map(cleanNode),
    ...(node.kind === 'if' ? { else: node.else?.map(cleanNode) ?? null } : {}),
  };
};

const cleanStack = stack => ({
  version: stack.version, id: stack.id, name: stack.name,
  description: stack.description, launchable: stack.launchable,
  presets: stack.presets ?? {}, root: cleanNode(stack.root),
});

function depthOf(node, depth = 1) {
  if (node.kind === 'block') return depth;
  return Math.max(
    depth,
    ...node.children.map(child => depthOf(child, depth + 1)),
    ...(node.kind === 'if' && node.else ? node.else.map(child => depthOf(child, depth + 1)) : []),
  );
}

function referencedOutputs(root) {
  const used = new Set();
  const addPredicate = predicate => {
    if (!predicate) return;
    const terms = predicate.source ? [predicate] : (predicate.allOf ?? predicate.anyOf ?? []);
    for (const term of terms) if (term?.source) used.add(term.source);
  };
  for (const node of walk(root)) {
    if (node.kind === 'foreach') used.add(node.roster);
    if (node.kind === 'if') addPredicate(node.predicate);
    if (node.kind === 'until') addPredicate(node.condition);
  }
  return used;
}

/** Parse, statically verify, and round-trip one canonical workflow source. */
export function validateWorkflowSource(source, {
  id = '', parseStack, blocks = null,
} = {}) {
  const errors = [];
  const warnings = [];
  let stack = null;
  try {
    stack = parseStack(source, id);
  } catch (error) {
    errors.push({
      code: 'parse', message: String(error?.message ?? error),
      path: error?.path ?? 'stack', line: Number(error?.line ?? 0),
    });
    return { ok: false, errors, warnings, stats: null, stack: null, normalized: null };
  }

  const missing = blocks ? missingBlocks(blocks, stack.root) : [];
  for (const node of missing) {
    errors.push({
      code: 'missing-block', path: node.position?.path ?? node.id,
      line: node.position?.line ?? 0,
      message: `Block “${node.id}” uses “${node.use}”, but no installed plugin contributes it.`,
    });
  }

  for (const node of walk(stack.root)) {
    if (node.kind !== 'block') continue;
    const definition = blocks?.resolve?.(node.use) ?? null;
    if (definition?.settings) {
      for (const message of validateArgs(definition.settings, node.config ?? {}, `blocks.${node.id}.config`)) {
        errors.push({ code: 'config', path: node.position?.path ?? node.id, line: node.position?.line ?? 0, message });
      }
    }
    if (!node.title) {
      warnings.push({ code: 'untitled-block', path: node.position?.path ?? node.id, line: node.position?.line ?? 0,
        message: `Block “${node.id}” has no authored title; Build will use its plugin title.` });
    }
  }

  const used = referencedOutputs(stack.root);
  for (const node of walk(stack.root)) {
    if (node.kind !== 'block') continue;
    for (const output of node.outputs ?? []) {
      const ref = `${node.id}.${output.name}`;
      if (!used.has(ref)) warnings.push({ code: 'unused-output', path: node.position?.path ?? node.id,
        line: node.position?.line ?? 0, message: `Declared output “${ref}” is not read by a container.` });
    }
  }

  const bounds = boundStack(stack.root);
  const depth = depthOf(stack.root);
  if (bounds.expansion >= Math.floor(MAX_EXPANSION * .75)) {
    warnings.push({ code: 'high-expansion', path: 'stack', line: 0,
      message: `Worst-case execution is ${bounds.expansion} blocks, close to the ${MAX_EXPANSION} cap.` });
  }
  if (depth >= MAX_DEPTH) {
    warnings.push({ code: 'deep-nesting', path: 'stack', line: 0,
      message: `This workflow uses the maximum supported nesting depth of ${MAX_DEPTH}.` });
  }
  if (!stack.description) warnings.push({ code: 'missing-description', path: 'stack.description', line: 0,
    message: 'A launchable workflow should explain when to use it.' });

  let normalized = null;
  try {
    normalized = serializeStack(stack);
    const roundTrip = parseStack(normalized, stack.id);
    if (JSON.stringify(cleanStack(roundTrip)) !== JSON.stringify(cleanStack(stack))) {
      errors.push({ code: 'round-trip', path: 'stack', line: 0,
        message: 'YAML round-trip changed the parsed workflow.' });
    }
  } catch (error) {
    errors.push({ code: 'round-trip', path: 'stack', line: 0,
      message: `YAML round-trip failed: ${String(error?.message ?? error)}` });
  }

  return {
    ok: errors.length === 0,
    errors, warnings,
    stats: { blocks: bounds.blocks, depth, worstCaseExpansion: bounds.expansion },
    stack, normalized,
  };
}
