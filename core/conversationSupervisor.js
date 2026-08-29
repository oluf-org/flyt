// The Conversation Supervisor is a no-tool status turn over an immutable run.
// It never executes a workflow and never answers a block's direct question.
// Its only job is to turn durable run facts into the compact context capsule
// that makes the next user turn feel like the same conversation.
import { callModel as defaultCallModel } from './adapters/index.js';

const INTERNAL_CONTEXT_CHARS = 48_000;
const INTERNAL_OUTPUT_TOKENS = 900;

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
  return {
    status,
    workflow: workflowName ?? snapshot?.meta?.stackId ?? null,
    completed,
    failed,
    outstanding,
    outputUnits,
    error: snapshot?.meta?.error ?? null,
  };
}

// Bounds whole semantic units; never slice a model output in the middle.
export function boundedSemanticContext(units, maxChars = INTERNAL_CONTEXT_CHARS) {
  const accepted = [];
  let used = 0;
  for (const unit of [...units].reverse()) {
    const text = textOf(unit?.text);
    if (!text) continue;
    const rendered = `${textOf(unit.label) || 'CONTEXT'}:\n${text}`;
    if (accepted.length && used + rendered.length > maxChars) continue;
    if (!accepted.length && rendered.length > maxChars) {
      // The first oversized unit is represented by its identity, not a chopped
      // body. The deterministic capsule still carries its status and source.
      accepted.push(`${textOf(unit.label) || 'CONTEXT'}: [output too large for the supervisor context]`);
      break;
    }
    accepted.push(rendered);
    used += rendered.length;
  }
  return accepted.reverse().join('\n\n');
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

export async function summarizeWorkflowRun({
  snapshot, workflowName = null, prior = [], worker = null,
  resolveModelSource = null, callModel = defaultCallModel,
  retry = null, timeout = null,
} = {}) {
  const capsule = deterministicRunCapsule(snapshot, { workflowName });
  const fallback = deterministicSummary(capsule);
  if (!worker?.model || typeof resolveModelSource !== 'function') {
    return { text: fallback, capsule, model: null, degraded: true, reason: 'no supervisor model is configured' };
  }

  const units = [
    ...prior.map((entry, index) => ({ label: `PRIOR ${index + 1}`, text: entry?.text ?? entry })),
    ...capsule.outputUnits,
  ];
  const context = boundedSemanticContext(units);
  try {
    const route = resolveModelSource(worker.model, worker.provider && worker.provider !== 'auto' ? worker.provider : null);
    const result = await callModel({
      ...route,
      system: [
        'You are the Conversation Supervisor for a completed workflow run.',
        'You have no tools and no authority to change anything.',
        'Write a concise final chat message: what was done, what failed or remains, important decisions, and the useful result.',
        'Do not claim work that is not present in the run facts. Do not expose implementation metadata.',
      ].join('\n'),
      prompt: [
        `WORKFLOW: ${capsule.workflow ?? 'Workflow'}`,
        `STATUS: ${capsule.status}`,
        `COMPLETED: ${capsule.completed.join(', ') || 'none'}`,
        `FAILED: ${capsule.failed.join(', ') || 'none'}`,
        `OUTSTANDING: ${capsule.outstanding.join(', ') || 'none'}`,
        context,
      ].filter(Boolean).join('\n\n'),
      maxTokens: INTERNAL_OUTPUT_TOKENS,
      ...(retry ? { retry } : {}),
      ...(timeout ? { timeout } : {}),
    });
    const text = textOf(result?.text ?? result?.content);
    if (!text) throw new Error('the supervisor returned an empty summary');
    return { text, capsule, model: `${route.provider}/${route.model}`, degraded: false, reason: null };
  } catch (error) {
    return { text: fallback, capsule, model: null, degraded: true, reason: textOf(error?.message ?? error) };
  }
}
