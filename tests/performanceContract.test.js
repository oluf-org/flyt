import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { compileContract, createKernel, flytApi, registerStackCommands, parseStack } from '#kernel';

test('Build registration does not compile unconstrained schemas', async () => {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytApi);
  const compile = Ajv2020.prototype.compile;
  let calls = 0;
  Ajv2020.prototype.compile = function (...args) { calls++; return compile.apply(this, args); };
  try {
    let root = parseStack('version: 2\nid: perf\nblocks:\n  - id: work\n    use: work\n').root;
    const dispose = registerStackCommands(kernel.ctx, { get: () => root, set: next => { root = next; } });
    assert(kernel.ctx.commands.list().length > 5);
    assert.equal(calls, 0, 'empty contracts must not initialize Ajv for every command');
    await assert.rejects(kernel.ctx.commands.invoke('stack:unwrap-container', {}), /nodeId/);
    dispose();
    assert.equal(kernel.ctx.commands.list().length, 0);
  } finally { Ajv2020.prototype.compile = compile; await kernel.dispose(); }
});

test('unconstrained contracts accept all JSON values; constraints and errors still validate eagerly', () => {
  const compile = schema => compileContract({ check: { description: '', request: schema, response: {}, error: true } }).check;
  for (const schema of [{}, true]) {
    const check = compile(schema);
    for (const value of [null, false, 0, '', [], { value: 1 }]) {
      assert.deepEqual(check.request(value), []);
      assert.deepEqual(check.response(value), []);
      assert.deepEqual(check.error(value), []);
    }
  }
  assert(compile(false).request(null).length);
  assert(compile({ type: 'string' }).request(1).length);
  assert.throws(() => compile({ type: 'invalid' }), /Invalid check request schema/);
  assert.throws(() => compile([]), /Invalid check request schema/);
  assert.throws(() => compile(null), /Invalid check request schema/);
  const id = 'https://flyt.test/isolated';
  const a = compile({ $id: id, type: 'string' });
  const b = compile({ $id: id, type: 'number' });
  assert.deepEqual(a.request('yes'), []);
  assert(a.request(1).length);
  assert.deepEqual(b.request(1), []);
  assert.throws(() => compile({ $ref: id }), /Invalid check request schema/);
  const strict = compileContract({ strict: { description: '', request: {}, response: { type: 'number' }, error: false } }).strict;
  assert(strict.response('bad').length);
  assert(strict.error(null).length);
});
