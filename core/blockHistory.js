// The compact facts displayed in Build's run history, without log/tool bodies.
export function blockHistoryRows(snapshot, run) {
  return Object.entries(snapshot?.meta?.nodeStatus ?? {}).map(([nodeId, status]) => {
    const evidence = snapshot.retrospectives?.[nodeId] ?? {};
    const output = snapshot.nodeOutputs?.[nodeId];
    return {
      kind: 'run', nodeId, runId: run.id, command: `Run · ${status}`,
      caller: run.name ?? run.id, at: run.updatedAt ?? run.createdAt,
      error: evidence.error ?? (status === 'failed' ? snapshot.meta?.error : null),
      details: [
        evidence.toolCalls?.length ? `${evidence.toolCalls.length} tool call${evidence.toolCalls.length === 1 ? '' : 's'}` : '',
        Object.keys(evidence.usage ?? {}).length ? `usage ${JSON.stringify(evidence.usage)}` : '',
        output != null ? `output ${String(output).slice(0, 240)}` : '',
      ].filter(Boolean).join(' · '),
    };
  });
}
