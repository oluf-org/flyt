// Tiny JSON Schema interpreter covering exactly the subset schema.json uses:
// type, const, enum, required, properties, additionalProperties (bool/schema),
// propertyNames, items, pattern, minLength, oneOf, $ref (#/$defs/... only).
//
// The plan called for ajv; the schema stays ajv-compatible (draft 2020-12) so
// swapping this file for `new Ajv().compile(schema)` later is trivial. Errors
// come back as { path, message } — enough for the linter to surface precisely.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

export function validate(schema, value, rootSchema = schema, path = '$', errors = []) {
  const err = message => { errors.push({ path, message }); return errors; };

  if (schema.$ref) {
    const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(schema.$ref);
    if (!m || !rootSchema.$defs?.[m[1]]) throw new Error(`unsupported $ref ${schema.$ref}`);
    return validate(rootSchema.$defs[m[1]], value, rootSchema, path, errors);
  }

  if ('const' in schema && value !== schema.const) return err(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) return err(`must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`);

  if (schema.oneOf) {
    const attempts = schema.oneOf.map(s => validate(s, value, rootSchema, path, []));
    const passing = attempts.filter(a => a.length === 0).length;
    if (passing !== 1) {
      // Surface the branch that got furthest (fewest errors) for a useful message.
      const best = attempts.slice().sort((a, b) => a.length - b.length)[0] ?? [];
      errors.push(...(passing === 0 ? best : [{ path, message: 'matches more than one allowed shape' }]));
    }
    return errors;
  }

  if (schema.type) {
    const t = typeOf(value);
    const want = [].concat(schema.type);
    if (!want.includes(t) && !(t === 'integer' && want.includes('number'))) {
      return err(`must be ${want.join(' or ')}, got ${t}`);
    }
  }

  if (typeOf(value) === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) err(`does not match ${schema.pattern}`);
    if (schema.minLength != null && value.length < schema.minLength) err(`must not be empty`);
  }

  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((item, i) => validate(schema.items, item, rootSchema, `${path}[${i}]`, errors));
  }

  if (typeOf(value) === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push({ path, message: `missing required field "${req}"` });
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub) { validate(sub, v, rootSchema, `${path}.${k}`, errors); continue; }
      if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${k}`, message: `unknown field "${k}"` });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(schema.additionalProperties, v, rootSchema, `${path}.${k}`, errors);
      }
      if (schema.propertyNames) validate(schema.propertyNames, k, rootSchema, `${path}.${k}`, errors);
    }
  }
  return errors;
}
