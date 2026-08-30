export function generatedChildren(node) {
  return Array.isArray(node?.generated) ? node.generated : [];
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
