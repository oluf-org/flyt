// Four layers, one tree (D53). What is under test is the resolution order and
// the invariant that a narrower surface never gains a row a broader one lacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseYaml, YamlError, compose, explain, readComposition, discoverContributions,
  loadComposition, mount, createKernel, PROFILES, assertNarrower, builtinImporter,
} from '#kernel';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-loader-'));
const write = (dir, rel, text) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
};

// --- the composition file --------------------------------------------------

test('a composition file parses into rows', () => {
  const parsed = parseYaml(`
# the bundled rows
- id: sessions
  name: '@flyt/session-jsonl'
  config:
    root: ./runs
    announce: true

- id: shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@flyt/terminal'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a shell
          * state is persistent
`);
  assert.deepEqual(parsed, [
    { id: 'sessions', name: '@flyt/session-jsonl', config: { root: './runs', announce: true } },
    {
      id: 'shell', name: 'cordis:group', group: true, isolate: { terminals: true },
      config: [{
        id: 'pty', name: '@flyt/terminal',
        config: { timeoutMs: 300000, description: 'Run commands in a shell\n* state is persistent' },
      }],
    },
  ]);
});

test('what the subset refuses, it refuses by name and line', () => {
  assert.throws(() => parseYaml('a: !!js process.env.HOME'), err => {
    assert.ok(err instanceof YamlError);
    assert.match(err.message, /"!!js" tags are not evaluated by this loader \(line 1\)/);
    return true;
  });
  assert.throws(() => parseYaml('a: &anchor 1'), /anchors and aliases/);
  assert.throws(() => parseYaml('a: [1, 2]'), /flow style is not supported/);
  assert.throws(() => parseYaml('a:\n\t- 1'), /tabs cannot be used/);
});

test('a comment after a value is a comment, and one inside a quote is not', () => {
  assert.deepEqual(parseYaml('a: 1 # how many\nb: "a # b"'), { a: 1, b: 'a # b' });
});

// --- layering --------------------------------------------------------------

const bundle = { source: 'bundle:@flyt/core', entries: [
  { id: 'sessions', name: '@flyt/session-jsonl', config: { root: './runs', announce: true } },
  { id: 'tools', name: '@flyt/tools' },
  { id: 'approvals', name: '@flyt/approvals', config: { mode: 'ask' } },
] };

test('a later layer replaces a row by id', () => {
  const entries = compose([
    bundle,
    { source: 'profile:flyt-loop-worker', entries: [{ id: 'approvals', name: '@flyt/approvals', config: { mode: 'always' } }] },
  ]);
  assert.deepEqual(entries.map(e => e.id), ['sessions', 'tools', 'approvals']);
  assert.deepEqual(entries.find(e => e.id === 'approvals').config, { mode: 'always' });
});

test('the four layers apply in order, and the last one wins', () => {
  const entries = compose([
    bundle,
    { source: 'profile:flyt-cli', entries: [{ id: 'approvals', name: '@flyt/approvals', config: { mode: 'smart' } }] },
    { source: 'home', entries: [{ id: 'approvals', name: '@flyt/approvals', config: { mode: 'always' } }] },
    { source: 'cli', entries: [{ id: 'approvals', name: '@flyt/approvals', config: { mode: 'ask' } }] },
  ]);
  const approvals = entries.find(e => e.id === 'approvals');
  assert.equal(approvals.config.mode, 'ask');
  assert.deepEqual(approvals.touchedBy, ['bundle:@flyt/core', 'profile:flyt-cli', 'home', 'cli']);
});

test('a patch changes one setting without restating the row', () => {
  const entries = compose([
    bundle,
    { source: 'home', entries: [{ id: 'sessions', name: '@flyt/session-jsonl', config: { announce: false } }] },
  ]);
  assert.deepEqual(entries.find(e => e.id === 'sessions').config, { root: './runs', announce: false });
});

test('a list in a patch replaces, because appending silently builds a tree nobody wrote', () => {
  const entries = compose([
    { source: 'bundle:x', entries: [{ id: 'a', name: 'a', config: { only: ['read_file', 'write_file'] } }] },
    { source: 'cli', entries: [{ id: 'a', name: 'a', config: { only: ['read_file'] } }] },
  ]);
  assert.deepEqual(entries[0].config.only, ['read_file']);
});

test('a patch can switch a row off, and the explanation still names it', () => {
  const layers = [
    bundle,
    { source: 'profile:flyt-loop-worker', entries: [{ id: 'approvals', name: '@flyt/approvals', disabled: true }] },
  ];
  assert.deepEqual(compose(layers).map(e => e.id), ['sessions', 'tools']);
  const lines = explain(layers);
  assert.match(lines.join('\n'), /- approvals .*from bundle:@flyt\/core -> profile:flyt-loop-worker/);
});

test('a group is patched child by child', () => {
  const entries = compose([
    { source: 'bundle:x', entries: [{
      id: 'shell', name: 'cordis:group', group: true,
      config: [{ id: 'pty', name: '@flyt/terminal', config: { timeoutMs: 1000 } }, { id: 'bash', name: '@flyt/bash' }],
    }] },
    { source: 'home', entries: [{
      id: 'shell', name: 'cordis:group', group: true,
      config: [{ id: 'pty', name: '@flyt/terminal', config: { timeoutMs: 60000 } }],
    }] },
  ]);
  assert.deepEqual(entries[0].config.map(c => c.id), ['pty', 'bash'], 'the child it did not mention survived');
  assert.equal(entries[0].config[0].config.timeoutMs, 60000);
});

test('a new row must name a plugin, and every row must have an id', () => {
  assert.throws(() => compose([{ source: 'cli', entries: [{ id: 'x' }] }]), /needs a name/);
  assert.throws(() => compose([{ source: 'cli', entries: [{ name: 'x' }] }]), /needs an id/);
});

// --- discovery -------------------------------------------------------------

test('a package contributes by declaring it, and most packages contribute nothing', () => {
  const dir = tmp();
  try {
    write(dir, 'node_modules/react/package.json', JSON.stringify({ name: 'react' }));
    write(dir, 'node_modules/@flyt/blocks-core/package.json',
      JSON.stringify({ name: '@flyt/blocks-core', dsh: { bundle: './cordis.yml' } }));
    write(dir, 'node_modules/@flyt/blocks-core/cordis.yml', '- id: work\n  name: "@flyt/block-work"\n');
    write(dir, 'node_modules/@flyt/loop/package.json',
      JSON.stringify({ name: '@flyt/loop', dsh: { profile: 'flyt-loop-worker', patch: './patch.yml' } }));
    write(dir, 'node_modules/@flyt/loop/patch.yml', '- id: work\n  name: "@flyt/block-work"\n  config:\n    unattended: true\n');

    const contributions = discoverContributions(path.join(dir, 'node_modules'));
    assert.deepEqual(contributions.map(c => c.packageName), ['@flyt/blocks-core', '@flyt/loop']);

    const forWorker = loadComposition({ contributions, profile: 'flyt-loop-worker' });
    assert.deepEqual(forWorker.entries[0].config, { unattended: true });

    const forDesktop = loadComposition({ contributions, profile: 'flyt-desktop' });
    assert.equal(forDesktop.entries[0].config, undefined, 'another surface\'s patch does not apply');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a composition file with two rows sharing an id is refused', () => {
  const dir = tmp();
  try {
    const file = write(dir, 'cordis.yml', '- id: a\n  name: x\n- id: a\n  name: y\n');
    assert.throws(() => readComposition(file), /two entries share the id "a"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- mounting --------------------------------------------------------------

test('mounting imports each row and applies it in order', async () => {
  const kernel = createKernel();
  const applied = [];
  const importer = async name => ({
    name,
    apply(_ctx, config) { applied.push([name, config]); },
  });
  try {
    const mounted = await mount(kernel.ctx, [
      { id: 'sessions', name: '@flyt/session-jsonl', config: { root: './runs' } },
      { id: 'tools', name: '@flyt/tools' },
      { id: 'off', name: '@flyt/nope', disabled: true },
    ], { import: importer });

    assert.deepEqual(mounted, ['sessions', 'tools']);
    assert.deepEqual(applied, [['@flyt/session-jsonl', { root: './runs' }], ['@flyt/tools', undefined]]);
  } finally { await kernel.dispose(); }
});

test('a group mounts its children in an isolated context', async () => {
  const kernel = createKernel();
  try {
    const importer = async name => ({
      name,
      apply(ctx) { ctx.provide('terminals', { name }); },
    });
    const mounted = await mount(kernel.ctx, [{
      id: 'shell', name: 'cordis:group', group: true, isolate: { terminals: true },
      config: [{ id: 'pty', name: '@flyt/terminal' }],
    }], { import: importer });

    assert.deepEqual(mounted, ['shell', 'pty']);
    assert.equal(kernel.ctx.terminals, undefined, 'the isolated service did not leak into the root');
  } finally { await kernel.dispose(); }
});

test('a row naming something that is not a plugin says which row', async () => {
  const kernel = createKernel();
  try {
    await assert.rejects(
      async () => { await mount(kernel.ctx, [{ id: 'broken', name: 'not-a-plugin' }], { import: async () => ({ hello: 1 }) }); },
      /"not-a-plugin" \(entry "broken"\) is not a plugin/,
    );
  } finally { await kernel.dispose(); }
});

// --- profiles --------------------------------------------------------------

test('the Loop worker never gains a row the desktop does not have', () => {
  // The direction that matters: authority appearing where nobody is watching.
  assertNarrower(PROFILES['flyt-desktop'], PROFILES['flyt-loop-worker']);
  assertNarrower(PROFILES['flyt-desktop'], PROFILES['flyt-cli']);

  assert.throws(
    () => assertNarrower(PROFILES['flyt-loop-worker'], [
      ...PROFILES['flyt-loop-worker'], { id: 'a-shell-for-the-worker', name: 'flyt:shell' },
    ]),
    /contains rows the broader one does not: a-shell-for-the-worker/,
  );
});

test('the unattended profile cannot stop to ask a question nobody will answer', () => {
  const approvals = id => PROFILES[id].find(e => e.id === 'approvals').config;
  assert.equal(approvals('flyt-loop-worker').mode, 'always');
  assert.equal(approvals('flyt-desktop').mode, 'ask');
});

test('a shipped profile mounts and gives a working tree', async () => {
  const dir = tmp();
  const kernel = createKernel({ profile: 'flyt-loop-worker' });
  try {
    const { entries } = loadComposition({
      profile: 'flyt-loop-worker',
      profileEntries: PROFILES['flyt-loop-worker'].map(e =>
        (e.id === 'sessions' ? { ...e, config: { root: dir } } : e)),
    });
    await mount(kernel.ctx, entries, { import: builtinImporter });

    assert.ok(kernel.ctx.sessions, 'the session seam is provided');
    assert.ok(kernel.ctx.tools, 'the tool registry is provided');

    // And the gate is there: an unclassified tool is unreachable.
    kernel.ctx.tools.register({
      name: 'mystery', description: '', parameters: {},
      async execute() { return { content: 'ran' }; },
    });
    const result = await kernel.ctx.tools.execute({
      runId: 'r', blockId: 'b', step: 1, call: { id: 'c', name: 'mystery', args: {} }, ceiling: ['mystery'],
    });
    assert.match(result.error, /unclassified/);
  } finally { await kernel.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
