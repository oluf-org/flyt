// read_stack: the workflow the person is looking at, as a tree the model can
// reason about.
//
// Build's chat exists so somebody can ask "what does this actually do" and
// "why does this fail" about the graph on their screen. Without this tool the
// only way to answer is to read the YAML off disk and hope it is the one that
// is open — which it is not, whenever there are unsaved edits, which is exactly
// when the question gets asked.
//
// The stack arrives on the ctx (`ctx.workflow`), supplied by whoever assembled
// the turn from the SAME surface the editor is drawing. There is no path from
// here to a file, deliberately: this tool cannot disagree with the canvas.
export default {
  name: 'read_stack',
  title: 'Read the open workflow',
  description: [
    'Read the workflow currently open in Build: its name, every block and control in',
    'order, each block\'s settings and declared outputs, its named modes, and the',
    'static verification result (errors and warnings) as the editor shows it.',
    'Call this FIRST when asked anything about "this workflow" — it is the graph on',
    'the screen, including edits that have not been saved to YAML yet.'
  ].join(' '),
  effects: ['read'],
  scope: 'workspace',
  risk: 'safe',
  autoExecute: true,
  keywords: ['workflow', 'stack', 'graph', 'blocks', 'build', 'editor', 'steps'],
  examples: ['what does this workflow do', 'why does this workflow fail verification'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'Ignored unless several workflows are bound; the open one is the default and usually the only one.' }
    }
  },
  run(_args, ctx) {
    const surface = ctx?.workflow ?? null;
    // Throw rather than answer emptily: "there is no workflow" and "the
    // workflow is empty" are different facts, and a model told the second when
    // the first is true will confidently describe a graph that does not exist.
    if (!surface?.stack?.root) {
      throw new Error('No workflow is open in Build, so there is nothing to read. Open one first.');
    }
    const { stack, validation = null } = surface;
    return {
      id: stack.id ?? null,
      name: stack.name ?? null,
      description: stack.description ?? null,
      nodes: flatten(stack.root, []),
      modes: Object.entries(stack.presets ?? {}).map(([id, preset]) => ({
        id, name: preset?.name ?? id, overrides: preset?.blocks ?? preset?.overrides ?? {}
      })),
      verification: validation ? {
        ok: validation.ok === true,
        errors: (validation.errors ?? []).map(problem),
        warnings: (validation.warnings ?? []).map(problem),
        stats: validation.stats ?? null
      } : null
    };
  }
};

const problem = row => ({ message: String(row?.message ?? row), ...(row?.line ? { line: row.line } : {}) });

/**
 * The tree, flat, with each node naming its parent.
 *
 * Flat rather than nested because every question the chat gets is about a node
 * or a pair of them, and a nested JSON blob makes a model count braces to work
 * out what contains what. `parent` and `index` carry the containment losslessly,
 * which is the same claim the YAML makes.
 */
function flatten(node, out) {
  for (const [index, child] of (node.children ?? []).entries()) {
    out.push(summarize(child, node.id ?? null, index, null));
    if (child.kind !== 'block') flatten(child, out);
  }
  for (const [index, child] of (node.else ?? []).entries()) {
    out.push(summarize(child, node.id, index, 'else'));
    if (child.kind !== 'block') flatten(child, out);
  }
  return out;
}

function summarize(node, parentId, index, branch) {
  return {
    id: node.id,
    kind: node.kind,
    ...(node.use ? { use: node.use } : {}),
    ...(node.title ? { title: node.title } : {}),
    parent: parentId,
    index,
    ...(branch ? { branch } : {}),
    ...(node.config && Object.keys(node.config).length ? { config: node.config } : {}),
    ...(node.outputs?.length ? { outputs: node.outputs.map(o => ({ name: o.name, type: o.type })) } : {}),
    // Control settings live on the node itself rather than in `config`.
    ...(node.maxParallel != null ? { maxParallel: node.maxParallel } : {}),
    ...(node.count != null ? { count: node.count } : {}),
    ...(node.roster ? { roster: node.roster } : {}),
    ...(node.max != null ? { max: node.max } : {}),
    ...(node.predicate ? { predicate: node.predicate } : {}),
    ...(node.condition ? { condition: node.condition } : {})
  };
}
