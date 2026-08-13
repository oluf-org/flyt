// The retrospective turn (LOOP-PLAN §12.0).
//
// An instance is prompted with its scoped task and the tools it was given. When
// it finishes, its completion is handed back to it and it is prompted ONCE
// more: how was the toolbox, and what was missing?
//
// Why a second turn rather than a tool the agent may call: a tool is voluntary,
// and an agent that never calls it teaches nothing. The whole value here is the
// aggregate — twelve instances all reporting the same missing capability is the
// argument for building it — and an aggregate assembled from whoever happened
// to volunteer is not an aggregate, it is a sample biased toward the models
// that follow instructions best. A turn always happens, so every instance is
// counted.
//
// The cost is one extra call per instance, and it is bounded deliberately:
//   - it holds NO tools, so it cannot loop,
//   - its output is small and capped,
//   - it takes `workers.retrospective` when configured, so the judgment can run
//     on a cheap model no matter which tier did the work (§8). Asking a
//     frontier model how it felt about `read_file` is not where the money goes.
//
// It must never fail the task. The work is already done and verified by the
// time this runs; a retrospective that errors, times out or returns nonsense is
// logged and dropped.
import { callModel } from './adapters/index.js';
import { extractJson } from './planEval.js';
import { FeedbackStore, RATINGS } from './feedback.js';

// How much of the instance's own output to hand back. Enough to remember what
// it did, not so much that the retrospective costs as much as the work.
const OUTPUT_BUDGET = 4000;
const GOAL_BUDGET = 2000;
const MAX_TOKENS = 900;

export const RETRO_SYSTEM = [
  'ROLE: retrospective',
  'You have just completed the task below. Review the TOOLS you had, not the work itself.',
  'Two questions, and only these two:',
  '1. For each tool you actually used: was it good, adequate, awkward or broken, and what',
  '   ONE specific change would have made it better?',
  '2. What capability did you NOT have that would have helped? Be concrete about the',
  '   capability, not the wish: "search file contents by regex across the repo" is',
  '   actionable; "better tools" is not.',
  '',
  'Answer with ONE ```json block and nothing after it:',
  '```json',
  '{"used":[{"tool":"<name>","rating":"good|adequate|awkward|broken","note":"<what happened>","improvement":"<the one change>"}],',
  ' "missing":[{"want":"<the capability>","why":"<what you were doing>","workaround":"<what you did instead, and what it cost>"}]}',
  '```',
  'Both arrays may be empty. Report nothing rather than inventing something: a tool that',
  'simply worked is "good" with a short note, and no missing capability is a real answer.',
  'Judge only tools you actually called. Do not mention tools you never used.'
].join('\n');

const clip = (s, n) => {
  const text = String(s ?? '');
  return text.length > n ? `${text.slice(0, n)}\n…[truncated]` : text;
};

/**
 * The prompt an instance sees for its retrospective: what it was asked to do,
 * what it HAD, what it actually called, and what it produced.
 *
 * The available-tools list is the load-bearing part. Without it a model reports
 * missing capabilities it was in fact granted, which is worse than useless —
 * it is noise that looks like signal in the digest.
 */
export function buildRetroPrompt({ goal, availableTools = [], toolCalls = [], output = '' }) {
  const usage = FeedbackStore.usageFromToolCalls(toolCalls);
  return [
    `YOUR TASK WAS:\n${clip(goal, GOAL_BUDGET)}`,
    availableTools.length
      ? `TOOLS YOU HAD (this is the complete list — anything not here, you did not have):\n${
        availableTools.map(t => `- ${t.name}: ${t.description ?? ''}`.trim()).join('\n')}`
      : 'TOOLS YOU HAD: none.',
    usage.length
      ? `WHAT YOU CALLED:\n${usage.map(u =>
        `- ${u.tool}: ${u.calls} call(s), ${u.failures} failure(s)${
          u.errors.length ? `, e.g. ${u.errors[0]}` : ''}`).join('\n')}`
      : 'WHAT YOU CALLED: nothing.',
    `WHAT YOU PRODUCED:\n${clip(output, OUTPUT_BUDGET)}`
  ].join('\n\n');
}

// Accept only what the contract allows. A model that invents a rating, reviews
// a tool it never had, or returns a string where an array belongs produces a
// partial retrospective rather than a rejected one — some signal beats none,
// and the digest is robust to a missing field but not to a bad shape.
export function parseRetro(text, { availableTools = [] } = {}) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object') return null;
  const known = new Set(availableTools.map(t => t.name));
  const str = v => (typeof v === 'string' ? v.trim() : '');

  const used = (Array.isArray(raw.used) ? raw.used : [])
    .filter(u => u && typeof u === 'object' && str(u.tool))
    // A review of a tool the instance never had is a hallucination, and one
    // that would sit in the digest looking like evidence.
    .filter(u => !known.size || known.has(str(u.tool)))
    .map(u => ({
      tool: str(u.tool),
      rating: RATINGS.includes(str(u.rating)) ? str(u.rating) : 'adequate',
      note: str(u.note),
      improvement: str(u.improvement)
    }));

  const missing = (Array.isArray(raw.missing) ? raw.missing : [])
    .filter(m => m && typeof m === 'object' && str(m.want))
    .map(m => ({ want: str(m.want), why: str(m.why), workaround: str(m.workaround) }));

  return { used, missing };
}

/**
 * Run the turn. Returns { used, missing } or null — never throws.
 *
 * `null` means "no retrospective from this instance", which callers treat as
 * ordinary. The work is finished by the time this runs, and no failure here is
 * worth failing a completed task over.
 */
export async function runRetrospectiveTurn({
  worker, apiKey, goal, availableTools = [], toolCalls = [], output = '',
  retry, timeout, signal, onRetry = null, onProblem = null
}) {
  if (!worker?.provider) return null;
  try {
    const res = await callModel({
      ...worker,
      apiKey,
      system: RETRO_SYSTEM,
      prompt: buildRetroPrompt({ goal, availableTools, toolCalls, output }),
      maxTokens: MAX_TOKENS,
      retry,
      timeout,
      signal,
      onRetry
    });
    const parsed = parseRetro(res.text, { availableTools });
    if (!parsed) {
      onProblem?.('retrospective returned no parsable ```json block');
      return null;
    }
    return { ...parsed, usage: res.usage ?? null, model: { provider: res.provider, model: res.model } };
  } catch (err) {
    // Includes a deliberate stop: an aborted retrospective is simply absent.
    onProblem?.(`retrospective turn failed: ${String(err?.message ?? err).slice(0, 200)}`);
    return null;
  }
}

/**
 * Which worker asks the question. `workers.retrospective` when configured, so
 * the judgment can run on a cheap model regardless of which tier did the work;
 * otherwise the instance's own worker, which is correct but not thrifty.
 */
export function retroWorker(config = {}, fallback = null) {
  const configured = config.workers?.retrospective;
  return configured?.provider && configured?.model ? configured : fallback;
}

// Off by default is wrong for the loop and right for an attended user who did
// not ask for a second call per node: the loop turns it on (config.json), and
// nothing else pays for it silently.
export const retroEnabled = (config = {}) => config.retrospective?.enabled === true;
