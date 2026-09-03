export function generatedChildren(node) {
  return Array.isArray(node?.generated) ? node.generated : [];
}

const TASK_GRAPH_DEFAULT_PARALLEL = { no: 1, low: 2, medium: 4, high: 8 };

function generatedTaskId(node) {
  if (typeof node?.taskId === 'string' && node.taskId) return node.taskId;
  const id = String(node?.id ?? '');
  return id.slice(id.lastIndexOf('.') + 1);
}

/**
 * Rebuild the execution waves used by Plan & dispatch from its durable child
 * records. Each wave can run side by side; dependency-bound work follows in a
 * later row. The bounded fallback also keeps malformed historical data visible.
 */
export function generatedTaskWaves(children, config = {}) {
  const rows = (Array.isArray(children) ? children : []).map((node, index) => ({
    node, index, taskId: generatedTaskId(node),
  }));
  if (!rows.length) return [];

  const configured = Number(config?.maxParallel);
  const parallelism = TASK_GRAPH_DEFAULT_PARALLEL[config?.parallelism] ?? TASK_GRAPH_DEFAULT_PARALLEL.medium;
  const limit = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : parallelism;
  const known = new Set(rows.map(row => row.taskId));
  const completed = new Set();
  let remaining = rows;
  const waves = [];

  while (remaining.length) {
    const ready = remaining.filter(row => (Array.isArray(row.node?.dependsOn) ? row.node.dependsOn : [])
      .every(dependency => completed.has(String(dependency)) || !known.has(String(dependency))));
    // Cyclic or partial historical records should not make generated work
    // disappear. Display the next bounded group and allow traversal to finish.
    const wave = (ready.length ? ready : remaining).slice(0, limit);
    waves.push(wave.map(row => row.node));
    const selected = new Set(wave.map(row => row.index));
    for (const row of wave) completed.add(row.taskId);
    remaining = remaining.filter(row => !selected.has(row.index));
  }
  return waves;
}

export function workflowNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  if (node.kind === 'block') {
    for (const child of generatedChildren(node)) workflowNodes(child, out);
  } else {
    for (const child of Array.isArray(node.children) ? node.children : []) workflowNodes(child, out);
    if (node.kind === 'if') {
      for (const child of Array.isArray(node.else) ? node.else : []) workflowNodes(child, out);
    }
  }
  return out;
}

export function workflowBlockNodes(root) {
  return workflowNodes(root, []).filter(node => node.kind === 'block');
}
