// validateArgs: the JSON Schema 2020-12 subset tool arguments are checked
// against (DESIGN-SPEC.md §5). Table-driven, because the point of hand-rolling a
// validator (D24) is that its behavior is pinned rather than assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs, schemaProblems, MAX_SCHEMA_DEPTH } from '../core/tools/schema.js';

const ok = (schema, value) => assert.deepEqual(validateArgs(schema, value), [], `expected valid: ${JSON.stringify(value)}`);
const bad = (schema, value, match) => {
  const errors = validateArgs(schema, value);
  assert.ok(errors.length, `expected invalid: ${JSON.stringify(value)}`);
  if (match) assert.match(errors.join('; '), match);
};

test('the pre-existing subset still behaves exactly as it did', () => {
  const schema = {
    type: 'object', required: ['path'], additionalProperties: false,
    properties: {
      path: { type: 'string' },
      mode: { enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' } }
    }
  };
  ok(schema, { path: 'x', mode: 'a', tags: ['t'] });
  bad(schema, {}, /path: required property missing/);
  bad(schema, { path: 1 }, /expected string, got number/);
  bad(schema, { path: 'x', mode: 'c' }, /must be one of/);
  bad(schema, { path: 'x', extra: 1 }, /unknown property/);
  bad(schema, { path: 'x', tags: [1] }, /tags\[0\]/);
});

test('type arrays (the nullable idiom) and integer', () => {
  ok({ type: ['string', 'null'] }, null);
  ok({ type: ['string', 'null'] }, 'x');
  bad({ type: ['string', 'null'] }, 3, /expected string or null/);
  ok({ type: 'integer' }, 4);
  bad({ type: 'integer' }, 4.5);
  ok({ type: 'number' }, 4.5);
});

test('const, numeric bounds and string bounds', () => {
  ok({ const: 'go' }, 'go');
  bad({ const: 'go' }, 'stop', /must be "go"/);
  bad({ type: 'number', minimum: 1, maximum: 10 }, 0, />= 1/);
  bad({ type: 'number', minimum: 1, maximum: 10 }, 11, /<= 10/);
  bad({ type: 'number', exclusiveMinimum: 0 }, 0, /> 0/);
  bad({ type: 'number', multipleOf: 5 }, 7, /multiple of 5/);
  bad({ type: 'string', minLength: 2 }, 'a', /at least 2/);
  bad({ type: 'string', maxLength: 2 }, 'abc', /at most 2/);
  ok({ type: 'string', pattern: '^[a-z]+$' }, 'abc');
  bad({ type: 'string', pattern: '^[a-z]+$' }, 'ABC', /must match/);
});

test('array bounds and uniqueness', () => {
  bad({ type: 'array', minItems: 1 }, [], /at least 1/);
  bad({ type: 'array', maxItems: 1 }, [1, 2], /at most 1/);
  bad({ type: 'array', uniqueItems: true }, [1, 1], /unique/);
  ok({ type: 'array', uniqueItems: true }, [1, 2]);
});

test('composition: allOf / anyOf / oneOf / not', () => {
  ok({ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'ab');
  bad({ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'a', /at least 2/);
  ok({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 5);
  bad({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true, /any of the 2/);
  ok({ oneOf: [{ type: 'string' }, { type: 'number' }] }, 'x');
  bad({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 4, /matches 2 shapes/);
  bad({ not: { type: 'string' } }, 'x', /explicitly excluded/);
});

test('local $ref into $defs resolves; an external one is refused, never fetched', () => {
  const schema = {
    type: 'object',
    properties: { who: { $ref: '#/$defs/person' } },
    $defs: { person: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } }
  };
  ok(schema, { who: { name: 'ada' } });
  bad(schema, { who: {} }, /who\.name: required property missing/);

  // The rule from the MCP 2026-07-28 spec: implementations MUST NOT
  // auto-dereference remote refs. A validator that fetched one would be an
  // SSRF primitive pointed at whatever an untrusted server put in its schema.
  const remote = { type: 'object', properties: { q: { $ref: 'https://evil.example/s.json' } } };
  bad(remote, { q: 1 }, /external \$ref/);
  assert.match(schemaProblems(remote).join('; '), /external \$ref/);
  assert.match(schemaProblems({ type: 'object', properties: { q: { $ref: '#/$defs/missing' } } }).join('; '), /does not resolve/);
});

test('schema depth is bounded rather than blowing the stack', () => {
  let schema = { type: 'string' };
  let value = 'deep';
  for (let i = 0; i < MAX_SCHEMA_DEPTH + 5; i++) {
    schema = { type: 'object', properties: { n: schema } };
    value = { n: value };
  }
  assert.match(validateArgs(schema, value).join('; '), /exceeds 32 levels/);
  assert.match(schemaProblems(schema).join('; '), /exceeds 32 levels/);
});

test('schemaProblems screens what a tool definition may carry', () => {
  assert.deepEqual(schemaProblems({ type: 'object', properties: { a: { type: 'string' } } }), []);
  assert.deepEqual(schemaProblems({ properties: {} }), [], 'a missing root type is treated as an object');
  assert.match(schemaProblems({ type: 'array' }).join(), /must be an object schema/);
  assert.match(schemaProblems(undefined).join(), /no parameters schema/);
  assert.match(schemaProblems('nope').join(), /must be a JSON Schema object/);
  // A recursive $defs is legal and must not hang the walk.
  assert.deepEqual(schemaProblems({
    type: 'object', properties: { node: { $ref: '#/$defs/node' } },
    $defs: { node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } } }
  }), []);
});
