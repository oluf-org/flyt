// Strict parsing + validation for the structured outputs of the reflective
// planning pattern (see BLOCKS.md):
//   - plan-eval  -> { nodes, parallelGroups, categories, order } (node materialization)
//   - step-eval  -> { verdict: pass|retry|escalate, reason, guidance }
//   - stitch     -> { fixTasks: [{title, goal, ...}] }
// All parsers are total: they never throw. Invalid content comes back as
// { ok: false, errors } (plan-eval) or null / { errors } so the runner can
// fail gracefully, log the violations, and keep the run auditable.
import { NODE_TEMPLATES, NODE_CATEGORIES, EFFORT_LEVELS } from '../src/flowTypes.js';
// The lane-plan cap lives with the lane presets it bounds, so the parser and
// normalizeLane() can never drift apart on how long an emphasis may be.
import { MAX_EMPHASIS as MAX_LANE_EMPHASIS } from './nodes/fanout.js';

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const isStr = v => typeof v === 'string' && v.trim().length > 0;

/**
 * A fixed-vocabulary value, in the spelling the vocabulary uses.
 *
 * The contract is strict on purpose and stays strict: an unknown value is still
 * an error, and one error still rejects the whole document. What this fixes is
 * a trap of our own making — NODE_CATEGORIES reads
 * `Code general | Code design | documentation | Test-creation`, three of them
 * capitalized and one not, so a planner writing "Documentation" (the obvious
 * spelling beside "Code general") loses its ENTIRE plan. Seen live: a real run
 * emitted `"category": "Documentation"`, no nodes were materialized, the run
 * completed having done nothing, and the loop escalated the task to a bigger
 * model — which would spell it the same way.
 *
 * Case is not information here. A value that matches a term exactly except for
 * case IS that term, and returning the canonical spelling means everything
 * downstream (the category→model routing, the template pairing) keeps comparing
 * one spelling.
 */
export function canonical(value, vocabulary) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (vocabulary.includes(v)) return v;
  const lower = v.toLowerCase();
  return vocabulary.find(term => term.toLowerCase() === lower) ?? null;
}

// Pull the first parseable JSON value out of LLM output: a ```json fence,
// the whole text, or the outermost {...} slice — in that order.
export function extractJson(text) {
  const s = String(text ?? '');
  const candidates = [];
  const fence = s.match(/```json\s*([\s\S]*?)```/i) ?? s.match(/```\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  candidates.push(s);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));
  for (const c of candidates) {
    try { return JSON.parse(c.trim()); } catch {}
  }
  return null;
}

function validateContextSpec(cs, at, errors) {
  if (cs == null) return undefined;
  if (typeof cs !== 'object' || Array.isArray(cs) || !Array.isArray(cs.files)) {
    errors.push(`${at}.contextSpec: must be { "files": [{ "path", "description"? }] }`);
    return undefined;
  }
  const files = [];
  cs.files.forEach((f, i) => {
    if (!f || !isStr(f.path)) { errors.push(`${at}.contextSpec.files[${i}].path: required non-empty string`); return; }
    const entry = { path: f.path.trim() };
    if (isStr(f.description)) entry.description = f.description.trim();
    files.push(entry);
  });
  return { files };
}

// Validate an array of generated-node specs (the shared core of the plan-eval,
// triage, and feedback-review contracts). Pushes violations into `errors` and
// returns the normalized spec list.
function validateNodeSpecs(rawNodes, extraTemplateIds, errors) {
  const knownTemplates = [...new Set([...Object.keys(NODE_TEMPLATES), ...extraTemplateIds])];
  const isKnownTemplate = t => knownTemplates.includes(t);
  const seen = new Set();
  const nodes = [];
  for (const [i, n] of (Array.isArray(rawNodes) ? rawNodes : []).entries()) {
    const at = `nodes[${i}]`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) { errors.push(`${at}: must be an object`); continue; }
    if (!isStr(n.id) || !ID_RE.test(n.id.trim())) {
      errors.push(`${at}.id: required; letters, digits, "_", "-" only`);
    } else if (seen.has(n.id.trim())) {
      errors.push(`${at}.id: duplicate id "${n.id.trim()}"`);
    } else {
      seen.add(n.id.trim());
    }
    if (!isStr(n.template)) {
      errors.push(`${at}.template: required string`);
    } else if (!isKnownTemplate(n.template.trim())) {
      errors.push(`${at}.template: unknown "${n.template.trim()}" (known: ${knownTemplates.join(', ')})`);
    }
    const category = n.category != null ? canonical(n.category, NODE_CATEGORIES) : null;
    if (n.category != null && !category) {
      errors.push(`${at}.category: "${n.category}" is not one of: ${NODE_CATEGORIES.join(', ')}`);
    }
    const effort = n.effort != null ? canonical(n.effort, EFFORT_LEVELS) : null;
    // Category and template are documented 1:1 (BLOCKS.md): the category
    // picks the model, the template picks the tools and the base type. Pairing
    // them wrongly hands a node work its template isn't shaped for, and the
    // planner does it — a live run emitted { category: 'Code general', template:
    // 'code-design-step' } for "Implement and export tag filtering". Nothing
    // checked, so the mismatch sailed through. Only built-in templates carry a
    // known category; a user's own template is left to them.
    const tplCategory = NODE_TEMPLATES[isStr(n.template) ? n.template.trim() : '']?.category;
    if (category && tplCategory != null && category !== tplCategory) {
      errors.push(`${at}: category "${n.category}" does not match template "${n.template.trim()}"`
        + ` (whose category is "${tplCategory}") — they are 1:1; pick the template for the category`);
    }
    if (n.effort != null && !effort) {
      errors.push(`${at}.effort: "${n.effort}" is not one of: ${EFFORT_LEVELS.join(', ')}`);
    }
    if (n.taskRef != null && !isStr(n.taskRef)) errors.push(`${at}.taskRef: must be a non-empty string when present`);
    if (n.title != null && typeof n.title !== 'string') errors.push(`${at}.title: must be a string`);
    if (n.goal != null && typeof n.goal !== 'string') errors.push(`${at}.goal: must be a string`);
    let dependsOn;
    if (n.dependsOn != null) {
      if (!Array.isArray(n.dependsOn) || n.dependsOn.some(d => !isStr(d))) {
        errors.push(`${at}.dependsOn: must be an array of non-empty strings`);
      } else {
        dependsOn = n.dependsOn.map(d => d.trim());
      }
    }
    const contextSpec = validateContextSpec(n.contextSpec, at, errors);
    nodes.push({
      id: isStr(n.id) ? n.id.trim() : `invalid-${i}`,
      template: isStr(n.template) ? n.template.trim() : '',
      ...(isStr(n.taskRef) ? { taskRef: n.taskRef.trim() } : {}),
      // The canonical spelling, so everything downstream — the category→model
      // routing, the template pairing — compares one form of the word.
      ...(category ? { category } : {}),
      ...(effort ? { effort } : {}),
      ...(isStr(n.title) ? { title: n.title.trim() } : {}),
      ...(isStr(n.goal) ? { goal: n.goal.trim() } : {}),
      ...(dependsOn ? { dependsOn } : {}),
      ...(contextSpec ? { contextSpec } : {})
    });
  }
  return nodes;
}

// The strict plan-eval contract. Any violation rejects the WHOLE document
// (no partial materialization) so generated flows are always well-formed.
// extraTemplateIds extends the valid template names with the Node Library's
// (user-editable) catalog on top of the built-in one.
export function parsePlanEval(text, extraTemplateIds = []) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['no JSON object found in plan-eval output (expected a ```json block or raw JSON)'] };
  }
  const errors = [];
  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
    errors.push('nodes: required non-empty array of { id, template, ... }');
  }
  const nodes = validateNodeSpecs(obj.nodes, extraTemplateIds, errors);

  let parallelGroups;
  if (obj.parallelGroups != null) {
    if (!Array.isArray(obj.parallelGroups) ||
        obj.parallelGroups.some(g => !Array.isArray(g) || g.some(m => !isStr(m)))) {
      errors.push('parallelGroups: must be an array of arrays of non-empty strings');
    } else {
      parallelGroups = obj.parallelGroups.map(g => g.map(m => m.trim()));
    }
  }

  let categories;
  if (obj.categories != null) {
    if (typeof obj.categories !== 'object' || Array.isArray(obj.categories)) {
      errors.push('categories: must be an object mapping task refs to categories');
    } else {
      categories = {};
      for (const [k, v] of Object.entries(obj.categories)) {
        const term = canonical(v, NODE_CATEGORIES);
        if (!term) {
          errors.push(`categories["${k}"]: "${v}" is not one of: ${NODE_CATEGORIES.join(', ')}`);
        } else {
          categories[k] = term;
        }
      }
    }
  }

  let order;
  if (obj.order != null) {
    if (!Array.isArray(obj.order) || obj.order.some(m => !isStr(m))) {
      errors.push('order: must be an array of non-empty strings');
    } else {
      order = obj.order.map(m => m.trim());
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    plan: {
      nodes,
      ...(parallelGroups ? { parallelGroups } : {}),
      ...(categories ? { categories } : {}),
      ...(order ? { order } : {}),
      ...(isStr(obj.summary) ? { summary: obj.summary.trim() } : {})
    }
  };
}

// step-eval verdict: null when the output carries no structured verdict.
const VERDICTS = ['pass', 'retry', 'escalate'];
export function parseStepEvalVerdict(text) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object' || !isStr(obj.verdict)) return null;
  const verdict = obj.verdict.trim().toLowerCase();
  if (!VERDICTS.includes(verdict)) return null;
  return {
    verdict,
    reason: isStr(obj.reason) ? obj.reason.trim() : '',
    guidance: isStr(obj.guidance) ? obj.guidance.trim() : ''
  };
}

// stitch fix tasks: null when the output declares none. Invalid entries are
// dropped and reported so one malformed task can't block the valid ones.
export function parseStitchDirectives(text) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object' || !('fixTasks' in obj)) return null;
  if (!Array.isArray(obj.fixTasks)) return { fixTasks: [], errors: ['fixTasks: must be an array'] };
  const fixTasks = [];
  const errors = [];
  obj.fixTasks.forEach((t, i) => {
    if (!t || typeof t !== 'object' || !isStr(t.title) || !isStr(t.goal)) {
      errors.push(`fixTasks[${i}]: requires non-empty string "title" and "goal"`);
      return;
    }
    const ft = { title: t.title.trim(), goal: t.goal.trim() };
    if (Array.isArray(t.constraints) && t.constraints.every(c => typeof c === 'string')) ft.constraints = t.constraints;
    if (Array.isArray(t.dependsOn) && t.dependsOn.every(d => typeof d === 'string')) ft.dependsOn = t.dependsOn;
    if (t.worker && isStr(t.worker.provider) && isStr(t.worker.model)) {
      ft.worker = { provider: t.worker.provider.trim(), model: t.worker.model.trim() };
    }
    fixTasks.push(ft);
  });
  return { fixTasks, errors };
}

// Follow-up triage (DECISIONS.md D21): one strict-JSON classification of the
// user's feedback on a finished run. Total: never throws, invalid content comes
// back as { ok: false, errors } so the runner can degrade gracefully.
//
//   { "class": "question" | "fix" | "feature",
//     "reason": "<one line>",
//     "contextNodes": ["<done node id>", ...],       // optional
//     "answer": "<markdown>",                        // question-class: required
//     "nodes": [<plan-eval node specs>],             // fix-class: required
//     "goal": "<goal for the plan segment>" }        // feature-class: optional
const TRIAGE_CLASSES = ['question', 'fix', 'feature'];
export function parseTriage(text, extraTemplateIds = []) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['no JSON object found in triage output (expected a ```json block or raw JSON)'] };
  }
  const errors = [];
  const cls = isStr(obj.class) ? obj.class.trim().toLowerCase() : '';
  if (!TRIAGE_CLASSES.includes(cls)) {
    errors.push(`class: required, one of: ${TRIAGE_CLASSES.join(', ')}`);
  }
  let contextNodes = [];
  if (obj.contextNodes != null) {
    if (!Array.isArray(obj.contextNodes) || obj.contextNodes.some(c => !isStr(c))) {
      errors.push('contextNodes: must be an array of non-empty strings');
    } else {
      contextNodes = obj.contextNodes.map(c => c.trim());
    }
  }
  if (cls === 'question' && !isStr(obj.answer)) {
    errors.push('answer: required non-empty string for class "question"');
  }
  let nodes = [];
  if (cls === 'fix') {
    if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
      errors.push('nodes: required non-empty array of { id, template, ... } for class "fix"');
    }
    nodes = validateNodeSpecs(obj.nodes, extraTemplateIds, errors);
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    triage: {
      class: cls,
      reason: isStr(obj.reason) ? obj.reason.trim() : '',
      contextNodes,
      ...(cls === 'question' ? { answer: obj.answer.trim() } : {}),
      ...(cls === 'fix' ? { nodes } : {}),
      ...(cls === 'feature' && isStr(obj.goal) ? { goal: obj.goal.trim() } : {})
    }
  };
}

// prompt-refiner questions (DECISIONS.md D27). The refiner MAY end its brief
// with ONE ```json { "questions": [{ id, text, why }] } block — but only when
// an ambiguity would materially change the deliverable. Total: no block, an
// empty list, or malformed JSON all come back as null ("no questions —
// proceed"). Capped at 3; invalid entries are dropped, `text` accepts the
// synonym `question`.
export function parseRefineQuestions(text) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.questions)) return null;
  const questions = normalizeQuestions(obj.questions);
  return questions.length ? { questions } : null;
}

// The question shape, shared by every role that may park the run at the input
// gate (DECISIONS.md D38 — `orient` asks the same way `refine` does, and the cap
// is the same three, because every question costs the user a round-trip).
// `text` accepts the synonym `question`; invalid entries are dropped rather
// than failing the whole block.
export const MAX_QUESTIONS = 3;
// The interrogation node exists to ask, so its per-round cap is wider than the
// refiner's — but only a little. A round of ten questions is a form, and a form
// is what a person abandons; six is the most one reply can carry honestly.
export const MAX_INTERROGATION_QUESTIONS = 6;
export function normalizeQuestions(raw, max = MAX_QUESTIONS) {
  const out = [];
  for (const [i, q] of (Array.isArray(raw) ? raw : []).entries()) {
    if (out.length >= max) break;
    if (!q || typeof q !== 'object') continue;
    const qText = isStr(q.text) ? q.text.trim() : (isStr(q.question) ? q.question.trim() : '');
    if (!qText) continue;
    // `options` is the ask_human idea carried to the gate: a question whose
    // candidate answers are named is a click, not an essay, and the reply comes
    // back in the vocabulary the asker used.
    const options = (Array.isArray(q.options) ? q.options : [])
      .map(o => (isStr(o) ? o.trim() : '')).filter(Boolean).slice(0, 6);
    out.push({
      id: isStr(q.id) && ID_RE.test(q.id.trim()) ? q.id.trim() : `q${i + 1}`,
      text: qText,
      ...(isStr(q.why) ? { why: q.why.trim() } : {}),
      ...(options.length ? { options } : {})
    });
  }
  return out;
}

// --- The interrogation contract ---------------------------------------------
//
// The inverse of the refiner. `refine` is told to resolve ambiguity itself and
// ask only when it must; `interrogate` is told the opposite — the questions ARE
// the deliverable's route, and it runs several bounded rounds against a person
// before it writes the spec. So it needs a status the refiner does not have:
// "still asking" vs "settled", because the node cannot be released on the
// absence of a questions array alone (a model that simply forgot the fence
// would otherwise read as a finished specification).
export function parseInterrogation(text) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['no ```json block with { "status", "questions" } found'] };
  }
  const status = isStr(obj.status) && ['asking', 'settled'].includes(obj.status.trim())
    ? obj.status.trim() : null;
  if (!status) {
    return { ok: false, errors: ['"status" must be "asking" or "settled"'] };
  }
  const questions = normalizeQuestions(obj.questions, MAX_INTERROGATION_QUESTIONS);
  if (status === 'asking' && !questions.length) {
    return { ok: false, errors: ['"status": "asking" with no usable question — say "settled" instead'] };
  }
  const list = key => (Array.isArray(obj[key]) ? obj[key] : [])
    .map(v => (isStr(v) ? v.trim() : '')).filter(Boolean);
  return {
    ok: true,
    interrogation: {
      status,
      confidence: isStr(obj.confidence) && ['low', 'medium', 'high'].includes(obj.confidence.trim())
        ? obj.confidence.trim() : 'low',
      questions: status === 'asking' ? questions : [],
      assumptions: list('assumptions'),
      unknowns: list('unknowns')
    }
  };
}

// Prose without its trailing contract block — the `orient` twin of
// stripRefineQuestions (D38). The context file a person reads should not
// end in the JSON the machine reads.
export function stripJsonBlock(text) {
  return String(text ?? '').replace(/\n*```(?:json)?\s*\{[\s\S]*?```\s*$/i, '').trimEnd();
}

// The refined brief WITHOUT its trailing questions fence — what downstream
// nodes should consume as the run request. Only strips a final ```json ...```
// block (the refiner's questions), leaving the prose brief intact.
export function stripRefineQuestions(text) {
  return String(text ?? '').replace(/\n*```(?:json)?\s*\{[\s\S]*?"questions"[\s\S]*?```\s*$/i, '').trimEnd();
}

// The fan-out lane plan (DECISIONS.md D37): one strict-JSON roster, chosen from the
// FIXED preset enum. Total — never throws; invalid content comes back as
// { ok: false, errors } so runFanout can re-ask once and then fall back to the
// authored lanes (P3.7).
//
//   { "mission": "<one sentence completing 'your shared goal is to …'>",
//     "subject": "the repository | these three repositories | the codebase",
//     "focus":  ["what this reading is actually for"],
//     "ignore": ["what the person asking did not ask about"],
//     "lanes":  [{ preset, id, label, intent, emphasis?, reason? }] }
//
// The enum is the whole mitigation for letting a model shape the roster at all
// (D37): it SELECTS and DUPLICATES presets, it never writes what a lane is. A
// model that can pick lanes but not define them cannot turn an adversarial read
// into a flattering one — so an unknown preset is a hard rejection, never a
// coerced near-match.
const MAX_MISSION = 400;
export function parseLanePlan(text, { presetIds = [], minLanes = 2, maxLanes = 6 } = {}) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['no JSON object found in the lane plan (expected a ```json block or raw JSON)'] };
  }
  const errors = [];

  // A mission is what the preamble's "your shared goal is to …" completes, so
  // an empty one produces a lane briefed on nothing. Multi-sentence missions
  // are rejected rather than truncated: the second sentence is invariably the
  // planner starting to write lane instructions.
  const mission = isStr(obj.mission) ? obj.mission.trim() : '';
  if (!mission) errors.push('mission: required non-empty string');
  else if (mission.length > MAX_MISSION) errors.push(`mission: at most ${MAX_MISSION} characters (got ${mission.length})`);
  else if (/[.!?]\s+\S/.test(mission)) errors.push('mission: exactly one sentence');

  const subject = isStr(obj.subject) ? obj.subject.trim() : '';
  if (!subject) errors.push('subject: required non-empty string, e.g. "the repository"');

  // A brief with neither is the common case, so absent is empty, not an error.
  const strList = (v, at) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.some(x => !isStr(x))) { errors.push(`${at}: must be an array of non-empty strings`); return []; }
    return v.map(x => x.trim());
  };
  const focus = strList(obj.focus, 'focus');
  const ignore = strList(obj.ignore, 'ignore');

  const rawLanes = Array.isArray(obj.lanes) ? obj.lanes : null;
  if (!rawLanes) errors.push('lanes: required array of lane objects');
  const lanes = [];
  const seen = new Set();
  for (const [i, l] of (rawLanes ?? []).entries()) {
    const at = `lanes[${i}]`;
    if (!l || typeof l !== 'object' || Array.isArray(l)) { errors.push(`${at}: must be an object`); continue; }
    const preset = isStr(l.preset) ? l.preset.trim() : '';
    if (!presetIds.includes(preset)) {
      errors.push(`${at}.preset: required, one of: ${presetIds.join(', ')}`);
      continue;
    }
    const id = isStr(l.id) ? l.id.trim() : '';
    if (!id || !ID_RE.test(id)) { errors.push(`${at}.id: required; letters, digits, "_", "-" only`); continue; }
    if (seen.has(id)) { errors.push(`${at}.id: "${id}" is declared twice`); continue; }
    seen.add(id);
    const emphasis = isStr(l.emphasis) ? l.emphasis.trim() : '';
    if (emphasis.length > MAX_LANE_EMPHASIS) {
      errors.push(`${at}.emphasis: at most ${MAX_LANE_EMPHASIS} characters (got ${emphasis.length}) — one sentence narrowing this lane, not a rewrite of its preset`);
      continue;
    }
    lanes.push({
      preset, id,
      label: isStr(l.label) ? l.label.trim() : id,
      intent: isStr(l.intent) ? l.intent.trim() : '',
      ...(emphasis ? { emphasis } : {}),
      ...(isStr(l.reason) ? { reason: l.reason.trim() } : {})
    });
  }
  // Bounds are checked on what SURVIVED validation: a roster of six where four
  // named an invented preset is a roster of two, and saying "six declared" in
  // the re-ask would point the planner at the wrong problem.
  if (rawLanes && (lanes.length < minLanes || lanes.length > maxLanes)) {
    errors.push(`lanes: declared ${lanes.length} valid lane(s); this fan-out's budget is ${minLanes}-${maxLanes} (inclusive)`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], plan: { mission, subject, focus, ignore, lanes } };
}

// The orientation contract (DECISIONS.md D38): what the workspace we are
// standing in IS, and what relationship it has to the repository we are about
// to read. Prose first, then exactly one fenced JSON block.
//
// Total, and deliberately forgiving about everything except `relation`: the
// prose IS the deliverable (it becomes the context file), so a missing `focus`
// list costs the flow very little, while a missing or invented stance changes
// what every downstream node is for.
export const RELATIONS = ['empty', 'similar', 'adjacent', 'unrelated'];
const CONFIDENCES = ['high', 'medium', 'low'];
export function parseOrientation(text) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['no JSON object found in the orientation (expected a ```json block after the prose)'] };
  }
  const errors = [];
  const relation = isStr(obj.relation) ? obj.relation.trim().toLowerCase() : '';
  if (!RELATIONS.includes(relation)) {
    errors.push(`relation: required, one of: ${RELATIONS.join(', ')}`);
  }
  const mission = isStr(obj.mission) ? obj.mission.trim() : '';
  // `unrelated` is the one stance that legitimately has no mission: there is
  // nothing here to go and learn.
  if (!mission && relation !== 'unrelated') {
    errors.push('mission: required non-empty string completing "your shared goal is to …"');
  } else if (mission && /[.!?]\s+\S/.test(mission)) {
    errors.push('mission: exactly one sentence');
  }
  const strList = (v, at) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.some(x => !isStr(x))) { errors.push(`${at}: must be an array of non-empty strings`); return []; }
    return v.map(x => x.trim());
  };
  const focus = strList(obj.focus, 'focus');
  const ignore = strList(obj.ignore, 'ignore');
  const assumptions = strList(obj.assumptions, 'assumptions');
  // Questions reuse the refiner's shape and its cap, because they park the run
  // at the same gate (§4).
  const questions = normalizeQuestions(obj.questions);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    orientation: {
      relation,
      confidence: CONFIDENCES.includes(String(obj.confidence).trim?.().toLowerCase?.()) ? obj.confidence.trim().toLowerCase() : 'medium',
      mission,
      focus,
      ignore,
      assumptions,
      questions
    }
  };
}

// feedback-review verdict (DECISIONS.md D21): closes every follow-up turn.
// null when the output carries no structured verdict. `more-work` may declare
// additional node specs; invalid specs are dropped with their errors reported
// (the runner escalates when more-work arrives with nothing materializable).
const REVIEW_VERDICTS = ['solved', 'more-work'];
export function parseFeedbackReview(text, extraTemplateIds = []) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object' || !isStr(obj.verdict)) return null;
  const verdict = obj.verdict.trim().toLowerCase();
  if (!REVIEW_VERDICTS.includes(verdict)) return null;
  const errors = [];
  let nodes = [];
  if (verdict === 'more-work' && Array.isArray(obj.nodes) && obj.nodes.length) {
    nodes = validateNodeSpecs(obj.nodes, extraTemplateIds, errors);
    if (errors.length) nodes = [];
  }
  return {
    verdict,
    reason: isStr(obj.reason) ? obj.reason.trim() : '',
    nodes,
    errors
  };
}
