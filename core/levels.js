// Effort levels, and what they cost (DESIGN-SPEC.md §8).
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
  // A model somebody NAMED is a decision already made. The Auto Router plugin
  // exists to make that decision, so sending both asks OpenRouter to overrule
  // the pin — and the caller would never see which model actually answered. A
  // named model therefore carries no routing at all.
  if (model !== AUTO_MODEL) return { provider: 'openrouter', model };
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
 * The model for a level, when the bands have been given models by name.
 *
 * The Auto Router (above) answers "who should do this" by price band. Naming
 * models per band answers it yourself, and it is what you want as soon as cost
 * is the constraint rather than capability: a cheap model does the ordinary
 * work, and the expensive one is what ESCALATION reaches — which is exactly
 * what the ladder already means. One expensive model on every task is the bill
 * nobody wanted; one expensive model on the tasks that failed twice is the
 * whole point of having rungs.
 *
 * The map is sparse and fills DOWNWARD from the nearest band at or below the
 * one asked for, so `{ low: cheap, high: strong }` is a complete answer for all
 * five levels: low and medium get cheap, high, xhigh and max get strong. A map
 * with no entry at or below the level falls back to the lowest one set, because
 * "no model" is not a useful answer to a task that is ready to run.
 *
 * Returns null when nothing is mapped at all — the caller then asks for a band.
 */
export function workerForLevelMap(level, models = {}) {
  const wanted = levelIndex(normalizeLevel(level));
  const set = LEVELS
    .map((name, i) => ({ i, model: typeof models?.[name] === 'string' ? models[name].trim() : '' }))
    .filter(e => e.model);
  if (!set.length) return null;
  const at = [...set].reverse().find(e => e.i <= wanted) ?? set[0];
  return { provider: 'auto', model: at.model, level: LEVELS[at.i] };
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
 * `workerAt` is how the ladder finds out whether it has a rung to climb. When
 * models are named per band the map fills DOWNWARD, so `{ medium: cheap }` is
 * a complete answer for all five levels and every one of them is `cheap`; a
 * single `--model` pin does the same thing more obviously. Escalating through
 * that is four more attempts by the same model, announced as more capability —
 * the failure the 'failed' note above already names, arrived at from the other
 * direction. Watched live it spent four rungs of a task's budget and read, in
 * the log, as a ladder being climbed.
 *
 * So the rung is checked before it is taken, and a ladder that cannot change
 * the worker is out of ladder — the outcome that already exists for the top of
 * it. Omit `workerAt`, or return null from it, which is what the Auto Router
 * path does: there the band itself IS the change, so the climb is real.
 *
 * Returns `{ level, escalated, reason }`. `escalated: false` with `level: null`
 * means the ladder is exhausted — a human decision, not another attempt.
 */
export function escalate({ level, reason = 'failed', attempts = 0, workerAt = null } = {}) {
  const current = normalizeLevel(level);
  const next = nextLevel(current);
  if (next && typeof workerAt === 'function') {
    const here = workerAt(current);
    const there = workerAt(next);
    if (here && there && here === there) {
      return {
        level: null,
        escalated: false,
        exhausted: true,
        from: current,
        sameWorker: there,
        reason: `"${next}" runs the same model as "${current}" (${there}), so escalating would retry`
          + ` the same capability after ${attempts} attempt(s). Name a stronger model for a higher`
          + ' band, or work it yourself.'
      };
    }
  }
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
