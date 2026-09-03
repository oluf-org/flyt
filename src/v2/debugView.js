const text = value => String(value ?? '').trim();

/** Every recorded output, including the pre-retry output that Work no longer shows. */
export function debugOutputHistory(trace) {
  const byBlock = {};
  for (const event of trace?.others ?? []) {
    if (event?.type !== 'block.output' || !event.data?.blockId) continue;
    const id = String(event.data.blockId);
    byBlock[id] ??= [];
    byBlock[id].push({ at: event.at ?? null, content: text(event.data.content) });
  }
  return byBlock;
}

export function debugReportMarkdown(report, runId = null) {
  if (!report) return '';
  const lines = [
    '# Flyt workflow debug report', '',
    `- Run: ${runId ?? report.facts?.run?.id ?? 'unknown'}`,
    `- Workflow: ${report.facts?.run?.workflow ?? report.facts?.run?.workflowId ?? 'unknown'}`,
    `- Stage: ${report.facts?.run?.stage ?? 'unknown'}`,
    `- Confidence: ${report.confidence ?? 'unknown'}`,
    `- Suspected block: ${report.suspectedBlockId ?? 'none identified'}`,
    `- Debug model: ${report.model ?? `deterministic fallback${report.reason ? ` (${report.reason})` : ''}`}`,
    '', '## Summary', '', text(report.summary) || 'No summary.',
    '', '## Probable cause', '', text(report.probableCause) || 'No probable cause identified.',
  ];
  if (report.evidence?.length) lines.push('', '## Evidence', '', ...report.evidence.map(item => `- ${text(item)}`));
  if (report.suggestedAreas?.length) lines.push('', '## Suggested areas to inspect', '', ...report.suggestedAreas.map(item => `- ${text(item)}`));
  if (report.recommendedAction) lines.push('', '## Recommended action', '', text(report.recommendedAction));
  if (report.suggestedPrompt) lines.push('', '## Proposed retry instruction', '', text(report.suggestedPrompt));
  lines.push('', '## Run context', '', '```json', JSON.stringify(report.facts ?? {}, null, 2), '```', '');
  return lines.join('\n');
}

