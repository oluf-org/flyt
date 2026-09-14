// Pure, replayable workflow facts; no model or execution dependencies.
const textOf = value => String(value ?? '').trim();

export function deterministicRunCapsule(snapshot, { workflowName = null } = {}) {
  const status = snapshot?.meta?.stage ?? 'unknown';
  const nodeStatus = snapshot?.meta?.nodeStatus ?? snapshot?.meta?.blockStatus ?? {};
  const outputs = snapshot?.nodeOutputs ?? {};
  const completed = [];
  const failed = [];
  const outstanding = [];
  for (const [id, state] of Object.entries(nodeStatus)) {
    if (state === 'done') completed.push(id);
    else if (state === 'failed') failed.push(id);
    else if (!['skipped'].includes(state)) outstanding.push(`${id} (${state})`);
  }
  const outputUnits = Object.entries(outputs).map(([id, value]) => ({
    label: `OUTPUT ${id}`,
    text: typeof value === 'string' ? value : textOf(value?.content ?? value?.output ?? JSON.stringify(value)),
  })).filter(unit => unit.text);
  const declared = new Set();
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'block') declared.add(String(node.id));
    for (const child of [...(node.children ?? []), ...(node.else ?? [])]) visit(child);
  };
  visit(snapshot?.stack?.root ?? snapshot?.stack);
  // Generated review outputs can arrive after the root's first failure. The
  // declared workflow result still owns the final recap after recovery.
  outputUnits.sort((a, b) => Number(declared.has(a.label.slice(7))) - Number(declared.has(b.label.slice(7))));
  return {
    status,
    attachments: snapshot?.meta?.attachments ?? [],
    workflow: workflowName ?? snapshot?.meta?.stackId ?? null,
    completed,
    failed,
    outstanding,
    outputUnits,
    error: snapshot?.meta?.error ?? null,
  };
}

export function deterministicSummary(capsule) {
  const lines = [];
  const finished = capsule.status === 'done';
  lines.push(finished ? 'The workflow finished.' : `The workflow ended with status: ${capsule.status}.`);
  if (capsule.completed.length) lines.push(`Completed: ${capsule.completed.join(', ')}.`);
  if (capsule.failed.length) lines.push(`Failed: ${capsule.failed.join(', ')}.`);
  if (capsule.outstanding.length) lines.push(`Still outstanding: ${capsule.outstanding.join(', ')}.`);
  if (capsule.outputUnits.length) {
    const last = capsule.outputUnits.at(-1);
    lines.push(`Final result from ${last.label.replace(/^OUTPUT /, '')}:\n\n${last.text}`);
  }
  if (capsule.error) lines.push(`Run error: ${capsule.error}`);
  return lines.join('\n\n');
}
