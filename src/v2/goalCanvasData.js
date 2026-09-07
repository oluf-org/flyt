// Layout never changes executable order or flattens parallel branches.
export function loopNodes(root) {
  return [...(root?.children ?? []).map((node, index) => ({ ...node, ordinal: index + 1,
    childCount: (node.children?.length ?? 0) + (node.else?.length ?? 0) })),
  { id: '$verify', kind: 'system', title: 'Verify & continue', ordinal: (root?.children?.length ?? 0) + 1 }];
}
export function circlePositions(count) {
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + i * Math.PI * 2 / count;
    return { x: 50 + 35 * Math.cos(angle), y: 50 + 35 * Math.sin(angle) };
  });
}
export function findGoalNode(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of [...(root.children ?? []), ...(root.else ?? [])]) {
    const found = findGoalNode(child, id); if (found) return found;
  }
  return null;
}
export function goalNodeStatus(snapshot, goal, phase, nodeId) {
  if (phase === 'setup' && goal?.setupDone) return 'Setup complete';
  const showingSetup = goal?.activeChild?.phase === 'setup';
  if ((phase === 'setup') !== showingSetup) return phase === 'setup' ? 'Pending setup' : 'Not run in this view';
  const status = snapshot?.meta?.nodeStatus?.[nodeId] ?? snapshot?.meta?.blockStatus?.[nodeId];
  return status === 'active' ? 'Running' : status === 'done' ? 'Done' : status ?? (goal ? 'Not run in this view' : 'Not run');
}
