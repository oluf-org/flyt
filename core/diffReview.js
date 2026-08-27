// The reviewer (DESIGN-SPEC.md §8): a second model reads the diff before it lands.
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
import { classifyAdapterError, needsHuman } from './adapters/failures.js';
import { extractJson } from './planEval.js';
import { REASONING_HEADROOM } from '../src/flowTypes.js';

// Large cross-cutting tasks commonly exceed 60k characters. The previous cap
// silently removed the tail before review, so a reviewer could see neither the
// final files nor their tests. Keep one shared budget with landing and make it
// large enough for a substantial task while retaining the fail-closed marker
// for genuinely oversized changes.
export const REVIEW_DIFF_BUDGET = 120_000;
// The verdict is short; arriving at it, over 60k of diff, is not. Sending the
// answer size as the whole completion budget starves a reasoning model into
// returning nothing (D40) — and this reviewer is the last thing between an
// unattended change and the main branch, so it failing quietly is the worst
// place in the system for this bug to live.
const MAX_TOKENS = 1200 + REASONING_HEADROOM;

// The verdict block comes FIRST, and that is not a style choice. A review of a
// sixty-thousand-character diff can run out of completion budget mid-sentence,
// and whatever is last is what gets cut — which used to be the verdict. The
// loop then read "the reviewer returned no usable verdict block" twice in one
// session and could not tell a truncated answer from a rambling one. Asking for
// the block first means a cut response still carries the only part that has to
// survive.
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
  'START your reply with ONE ```json block, before any prose:',
  '```json',
  '{"verdict":"approve|request-changes|reject","reason":"<one or two sentences>",',
  ' "changes":["<specific, actionable change>"],"concerns":["<anything worth flagging that is not blocking>"]}',
  '```',
  'approve = land it. request-changes = fixable, say exactly what. reject = this should not',
  'land and another attempt at the same thing will not help.',
  '',
  'Anything you want to add goes after the block. Nothing reads it, so keep it short or',
  'leave it out — the block is the review.'
].join('\n');

export const VERDICTS = ['approve', 'request-changes', 'reject'];

export function buildReviewPrompt({ task = {}, diff = '', gates = [], blastRadius = [], changedFiles = [], testDelta = null }) {
  const clipped = diff.length > REVIEW_DIFF_BUDGET
    ? `${diff.slice(0, REVIEW_DIFF_BUDGET)}\n…[diff truncated at ${REVIEW_DIFF_BUDGET} characters — treat an incomplete diff as a reason to request changes rather than approve]`
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
    // The test delta, stated rather than left to be noticed. A reviewer
    // reading a diff cannot see the suite, so "green" and "green because it is
    // the same suite" look identical from here — which is how 271 lines landed
    // across four tasks with the count unmoved and two defects behind it.
    testDelta && testDelta.before != null && testDelta.after != null
      ? `TEST COUNT: ${testDelta.before} before this change, ${testDelta.after} after`
        + `${testDelta.after === testDelta.before ? ' — UNCHANGED. The gates are green because it is the same suite; judge whether this change is actually covered.' : ''}`
      : 'TEST COUNT: not known for this change, so the gates say nothing about whether it is covered.',
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
  testDelta = null, retry, timeout, signal, onRetry = null
}) {
  if (!worker?.provider) {
    return {
      verdict: 'request-changes',
      reason: 'No reviewer model is configured, so nothing may land unattended.',
      changes: [], concerns: [], unavailable: true,
      unusable: { code: 'no-reviewer', remedy: 'Name a reviewer model. Nothing lands unattended without one.' }
    };
  }
  try {
    const res = await callModel({
      ...worker,
      // An explicit key wins; otherwise the worker's own, which the main
      // process stamps onto every configured worker. This used to spread
      // `apiKey` unconditionally, so a caller that had nothing extra to pass
      // (every one of them — `work:land` resolves the worker and not the key)
      // overwrote a stamped key with `undefined`. The review then failed on a
      // missing key, and a failed review is a request for changes: nothing
      // could ever land unattended, and the reason never appeared anywhere
      // except inside the reviewer's own excuse.
      ...(apiKey ? { apiKey } : {}),
      system: REVIEW_SYSTEM,
      prompt: buildReviewPrompt({ task, diff, gates, blastRadius, changedFiles, testDelta }),
      maxTokens: MAX_TOKENS, retry, timeout, signal, onRetry
    });
    const parsed = parseReview(res.text);
    if (!parsed) {
      // WHICH failure, because they call for different things and the loop was
      // being told the same sentence for both. A review cut off at the token
      // budget wants a bigger budget or a smaller diff; one that answered in
      // prose wants a different reviewer. "No usable verdict block" is what you
      // say when you have not looked.
      const cut = res.finishReason === 'length';
      return {
        verdict: 'request-changes',
        reason: cut
          ? `The reviewer ran out of its completion budget before finishing (${res.text?.length ?? 0}`
            + ' characters, cut mid-answer). The diff may be too large to review in one pass.'
          : 'The reviewer answered without a verdict block, so there is nothing to read as a decision.',
        changes: [], concerns: [], unavailable: true, truncated: cut,
        // WHY it could not be read, structured, because the two want different
        // things: a cut answer wants a smaller diff or a bigger budget, and a
        // reviewer that will not emit the block wants a different reviewer.
        unusable: cut
          ? { code: 'reviewer-truncated', remedy: 'The diff outran the completion budget. Split the change, or raise the reviewer token budget.' }
          : { code: 'reviewer-no-verdict', remedy: 'The reviewer did not return the verdict block it was asked for. Use a reviewer that follows the format, or a stronger one.' }
      };
    }
    return { ...parsed, model: { provider: res.provider, model: res.model }, usage: res.usage ?? null };
  } catch (err) {
    // A reviewer that COULD NOT RUN is not a reviewer that objected.
    //
    // Both used to arrive as `request-changes`, so a provider refusing the
    // review call was charged to the task as a rejection: the work was sent
    // back, the attempt counted, the rung spent. Watched it on 2026-08-24 —
    // a worker on a free model produced a diff, the reviewer was still pointed
    // at a paid one, and the 402 that came back read as "the reviewer wants
    // changes".
    //
    // `refusal` is set only when nothing about retrying, escalating or picking
    // another task would get past it (core/adapters/failures.js), which is
    // exactly when the caller must stop rather than blame the diff.
    const seen = classifyAdapterError(err, { provider: 'the reviewer' });
    return {
      verdict: 'request-changes',
      reason: `The review could not be completed: ${String(err?.message ?? err).slice(0, 200)}`,
      changes: [], concerns: [], unavailable: true,
      ...(needsHuman(seen.code) ? { refusal: { code: seen.code, remedy: seen.remedy } } : {})
    };
  }
}

// Who reviews. `workers.reviewer` when configured; otherwise nothing, and
// nothing landing unattended is the correct default for an unconfigured repo.
export function reviewWorker(config = {}) {
  const w = config.workers?.reviewer;
  return w?.provider && w?.model ? w : null;
}
