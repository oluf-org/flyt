// The compat promise, as a test rather than an intention (D54).
//
// A plugin published for deepseek-harness runs in Flyt unmodified, if it
// touches only the standard seams and events. Nothing here is a fixture: the
// plugin under test is installed from npm at an exact pinned version, and the
// only thing between it and our kernel is the service it registers into.
//
// When this goes red, the promise has decayed. That is the alarm it exists to
// be — do not soften it into a skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createKernel, flytSkills, flytTools, flytApprovals, mount, builtinImporter } from '#kernel';

const require = createRequire(import.meta.url);

/** The pinned plugins this suite holds us to. Exact versions; upgrading one is a commit. */
const PINNED = ['@deepseek-ai/dsh-skill-badge', '@deepseek-ai/dsh-skill'];

test('the pinned dsh plugins are installed at the versions we pinned', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of PINNED) {
    const pin = manifest.devDependencies?.[name];
    assert.ok(pin, `${name} must be a devDependency, or CI is not testing what we promise`);
    assert.match(pin, /^\d/, `${name} is pinned to "${pin}" — the compat suite needs an exact version, not a range`);
    const installed = require(`${name}/package.json`).version;
    assert.equal(installed, pin, `${name} is installed at ${installed} but pinned at ${pin}`);
  }
});

test('a real published dsh plugin loads, registers and executes', async () => {
  // Imported exactly as dsh's own loader would import it. No shim, no fork.
  const badge = await import('@deepseek-ai/dsh-skill-badge');
  assert.equal(badge.name, 'skill-badge');
  assert.deepEqual(badge.inject, ['skills'], 'it declares the service it needs');

  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(flytSkills);
    await kernel.ctx.plugin(badge);

    // Registered: its provider is in our registry and its skill is in the catalog.
    const listed = await kernel.ctx.skills.list();
    const entry = listed.find(s => s.name === 'dsh-badge');
    assert.ok(entry, `dsh-badge is not in the catalog: ${JSON.stringify(listed)}`);
    assert.equal(entry.provider, 'dsh-badge');
    assert.equal(entry.source, 'bundled');
    assert.equal(entry.invocation.modelInvocable, true);

    // Executed: its body loads, from the package's own assets, through the
    // resource base it declared.
    const definition = await kernel.ctx.skills.get('dsh-badge');
    assert.ok(definition?.content?.length > 0, 'the skill body loaded');
    assert.equal(definition.resourceBase.kind, 'directory');
    assert.ok(fs.existsSync(definition.resourceBase.path), 'and the resources it points at are there');
  } finally { await kernel.dispose(); }
});

test('a plugin withdraws cleanly, taking its contribution with it', async () => {
  const badge = await import('@deepseek-ai/dsh-skill-badge');
  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(flytSkills);
    const fiber = await kernel.ctx.plugin(badge);
    assert.equal((await kernel.ctx.skills.list()).length, 1);

    await fiber.dispose();
    assert.deepEqual(await kernel.ctx.skills.list(), [], 'the catalog is empty again');
  } finally { await kernel.dispose(); }
});

test('a dsh plugin loads through our loader, not only through a direct import', async () => {
  const kernel = createKernel();
  try {
    const mounted = await mount(kernel.ctx, [
      { id: 'skills', name: 'flyt:skills' },
      { id: 'badge', name: '@deepseek-ai/dsh-skill-badge' },
    ], { import: name => (name === 'flyt:skills' ? Promise.resolve(flytSkills) : builtinImporter(name)) });

    assert.deepEqual(mounted, ['skills', 'badge']);
    assert.ok((await kernel.ctx.skills.list()).some(s => s.name === 'dsh-badge'));
  } finally { await kernel.dispose(); }
});

test('the policy band spans third-party tools too', async () => {
  // The compat promise never includes "and it may act". A tool arriving from a
  // package reaches execution through the same ceiling and gate ours does.
  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(flytTools);
    await kernel.ctx.plugin(flytApprovals, { mode: 'always' });

    // A plugin in the dsh shape: name, inject, apply.
    await kernel.ctx.plugin({
      name: 'a-published-toolset',
      inject: ['tools'],
      apply(ctx) {
        return ctx.tools.register({
          name: 'publish_release', description: 'from a package', parameters: {},
          async execute() { return { content: 'released' }; },
        });
      },
    });

    const result = await kernel.ctx.tools.execute({
      runId: 'r', blockId: 'b', step: 1,
      call: { id: 'c', name: 'publish_release', args: {} },
      ceiling: ['publish_release'],
    });
    assert.match(result.error, /unclassified/, 'a package cannot grant itself reach by shipping a tool');
  } finally { await kernel.dispose(); }
});

test('what compat does not promise is stated where it is measured', () => {
  // A plugin reaching into dsh package internals needs a shim, and that is the
  // stated limit. This asserts we are honest about which service definitions we
  // implement, so "it should have worked" has an answer.
  const implemented = ['skills', 'tools'];
  const dshServiceDefinitions = fs.existsSync(path.dirname(require.resolve('@deepseek-ai/dsh-skill/package.json')));
  assert.ok(dshServiceDefinitions);
  assert.deepEqual(implemented, ['skills', 'tools'],
    'when a seam gains a dsh-shaped service definition, add it here and add a pinned plugin that uses it');
});
