// JSON Schema validation for tool arguments — the subset of 2020-12 that tool
// definitions actually use (DESIGN-SPEC.md §5).
//
// Hand-rolled on purpose (D24): a validator is exactly the kind of thing the
// zero-dependency rule exists to keep in-house, and the subset needed is
// bounded and testable. Supported: type (incl. arrays and `integer`), enum,
// const, object (required/properties/additionalProperties), array
// (items/minItems/maxItems/uniqueItems), numeric and string bounds,
// composition (allOf/anyOf/oneOf/not), and LOCAL $ref into $defs.
//
// Two hard rules, both from the MCP 2026-07-28 spec and both fail-closed:
//   1. External $ref URIs are never dereferenced. A validator that fetches a
//      URL out of an untrusted server's schema is an SSRF primitive; refusing
//      is the only safe answer, so it is an error here and a load-time refusal
//      in schemaProblems().
//   2. Schema depth is bounded. A hostile (or merely generated) schema must
//      not be able to blow the stack of the process validating it.

export const MAX_SCHEMA_DEPTH = 32;

const typeOf = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

function matchesType(value, t) {
  if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (t === 'number') return typeof value === 'number';
  return typeOf(value) === t;
}

// A local pointer ("#", "#/$defs/Thing") resolved against the schema root.
// Anything else — an http(s) URI, a bare file name, another document's
// fragment — is refused rather than fetched.
function resolveRef(ref, root, at) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) {
    throw new Error(`${at}: external $ref "${ref}" is not resolved — only local #/$defs references are allowed`);
  }
  let node = root;
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    node = node?.[key];
    if (node === undefined) throw new Error(`${at}: $ref "${ref}" does not resolve`);
  }
  return node;
}

// Returns a list of human-readable error strings; empty means valid. `opts`
// carries the recursion state (schema root for $ref, current depth) and is
// internal — callers pass (schema, value) and optionally a label.
export function validateArgs(schema, value, at = 'args', opts = {}) {
  const root = opts.root ?? schema;
  const depth = opts.depth ?? 0;
  const sub = (s, v, label) => validateArgs(s, v, label, { root, depth: depth + 1 });

  if (depth > MAX_SCHEMA_DEPTH) return [`${at}: schema nesting exceeds ${MAX_SCHEMA_DEPTH} levels`];
  if (schema === true || schema == null) return [];
  if (schema === false) return [`${at}: no value is allowed here`];
  if (typeof schema !== 'object') return [`${at}: invalid schema`];

  const errors = [];

  if (schema.$ref !== undefined) {
    let target;
    try { target = resolveRef(schema.$ref, root, at); }
    catch (err) { return [String(err.message)]; }
    errors.push(...sub(target, value, at));
    // 2020-12 allows keywords beside $ref, so fall through to the rest.
  }

  // `type` may be a string or an array (which is how a nullable field is
  // written). A type mismatch returns alone: every other keyword would just
  // restate it.
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchesType(value, t))) {
      return [...errors, `${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
    }
  }

  if (schema.enum && !schema.enum.some(e => deepEqual(e, value))) {
    errors.push(`${at}: must be one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')}`);
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push(`${at}: must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) errors.push(`${at}: must be < ${schema.exclusiveMaximum}`);
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0 && !isMultiple(value, schema.multipleOf)) {
      errors.push(`${at}: must be a multiple of ${schema.multipleOf}`);
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${at}: must be at least ${schema.minLength} characters`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${at}: must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string') {
      let re = null;
      try { re = new RegExp(schema.pattern, 'u'); } catch { try { re = new RegExp(schema.pattern); } catch { re = null; } }
      if (re && !re.test(value)) errors.push(`${at}: must match ${schema.pattern}`);
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: required property missing`);
    }
    for (const [key, v] of Object.entries(value)) {
      const propSchema = schema.properties?.[key];
      if (propSchema !== undefined) { errors.push(...sub(propSchema, v, `${at}.${key}`)); continue; }
      if (schema.additionalProperties === false) errors.push(`${at}.${key}: unknown property`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...sub(schema.additionalProperties, v, `${at}.${key}`));
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.items) value.forEach((v, i) => errors.push(...sub(schema.items, v, `${at}[${i}]`)));
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${at}: must have at least ${schema.minItems} items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${at}: must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems === true && new Set(value.map(v => JSON.stringify(v))).size !== value.length) {
      errors.push(`${at}: items must be unique`);
    }
  }

  // --- composition ---
  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach(s => errors.push(...sub(s, value, at)));
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(s => sub(s, value, at).length === 0)) {
    errors.push(`${at}: does not match any of the ${schema.anyOf.length} allowed shapes`);
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter(s => sub(s, value, at).length === 0).length;
    if (passing !== 1) {
      errors.push(passing === 0
        ? `${at}: does not match any of the ${schema.oneOf.length} allowed shapes`
        : `${at}: matches ${passing} shapes but must match exactly one`);
    }
  }
  if (schema.not !== undefined && sub(schema.not, value, at).length === 0) {
    errors.push(`${at}: matches an explicitly excluded shape`);
  }

  return errors;
}

function isMultiple(value, step) {
  const q = value / step;
  return Math.abs(q - Math.round(q)) < 1e-9;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
}

// Load-time screen for a tool's `parameters` schema. Returns human-readable
// problems; a non-empty list means the tool is stored DISABLED with the reason
// shown rather than silently accepted (DESIGN-SPEC.md §5) — a schema we can't
// validate against is a schema we can't gate on.
export function schemaProblems(schema, { requireObjectRoot = true } = {}) {
  const problems = [];
  if (schema === undefined || schema === null) return ['no parameters schema'];
  if (typeof schema !== 'object' || Array.isArray(schema)) return ['parameters must be a JSON Schema object'];
  if (requireObjectRoot && schema.type !== undefined && schema.type !== 'object') {
    problems.push(`parameters must be an object schema (got type "${schema.type}")`);
  }
  walk(schema, schema, 0, problems, new Set());
  return problems;
}

function walk(node, root, depth, problems, seen) {
  if (!node || typeof node !== 'object') return;
  if (depth > MAX_SCHEMA_DEPTH) {
    problems.push(`schema nesting exceeds ${MAX_SCHEMA_DEPTH} levels`);
    return;
  }
  if (seen.has(node)) return; // a $defs cycle is legal; walking it twice is not
  seen.add(node);
  if (node.$ref !== undefined) {
    if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#')) {
      problems.push(`external $ref "${node.$ref}" — remote schemas are never fetched`);
    } else {
      try { walk(resolveRef(node.$ref, root, 'parameters'), root, depth + 1, problems, seen); }
      catch (err) { problems.push(String(err.message).replace(/^parameters: /, '')); }
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === '$ref') continue;
    if (Array.isArray(child)) child.forEach(c => walk(c, root, depth + 1, problems, seen));
    else if (child && typeof child === 'object') walk(child, root, depth + 1, problems, seen);
  }
}
