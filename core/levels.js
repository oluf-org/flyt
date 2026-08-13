// Effort levels, and what they cost (LOOP-PLAN §8).
//
// The plan had a tier ladder: a price table per provider+model, a tier axis on
// `modelPriority.js`, and a routing policy that picked a model per task. That is
// real work, and it goes stale the week after it ships — every new model release
// is a table edit, and a table edit nobody makes is a loop routing to last
// quarter's prices.
//
// OpenRouter already sells exactly that as a service. Its Auto Router takes a
// `cost_tier` — low | medium | high | xhigh | max — and picks a capable model in
// that band, honoring your own account restrictions, and charges the standard
// rate for whatever it picks. So a "tier" here is not a model we chose; it is a
// band we asked for.
//
// What that buys, beyond not maintaining a price table: the ladder has real
// rungs, so ESCALATION is one function. A task that failed retries a rung up. A
// task that has been grinding for hours moves a rung up. A task at `max` that
// still fails is out of ladder and belongs to a human (§8.2) — which is the
// same "escalate means a bigger model, then a person" shape the plan wanted,
// with the model selection delegated to someone who updates it daily.
//
// The cost of this cheat, stated plainly: spend is bounded by BAND rather than
// by dollars, so §9's caps still need real numbers before an overnight run can
// promise a ceiling. A band is a policy, not a budget.

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_LEVEL = 'low';

export const AUTO_MODEL = 'openrouter/auto';

export function normalizeLevel(value, fallback = DEFAULT_LEVEL) {
  const v = String(value ?? '').toLowerCase().trim();
  return LEVELS.includes(v) ? v : fallback;
}

export const levelIndex = level => LEVELS.indexOf(normalizeLevel(level));

/**
 * One rung up, or null at the top.
 *
 * `null` is the important half: it is what makes "out of ladder" a distinct
 * outcome from "try again", so the supervisor parks the task for a human
 * instead of re-running `max` forever at the most expensive band there is.
 */
export function nextLevel(level) {
  const i = levelIndex(level);
  return i >= 0 && i < LEVELS.length - 1 ? LEVELS[i + 1] : null;
}

// Never quietly go down. A task that was escalated to `high` stays there for
// its remaining attempts — the reason it was escalated has not gone away.
export const maxLevel = (a, b) => (levelIndex(a) >= levelIndex(b) ? normalizeLevel(a) : normalizeLevel(b));

/**
 * The worker for a level: the Auto Router, asked for that cost band.
 *
 * `allowedModels` narrows what the router may pick (`anthropic/*`), which is
 * how a project pins itself to providers it trusts without going back to
 * naming individual models.
 */
export function workerForLevel(level, { allowedModels = null, model = AUTO_MODEL } = {}) {
  return {
    provider: 'openrouter',
    model,
    routing: {
      costTier: normalizeLevel(level),
      ...(allowedModels?.length ? { allowedModels } : {})
    }
  };
}

/**
 * Should this task move up a rung, and to what?
 *
 * The two triggers the supervisor owns (§8.2, §11.4):
 *   - 'failed'  — an attempt did not land. A retry at the same band is a retry
 *                 of the same capability, and mostly produces the same answer.
 *   - 'stalled' — the task is making no headway (§11.2). More capability is the
 *                 cheapest thing to try before parking it.
 *
 * Returns `{ level, escalated, reason }`. `escalated: false` with `level: null`
 * means the ladder is exhausted — a human decision, not another attempt.
 */
export function escalate({ level, reason = 'failed', attempts = 0 } = {}) {
  const current = normalizeLevel(level);
  const next = nextLevel(current);
  if (!next) {
    return {
      level: null,
      escalated: false,
      exhausted: true,
      from: current,
      reason: `Already at "${current}", the top of the ladder, after ${attempts} attempt(s). A bigger model is not the missing piece.`
    };
  }
  return {
    level: next,
    escalated: true,
    exhausted: false,
    from: current,
    reason: reason === 'stalled'
      ? `No headway at "${current}"; retrying at "${next}".`
      : `Attempt ${attempts} failed at "${current}"; retrying at "${next}".`
  };
}

/**
 * The level a task should run at right now: its own, floored by the project's
 * minimum. A repo can refuse to ever run its work on the cheapest band without
 * having to edit every task.
 */
export function levelFor(task = {}, config = {}) {
  const floor = normalizeLevel(config.loop?.minLevel, DEFAULT_LEVEL);
  return maxLevel(normalizeLevel(task.level ?? task.tier, floor), floor);
}
