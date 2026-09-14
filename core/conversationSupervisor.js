// The Conversation Supervisor is a no-tool status turn over an immutable run.
// It never executes a workflow and never answers a block's direct question.
// Its only job is to turn durable run facts into the compact context capsule
// that makes the next user turn feel like the same conversation.
import { deterministicRunCapsule, deterministicSummary } from './runCapsule.js';
export { deterministicRunCapsule, deterministicSummary } from './runCapsule.js';
import { callModel as defaultCallModel } from './adapters/index.js';

const INTERNAL_CONTEXT_CHARS = 48_000;
const INTERNAL_OUTPUT_TOKENS = 900;

const textOf = value => String(value ?? '').trim();

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

export async function summarizeWorkflowRun({
  snapshot, workflowName = null, prior = [], worker = null,
  resolveModelSource = null, callModel = defaultCallModel,
  retry = null, timeout = null, deadlineMs = 7_000,
} = {}) {
  const capsule = deterministicRunCapsule(snapshot, { workflowName });
  const fallback = deterministicSummary(capsule);
  // A fluent recap must not turn a rejected candidate into an accepted result.
  // Intermediate outputs are claims; the run's terminal outcome is authoritative.
  if (capsule.status !== 'done' && worker?.model && typeof resolveModelSource === 'function') {
    return { text: fallback, capsule, model: null, degraded: false, reason: null };
  }
  if (!worker?.model || typeof resolveModelSource !== 'function') {
    return { text: fallback, capsule, model: null, degraded: true, reason: 'no supervisor model is configured' };
  }

  const units = [
    ...prior.map((entry, index) => ({ label: `PRIOR ${index + 1}`, text: entry?.text ?? entry })),
    ...capsule.outputUnits,
  ];
  const context = boundedSemanticContext(units);
  const controller = new AbortController();
  let timer;
  try {
    const route = resolveModelSource(worker.model, worker.provider && worker.provider !== 'auto' ? worker.provider : null);
    const request = callModel({
      ...route,
      system: [
        'You are the Conversation Supervisor for a completed workflow run.',
        'You have no tools and no authority to change anything.',
        'Write a concise final chat message: what was done, what failed or remains, important decisions, and the useful result.',
        'You receive text results and attachment names, not image pixels. Attribute visual findings to the workflow; do not claim to have inspected the images yourself.',
        'Do not claim work that is not present in the run facts. Do not expose implementation metadata.',
      ].join('\n'),
      prompt: [
        `WORKFLOW: ${capsule.workflow ?? 'Workflow'}`,
        `STATUS: ${capsule.status}`,
        ...(capsule.attachments.length ? [`REFERENCE ASSETS (retained for follow-up): ${capsule.attachments.map(asset => asset.name).join(', ')}`] : []),
        `COMPLETED: ${capsule.completed.join(', ') || 'none'}`,
        `FAILED: ${capsule.failed.join(', ') || 'none'}`,
        `OUTSTANDING: ${capsule.outstanding.join(', ') || 'none'}`,
        context,
      ].filter(Boolean).join('\n\n'),
      maxTokens: INTERNAL_OUTPUT_TOKENS,
      signal: controller.signal,
      ...(retry ? { retry } : {}),
      ...(timeout ? { timeout } : {}),
    });
    const result = await Promise.race([request, new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('The optional conversation summary exceeded its deadline; retained the run results.');
        controller.abort(error);
        reject(error);
      }, deadlineMs);
    })]);
    const text = textOf(result?.text ?? result?.content);
    if (!text) throw new Error('the supervisor returned an empty summary');
    return { text, capsule, model: `${route.provider}/${route.model}`, degraded: false, reason: null };
  } catch (error) {
    return { text: fallback, capsule, model: null, degraded: true, reason: textOf(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}
