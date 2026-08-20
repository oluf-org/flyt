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
    "skills": ["a skill this project has"],
    "dependsOn": ["title of another task in this list"],
    "evidence": [{
      "claim": "the specific behavior this task transfers",
      "ref": "reference:repo/full/path/to/file.js",
      "line": 42,
      "excerpt": "a short exact excerpt from that line"
    }]
  }
]

Every task must be claimable on its own: a title, a goal, and at least one
checkable "done when". A task nobody can verify is not a task. blastRadius is
what the task may TOUCH; skills is what its worker must KNOW, named from the
skills this project actually has — an invented name resolves to nothing. When a task
mentions a reference repository, every referenced file needs a matching
evidence entry. Evidence is checked against the pinned clone before enqueue.`;

const evidenceList = (v, at, errors) => {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    errors.push(`${at}.evidence: must be an array of { claim, ref, line, excerpt } objects`);
    return [];
  }
  const out = [];
  v.forEach((item, i) => {
    const where = `${at}.evidence[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    if (!isStr(item.claim)) errors.push(`${where}.claim: required non-empty string`);
    if (!isStr(item.ref) || !/^reference:[a-zA-Z0-9][a-zA-Z0-9._-]*\/.+/.test(item.ref.trim())) {
      errors.push(`${where}.ref: must be a full reference:<repo>/<path> address`);
    }
    if (!Number.isInteger(item.line) || item.line < 1) {
      errors.push(`${where}.line: must be a positive integer`);
    }
    if (!isStr(item.excerpt)) errors.push(`${where}.excerpt: required exact text from the cited line`);
    if (isStr(item.claim) && isStr(item.ref) && Number.isInteger(item.line) && item.line > 0 && isStr(item.excerpt)) {
      out.push({
        claim: item.claim.trim(),
        ref: item.ref.trim(),
        line: item.line,
        excerpt: item.excerpt.trim()
      });
    }
  });
  return out;
};

// Find addresses that will be handed to the future task worker. This is kept
// deliberately narrower than a Markdown parser: reference paths cannot contain
// whitespace, and punctuation that commonly closes prose is not part of a path.
export function referencedFiles(task) {
  const text = [task.goal, ...(task.doneWhen ?? []), task.notes]
    .filter(Boolean).join('\n');
  const found = new Set();
  const re = /reference:[a-zA-Z0-9][a-zA-Z0-9._-]*\/[^\s`"'<>()[\]{},;]+/g;
  for (const match of text.matchAll(re)) {
    found.add(match[0].replace(/[.:!?]+$/, ''));
  }
  return [...found];
}

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
      // Expertise the future worker needs (core/backlog.js `skills`). Not
      // validated against the project's skills directory here: the planner is
      // SHOWN the menu, and a name that misses resolves to nothing and is
      // logged as a miss at run time, which is a better failure than refusing
      // a whole plan over one slug.
      skills: strList(t.skills, at, 'skills', errors),
      dependsOn: strList(t.dependsOn, at, 'dependsOn', errors),
      evidence: evidenceList(t.evidence, at, errors),
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

// Validate external evidence at the final hand-off boundary. Parsing proves
// the JSON has the right shape; this proves that a claimed source is part of
// THIS run, that its file exists in the pinned clone, and that the cited line
// contains the excerpt the planner says it does.
//
// Returns enriched copies so the backlog body records the commit verified by
// the machine rather than asking the model to copy a SHA correctly.
export function validateBacklogEvidence(tasks, {
  references = null,
  allowedReferences = [],
  requireEvidence = false
} = {}) {
  const errors = [];
  const allowed = new Map((allowedReferences ?? [])
    .map(r => typeof r === 'string' ? [r, null] : [r?.name, r?.commit ?? null])
    .filter(([name]) => Boolean(name)));

  const checked = tasks.map(task => {
    const cited = referencedFiles(task);
    const evidence = task.evidence ?? [];
    if (requireEvidence && allowed.size && !evidence.length) {
      errors.push(`tasks["${task.title}"].evidence: at least one verified citation is required by this hand-off`);
    }
    const prose = [task.goal, ...(task.doneWhen ?? []), task.notes]
      .filter(Boolean).join('\n');
    for (const ref of cited) {
      if (!evidence.some(item => item.ref === ref)) {
        errors.push(`tasks["${task.title}"].evidence: "${ref}" is mentioned without a matching evidence entry`);
      }
    }
    // A malformed or prose-only attribution must not bypass the evidence
    // boundary. A real run produced two OpenCode-derived tasks with zero
    // citations by spelling one path as `<reference>opencode/...` and naming
    // the other source only as prose; both were queued as "verified". If the
    // task names a repository this run read, it owes at least one verified
    // citation into that repository.
    for (const name of allowed.keys()) {
      const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(^|[^a-zA-Z0-9._-])${escaped}([^a-zA-Z0-9._-]|$)`, 'i').test(prose)) continue;
      if (!evidence.some(item => item.ref.startsWith(`reference:${name}/`))) {
        errors.push(`tasks["${task.title}"].evidence: reference repository "${name}" is mentioned without a verified file citation`);
      }
    }

    const verified = evidence.map((item, i) => {
      const repo = /^reference:([^/]+)\//.exec(item.ref)?.[1] ?? null;
      const where = `tasks["${task.title}"].evidence[${i}]`;
      if (!repo || !allowed.has(repo)) {
        errors.push(`${where}.ref: "${item.ref}" was not a reference repository recorded by this run`);
        return item;
      }
      if (!references?.verifyCitation) {
        errors.push(`${where}: no reference library is available to verify "${item.ref}"`);
        return item;
      }
      let result;
      try { result = references.verifyCitation(item); }
      catch (err) {
        errors.push(`${where}: ${String(err?.message ?? err)}`);
        return item;
      }
      if (!result?.ok) {
        errors.push(`${where}: ${result?.error ?? `could not verify "${item.ref}"`}`);
        return item;
      }
      const pinnedCommit = allowed.get(repo);
      if (pinnedCommit && result.commit !== pinnedCommit) {
        errors.push(`${where}: reference "${repo}" is at commit ${result.commit ?? 'unknown'}, but this run pinned ${pinnedCommit}`);
        return item;
      }
      return { ...item, ...(result.commit ? { commit: result.commit } : {}) };
    });
    return { ...task, evidence: verified };
  });

  return { ok: errors.length === 0, tasks: checked, errors };
}

// Rewrite title-based dependsOn into the real ids Backlog.add allocated.
// `byTitle` maps plan title -> task id.
export function resolveDependsOn(planTask, byTitle) {
  return (planTask.dependsOn ?? []).map(title => byTitle.get(title)).filter(Boolean);
}
