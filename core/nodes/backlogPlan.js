// The flow → backlog contract (DECISIONS.md D36).
//
// A flow that wants the loop to work on what it just figured out has to hand
// over something the supervisor can actually claim. The alternative — the loop
// node parsing a combiner's prose — puts a parser where a contract belongs;
// plan-eval already set the precedent for a strict JSON contract, and this is
// the same shape pointed at core/backlog.js instead of at the node catalog.
//
// The failure mode this exists to make mechanically detectable: a plausible,
// useless task that no supervisor can pick up (DECISIONS.md D36, P5.4).

import { extractJson } from '../planEval.js';
import { LEVELS } from '../levels.js';

export const BACKLOG_PLAN_ROLE = 'plan-backlog';

// Field-for-field against core/backlog.js DEFAULTS(). Anything outside this
// list is dropped rather than passed through: `add()` would happily write a
// typo'd field into the frontmatter and it would live there forever.
const clamp15 = n => Math.min(5, Math.max(1, Math.round(n)));
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const strList = (v, at, field, errors) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some(x => !isStr(x))) {
    errors.push(`${at}.${field}: must be an array of non-empty strings`);
    return [];
  }
  return v.map(x => x.trim());
};

export const BACKLOG_PLAN_CONTRACT = `Respond with your reasoning in prose, then ONE fenced \`\`\`json block containing an
array of backlog tasks:

[
  {
    "title": "short imperative title",
    "goal": "what must be true when this is done, in a paragraph",
    "doneWhen": ["a checkable acceptance criterion", "..."],
    "value": 1-5, "effort": 1-5,
    "level": "low|medium|high|xhigh|max",
    "gates": ["npm test"],
    "blastRadius": ["src/thing.js"],
    "dependsOn": ["title of another task in this list"]
  }
]

Every task must be claimable on its own: a title, a goal, and at least one
checkable "done when". A task nobody can verify is not a task.`;

// text -> { ok, tasks[], errors[] }. Never throws: a violated contract is a
// result the caller reports, not an exception it has to catch.
export function parseBacklogPlan(text) {
  const errors = [];
  const raw = extractJson(text);
  // The contract is an array; a single object is a common near-miss and is
  // accepted rather than rejected on a technicality, as is { tasks: [...] }.
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.tasks) ? raw.tasks
    : raw && typeof raw === 'object' && (raw.title || raw.goal) ? [raw]
    : null;
  if (!list) {
    return { ok: false, tasks: [], errors: ['no JSON array of tasks found — emit exactly ONE ```json block containing an array'] };
  }
  if (!list.length) {
    return { ok: false, tasks: [], errors: ['the task array is empty — a plan with no work in it is not a plan'] };
  }

  const tasks = [];
  const titles = new Set();
  list.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) { errors.push(`${at}: must be an object`); return; }
    if (!isStr(t.title)) { errors.push(`${at}.title: required non-empty string`); return; }
    if (!isStr(t.goal)) { errors.push(`${at}.goal: required non-empty string — "${t.title}" says what to do but not what done looks like`); return; }
    const doneWhen = strList(t.doneWhen, at, 'doneWhen', errors);
    if (!doneWhen.length) {
      errors.push(`${at}.doneWhen: at least one checkable criterion — a task nobody can verify is not a task`);
      return;
    }
    const title = t.title.trim().slice(0, 120);
    if (titles.has(title)) { errors.push(`${at}.title: duplicate title "${title}"`); return; }
    titles.add(title);

    const level = isStr(t.level) && LEVELS.includes(t.level.trim()) ? t.level.trim() : null;
    if (t.level != null && !level) errors.push(`${at}.level: must be one of ${LEVELS.join(', ')}`);

    tasks.push({
      title,
      goal: t.goal.trim(),
      doneWhen,
      value: Number.isFinite(t.value) ? clamp15(t.value) : 3,
      effort: Number.isFinite(t.effort) ? clamp15(t.effort) : 3,
      ...(level ? { level } : {}),
      gates: strList(t.gates, at, 'gates', errors),
      blastRadius: strList(t.blastRadius, at, 'blastRadius', errors),
      dependsOn: strList(t.dependsOn, at, 'dependsOn', errors),
      ...(isStr(t.notes) ? { notes: t.notes.trim() } : {})
    });
  });

  // dependsOn names another task IN THIS PLAN, by title. Ids do not exist yet
  // — they are allocated by Backlog.add — so the resolution happens after
  // enqueue (see resolveDependsOn). A name nothing matches is an error here,
  // because the alternative is a task that waits forever on a ghost.
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!titles.has(d)) {
        errors.push(`tasks["${t.title}"].dependsOn: "${d}" is not the title of any task in this plan`);
      }
    }
  }

  return { ok: errors.length === 0, tasks, errors };
}

// Rewrite title-based dependsOn into the real ids Backlog.add allocated.
// `byTitle` maps plan title -> task id.
export function resolveDependsOn(planTask, byTitle) {
  return (planTask.dependsOn ?? []).map(title => byTitle.get(title)).filter(Boolean);
}
