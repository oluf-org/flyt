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
import { fileURLToPath } from 'node:url';
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

// Every service this kernel declares on `ctx`, and what tests it against a
// real dsh plugin. The rule D54 needs, in the only form that survives contact
// with a future seam: a service with no entry here fails the suite naming
// itself, so the task that adds a provider is the task that answers for it.
//
// `null` is a real answer, and the honest one for a service whose shape is
// ours rather than dsh's — that is the "stated limit" the promise carries, not
// a gap to be quietly tolerated.
const COVERAGE = {
  // Registered into by a real published dsh plugin, exercised below.
  skills: '@deepseek-ai/dsh-skill-badge',

  // Ours. dsh has a `ctx.tools` too, and its ToolRegistry is a much larger
  // contract (schemastery arguments, canonical output schemas, code-mode
  // dispatch). A dsh TOOL plugin needs a shim; that is the stated limit.
  tools: null,

  // Ours, and not a seam at all. `SEAM_NAMES` is the eight-name dsh capability
  // contract; a block is Flyt's own noun and dsh has no equivalent to be
  // compatible with. Nothing to pin, and nothing missing.
  blocks: null,

  // Ours, provided, and with no dsh counterpart to pin. dsh replaces the agent
  // LOOP; this seam schedules a Flyt STACK, over containment dsh has no notion
  // of. A dsh plugin cannot be written against it, so there is nothing to
  // install here and saying so is the honest answer rather than a gap.
  agents: null,

  // Ours, provided, and a bridge rather than a contract: it wraps the JS
  // core's adapters, which speak the OpenAI shape every provider here speaks.
  // A dsh plugin providing a model would provide it through dsh's own LLM
  // service, which is a larger contract; that is the stated limit.
  llm: null,

  // Declared, not yet provided. Each becomes a pinned plugin when it gains a
  // provider — which is what makes that task fail here until it does.
  sessions: null,
  fs: null,
  shell: null,
  commands: null,
  sandbox: null,
};

test('every service the kernel declares is answered for', () => {
  // Read from the source rather than a list somebody remembers to update: the
  // declaration IS the contract, so a seam that gains one is found here.
  const declared = new Set();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const [, body] of text.matchAll(/declare module '@deepseek-ai\/cordis'\s*\{([\s\S]*?)\n\}/g)) {
        for (const [, name] of body.matchAll(/^\s{4}(\w+):/gm)) declared.add(name);
      }
    }
  };
  walk(fileURLToPath(new URL('../kernel/src', import.meta.url)));

  const unanswered = [...declared].filter(name => !(name in COVERAGE)).sort();
  assert.deepEqual(unanswered, [],
    'a service on ctx with no COVERAGE entry: pin a real dsh plugin that uses it, or record why none exists');

  const gone = Object.keys(COVERAGE).filter(name => !declared.has(name));
  assert.deepEqual(gone, [], 'COVERAGE names a service the kernel no longer declares');
});

test('every service claimed to be covered is covered by something pinned', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const [service, plugin] of Object.entries(COVERAGE)) {
    if (!plugin) continue;
    assert.ok(manifest.devDependencies?.[plugin],
      `${service} claims ${plugin} covers it, and it is not installed`);
    assert.ok(PINNED.includes(plugin),
      `${service} claims ${plugin} covers it, and it is not in the pinned set this suite checks`);
  }
});

