// Typed run inputs (DECISIONS.md D36).
//
// A flow could always take ONE free-text prompt. That is enough for "write me
// a thing" and useless for "read THIS repository, looking for THAT" — a link
// pasted into prose is just prose, and nothing downstream can act on it.
//
// Declared inputs become a NODE, wired with ordinary edges:
//
//   inputs:
//     repo: { type: repo, label: Repository, required: true }
//   flow:
//     - inputs.repo -> clone
//
// No templating syntax, no `{{ }}`, no hidden binding. `inputs.repo` is the
// `repo` output port of a node called `inputs`, which is exactly what that
// syntax already means everywhere else in the DSL — so edges, ports, context
// assembly and the canvas all work on it without knowing it is special.
//
// The implicit `input` node is untouched: a flow with no `inputs:` block is
// unchanged in every respect.

export const INPUTS_NODE_ID = 'inputs';

// What a declared input can be. Each is a control in the composer and a
// coercion at run start; `repo` is the only one with a side effect (it adopts
// the repository into the read-only reference library before the run walks).
export const INPUT_TYPES = ['text', 'url', 'repo', 'choice', 'file', 'model', 'modelSet'];

const isStr = v => typeof v === 'string' && v.trim().length > 0;

export class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; }
}

// One entry of the `inputs:` map -> a canonical spec. Throws on anything the
// author cannot have meant, because a run input that silently becomes text is
// worse than a flow that refuses to load.
export function normalizeInputSpec(name, raw) {
  const id = String(name ?? '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new InputError(`input "${name}": name must be letters, digits, _ or -`);
  const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { type: raw };
  const type = isStr(entry.type) ? entry.type.trim() : 'text';
  if (!INPUT_TYPES.includes(type)) {
    throw new InputError(`input "${id}": unknown type "${type}" (${INPUT_TYPES.join(', ')})`);
  }
  const spec = {
    name: id,
    type,
    label: isStr(entry.label) ? entry.label.trim() : id,
    required: entry.required === true,
    ...(isStr(entry.description) ? { description: entry.description.trim() } : {}),
    ...(entry.default !== undefined ? { default: entry.default } : {}),
    ...(isStr(entry.placeholder) ? { placeholder: entry.placeholder.trim() } : {})
  };
  if (type === 'choice') {
    const options = Array.isArray(entry.options) ? entry.options.filter(isStr).map(o => o.trim()) : [];
    if (!options.length) throw new InputError(`input "${id}": a choice input needs "options: [...]"`);
    spec.options = options;
    if (spec.default !== undefined && !options.includes(String(spec.default))) {
      throw new InputError(`input "${id}": default "${spec.default}" is not one of its options`);
    }
  }
  return spec;
}

export function normalizeInputs(raw) {
  if (raw == null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('"inputs" must be a map of input name -> definition');
  }
  return Object.entries(raw).map(([name, entry]) => normalizeInputSpec(name, entry));
}

// The node a declared inputs block becomes. Its ports ARE the inputs, so
// `inputs.repo -> x` resolves through the ordinary port machinery — hence
// `data.outputs`, which nodePorts() already honours ahead of everything else.
export function inputsNode(specs) {
  return {
    id: INPUTS_NODE_ID,
    type: 'inputs',
    kind: 'user',
    data: {
      declared: specs,
      outputs: specs.map(s => ({
        id: s.name,
        label: s.label,
        description: s.description ?? `The ${s.type} this run was given for "${s.label}".`
      }))
    }
  };
}

// --- values -----------------------------------------------------------------

// Coerce and check what the composer (or the CLI, or a test) supplied.
// Returns { values, errors } — never throws, so every problem is reported at
// once rather than one refused start at a time.
export function validateInputValues(specs, supplied = {}) {
  const values = {};
  const errors = [];
  for (const spec of specs ?? []) {
    const raw = supplied?.[spec.name];
    const given = raw === undefined || raw === null || raw === '' ? undefined : raw;
    const value = given ?? (spec.default !== undefined ? spec.default : undefined);
    if (value === undefined) {
      if (spec.required) errors.push(`"${spec.label}" is required.`);
      continue;
    }
    switch (spec.type) {
      case 'choice':
        if (!spec.options.includes(String(value))) {
          errors.push(`"${spec.label}": "${value}" is not one of ${spec.options.join(', ')}.`);
          continue;
        }
        values[spec.name] = String(value);
        break;
      case 'model':
        // Either shape the rest of the app uses for a worker.
        values[spec.name] = typeof value === 'string' ? value : (value?.model ?? '');
        if (!values[spec.name]) errors.push(`"${spec.label}": no model chosen.`);
        break;
      case 'url':
      case 'repo':
      case 'file':
      case 'modelSet':
      case 'text':
      default:
        values[spec.name] = String(value).trim();
        if (!values[spec.name] && spec.required) errors.push(`"${spec.label}" is required.`);
        break;
    }
  }
  // A value for something the flow does not declare is a mistake worth naming:
  // silently dropping it means the run quietly ignores what you typed.
  for (const key of Object.keys(supplied ?? {})) {
    if (!(specs ?? []).some(s => s.name === key)) errors.push(`"${key}" is not an input of this flow.`);
  }
  return { values, errors };
}

// What gets written to nodes/inputs.<name>.md — the artifact every downstream
// node reads through the ordinary port edge. A repo input carries the adopted
// reference rather than the URL, because the reference name is the thing a
// node can act on.
export function renderInputValue(spec, value, { reference = null } = {}) {
  if (spec.type === 'repo' && reference) {
    return [
      `# ${spec.label}`,
      '',
      `Repository: ${reference.url}`,
      `Reference: \`reference:${reference.name}\`${reference.commit ? ` (pinned at ${String(reference.commit).slice(0, 8)})` : ''}`,
      '',
      'It is cloned read-only. Search it with `search_references`, and read a file',
      `with \`read_file\` on \`reference:${reference.name}/<path>\`.`
    ].join('\n');
  }
  return String(value);
}
