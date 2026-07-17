// Strict parsing + validation for the structured outputs of the reflective
// planning pattern (see FLOW_NODES.md):
//   - plan-eval  -> { nodes, parallelGroups, categories, order } (node materialization)
//   - step-eval  -> { verdict: pass|retry|escalate, reason, guidance }
//   - stitch     -> { fixTasks: [{title, goal, ...}] }
// All parsers are total: they never throw. Invalid content comes back as
// { ok: false, errors } (plan-eval) or null / { errors } so the runner can
// fail gracefully, log the violations, and keep the run auditable.
import { NODE_TEMPLATES, NODE_CATEGORIES } from '../src/flowTypes.js';

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const isStr = v => typeof v === 'string' && v.trim().length > 0;

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
  const knownTemplates = [...new Set([...Object.keys(NODE_TEMPLATES), ...extraTemplateIds])];
  const isKnownTemplate = t => knownTemplates.includes(t);

  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
    errors.push('nodes: required non-empty array of { id, template, ... }');
  }
  const seen = new Set();
  const nodes = [];
  for (const [i, n] of (Array.isArray(obj.nodes) ? obj.nodes : []).entries()) {
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
    if (n.category != null && !NODE_CATEGORIES.includes(n.category)) {
      errors.push(`${at}.category: "${n.category}" is not one of: ${NODE_CATEGORIES.join(', ')}`);
    }
    // Category and template are documented 1:1 (FLOW_NODES.md): the category
    // picks the model, the template picks the tools and the base type. Pairing
    // them wrongly hands a node work its template isn't shaped for, and the
    // planner does it — a live run emitted { category: 'Code general', template:
    // 'code-design-step' } for "Implement and export tag filtering". Nothing
    // checked, so the mismatch sailed through. Only built-in templates carry a
    // known category; a user's own template is left to them.
    const tplCategory = NODE_TEMPLATES[isStr(n.template) ? n.template.trim() : '']?.category;
    if (n.category != null && tplCategory != null && n.category !== tplCategory) {
      errors.push(`${at}: category "${n.category}" does not match template "${n.template.trim()}"`
        + ` (whose category is "${tplCategory}") — they are 1:1; pick the template for the category`);
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
      ...(n.category != null ? { category: n.category } : {}),
      ...(isStr(n.title) ? { title: n.title.trim() } : {}),
      ...(isStr(n.goal) ? { goal: n.goal.trim() } : {}),
      ...(dependsOn ? { dependsOn } : {}),
      ...(contextSpec ? { contextSpec } : {})
    });
  }

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
        if (!NODE_CATEGORIES.includes(v)) {
          errors.push(`categories["${k}"]: "${v}" is not one of: ${NODE_CATEGORIES.join(', ')}`);
        } else {
          categories[k] = v;
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
