// The reviewer (LOOP-PLAN §7.2): a second model reads the diff before it lands.
//
// Gates prove the suite is green. They cannot tell you the change is *right* —
// that it did what the task asked, that it did not quietly widen its own scope,
// that it is not green because it deleted the awkward test. That is what this
// is for, and it is the second half of the answer to "what must be true before
// a task counts as done".
//
// Two rules that make it worth its cost:
//   - it runs ONE TIER ABOVE the model that wrote the code (§8). A cheap model
//     reviewing its own cheap output is theatre.
//   - it never sees the author's reasoning, only the task, the diff and the
//     gate results. Handing it the author's justification is how a reviewer
//     gets talked into things.
import { callModel } from './adapters/index.js';
import { extractJson } from './planEval.js';
import { REASONING_HEADROOM } from '../src/flowTypes.js';

const DIFF_BUDGET = 60_000;
// The verdict is short; arriving at it, over 60k of diff, is not. Sending the
// answer size as the whole completion budget starves a reasoning model into
// returning nothing (D40) — and this reviewer is the last thing between an
// unattended change and the main branch, so it failing quietly is the worst
// place in the system for this bug to live.
const MAX_TOKENS = 1200 + REASONING_HEADROOM;

export const REVIEW_SYSTEM = [
  'ROLE: diff-review',
  'You are reviewing a change before it is merged into the main branch of a real repository,',
  'unattended. Nobody will look at it before it lands. Be the last line of defence.',
  '',
  'You are given the task the change was meant to accomplish, the diff, the gate results',
  '(tests and lint, already run by the harness — you do not need to verify them), and the',
  'paths the task declared it would touch.',
  '',
  'Judge exactly these things:',
  '1. Does the change accomplish the task as stated?',
  '2. Does it do anything the task did NOT ask for — unrelated refactors, scope creep,',
  '   changes outside the declared blast radius that are not obviously necessary?',
  '3. Are the tests honest? Deleted, skipped, or weakened assertions are a REJECT even',
  '   when the suite is green. A test changed to match new behaviour is fine if the new',
  '   behaviour is what the task asked for.',
  '4. Is anything here dangerous to land unattended — destructive operations, credentials,',
  '   a change to how the project verifies itself?',
  '',
  'Do NOT review style, naming or formatting. The suite is green; you are judging whether',
  'this should be on main.',
  '',
  'End with ONE ```json block and nothing after it:',
  '```json',
  '{"verdict":"approve|request-changes|reject","reason":"<one or two sentences>",',
  ' "changes":["<specific, actionable change>"],"concerns":["<anything worth flagging that is not blocking>"]}',
  '```',
  'approve = land it. request-changes = fixable, say exactly what. reject = this should not',
  'land and another attempt at the same thing will not help.'
].join('\n');

export const VERDICTS = ['approve', 'request-changes', 'reject'];

export function buildReviewPrompt({ task = {}, diff = '', gates = [], blastRadius = [], changedFiles = [] }) {
  const clipped = diff.length > DIFF_BUDGET
    ? `${diff.slice(0, DIFF_BUDGET)}\n…[diff truncated at ${DIFF_BUDGET} characters — treat an incomplete diff as a reason to request changes rather than approve]`
    : diff;
  const outside = blastRadius.length
    ? changedFiles.filter(f => !blastRadius.some(b => f === b || f.startsWith(b)))
    : [];
  return [
    `TASK: ${task.title ?? '(untitled)'}`,
    task.body ? `TASK DETAIL:\n${task.body}` : '',
    blastRadius.length ? `DECLARED BLAST RADIUS:\n${blastRadius.map(b => `- ${b}`).join('\n')}` : '',
    // Named explicitly rather than left for the reviewer to notice: a file
    // outside the declared radius is usually benign and occasionally the whole
    // story, and it should have to be justified either way.
    outside.length ? `FILES CHANGED OUTSIDE THAT RADIUS:\n${outside.map(f => `- ${f}`).join('\n')}` : '',
    gates.length
      ? `GATE RESULTS (run by the harness):\n${gates.map(g => `- ${g.command}: ${g.status}${g.code != null ? ` (exit ${g.code})` : ''}`).join('\n')}`
      : 'GATE RESULTS: none run.',
    `DIFF:\n${clipped || '(empty diff)'}`
  ].filter(Boolean).join('\n\n');
}

export function parseReview(text) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object') return null;
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const list = v => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  const verdict = str(raw.verdict).toLowerCase();
  return {
    // An unparseable verdict is NOT an approval. Fail-closed is the house rule
    // (core/safetyCheck.js), and this is the gate that decides what reaches main.
    verdict: VERDICTS.includes(verdict) ? verdict : 'request-changes',
    reason: str(raw.reason) || (VERDICTS.includes(verdict) ? '' : 'The reviewer did not return a usable verdict.'),
    changes: list(raw.changes),
    concerns: list(raw.concerns)
  };
}

/**
 * Review a diff. Unlike the retrospective turn, a failure here is NOT ignored:
 * this decides what reaches main, so an unavailable reviewer means "do not
 * land" rather than "land unreviewed".
 */
export async function reviewDiff({
  worker, apiKey, task, diff, gates = [], blastRadius = [], changedFiles = [],
  retry, timeout, signal, onRetry = null
}) {
  if (!worker?.provider) {
    return { verdict: 'request-changes', reason: 'No reviewer model is configured, so nothing may land unattended.', changes: [], concerns: [], unavailable: true };
  }
  try {
    const res = await callModel({
      ...worker, apiKey,
      system: REVIEW_SYSTEM,
      prompt: buildReviewPrompt({ task, diff, gates, blastRadius, changedFiles }),
      maxTokens: MAX_TOKENS, retry, timeout, signal, onRetry
    });
    const parsed = parseReview(res.text);
    if (!parsed) {
      return {
        verdict: 'request-changes',
        reason: 'The reviewer returned no usable verdict block.',
        changes: [], concerns: [], unavailable: true
      };
    }
    return { ...parsed, model: { provider: res.provider, model: res.model }, usage: res.usage ?? null };
  } catch (err) {
    return {
      verdict: 'request-changes',
      reason: `The review could not be completed: ${String(err?.message ?? err).slice(0, 200)}`,
      changes: [], concerns: [], unavailable: true
    };
  }
}

// Who reviews. `workers.reviewer` when configured; otherwise nothing, and
// nothing landing unattended is the correct default for an unconfigured repo.
export function reviewWorker(config = {}) {
  const w = config.workers?.reviewer;
  return w?.provider && w?.model ? w : null;
}
