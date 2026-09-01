// Kernel tool arguments are validated once, at the registry boundary. The
// schema belongs to the tool definition; neither a plugin nor a block gets a
// second execution path that can forget to enforce it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, flytTools, flytApprovals } from '#kernel';

const CLASSIFIED_WRITE = {
  effect: 'write', destructive: false, untrustedInput: false, source: 'confirmed',
};

const execution = (name, args) => ({
  runId: 'run-validation', blockId: 'work', step: 1,
  call: { id: 'call-validation', name, args },
  ceiling: [name],
});

async function kernelWith(tool, approval = {}) {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(flytApprovals, { mode: 'ask', ...approval });
  kernel.ctx.tools.register(tool);
  return kernel;
}

test('kernel returns every argument error in one result before approval or execution', async () => {
  let ran = 0;
  let asked = 0;
  const kernel = await kernelWith({
    name: 'write_record',
    description: 'Write one record.',
    classification: CLASSIFIED_WRITE,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'mode'],
      properties: {
        path: { type: 'string', minLength: 3 },
        mode: { enum: ['append', 'replace'] },
        count: { type: 'integer', minimum: 1 },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    async execute() { ran += 1; return { content: 'written' }; },
  }, { ask: async () => { asked += 1; return true; } });

  try {
    const result = await kernel.ctx.tools.execute(execution('write_record', {
      path: 'x', count: 0, tags: ['ok', 3], extra: true,
    }));

    assert.match(result.error, /5 argument errors/);
    assert.match(result.content, /args\.mode: must have required property 'mode'/);
    assert.match(result.content, /args\.extra: must NOT have additional properties/);
    assert.match(result.content, /args\.path: must NOT have fewer than 3 characters/);
    assert.match(result.content, /args\.count: must be >= 1/);
    assert.match(result.content, /args\.tags\[1\]: must be string/);
    assert.equal(result.content.match(/^Invalid arguments/gm)?.length, 1,
      'one call produces one aggregate model-visible result');
    assert.equal(asked, 0, 'invalid arguments do not trigger a human approval prompt');
    assert.equal(ran, 0, 'the tool body never sees invalid arguments');
  } finally { await kernel.dispose(); }
});

test('a valid call crosses the same validator and then reaches the gate and body', async () => {
  let ranWith;
  const kernel = await kernelWith({
    name: 'write_record', description: 'Write one record.', classification: CLASSIFIED_WRITE,
    parameters: {
      type: 'object', additionalProperties: false, required: ['record'],
      properties: { record: { $ref: '#/$defs/record' } },
      $defs: {
        record: {
          type: 'object', additionalProperties: false, required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async execute(args) { ranWith = args; return { content: 'written' }; },
  }, { ask: async () => true });

  try {
    const args = { record: { id: 7 } };
    const result = await kernel.ctx.tools.execute(execution('write_record', args));
    assert.equal(result.error, undefined);
    assert.equal(result.content, 'written');
    assert.deepEqual(ranWith, args);
  } finally { await kernel.dispose(); }
});

test('malformed JSON and scalar arguments are refused even by a permissive schema', async () => {
  let ran = 0;
  const kernel = await kernelWith({
    name: 'permissive', description: 'Still takes a function argument mapping.',
    classification: CLASSIFIED_WRITE, parameters: {},
    async execute() { ran += 1; return { content: 'ran' }; },
  });

  try {
    const malformed = await kernel.ctx.tools.execute(execution('permissive', { _unparsed: '{oh no' }));
    assert.match(malformed.content, /arguments were not valid JSON/);

    const scalar = await kernel.ctx.tools.execute(execution('permissive', 42));
    assert.match(scalar.content, /expected object, got number/);
    assert.equal(ran, 0);
  } finally { await kernel.dispose(); }
});

test('a tool with an unenforceable schema is rejected at registration', async () => {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytTools);
  try {
    assert.throws(() => kernel.ctx.tools.register({
      name: 'remote_schema', description: '',
      parameters: { type: 'object', properties: { value: { $ref: 'https://example.invalid/schema' } } },
      classification: CLASSIFIED_WRITE,
      async execute() { return { content: 'must not register' }; },
    }), /invalid parameters schema.*can't resolve reference/i);
    assert.equal(kernel.ctx.tools.get('remote_schema'), undefined);
  } finally { await kernel.dispose(); }
});
