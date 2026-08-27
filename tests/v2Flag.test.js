// The v2 flag (D62). The promise is not "v2 is disabled"; it is that with the
// flag off the v2 tree is never loaded at all, so it cannot change how a v1 run
// behaves by existing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v2Flag, isV2Enabled, bootKernel } from '../core/v2.js';

const noEnv = {};

test('on by default after cutover', () => {
  assert.deepEqual(v2Flag({ env: noEnv }), { enabled: true, source: 'default' });
  assert.equal(isV2Enabled({ env: noEnv }), true);
});

test('the call wins, then the environment, then the settings', () => {
  assert.deepEqual(v2Flag({ call: true, env: { FLYT_V2: '0' }, settings: { v2: false } }),
    { enabled: true, source: 'call' });
  assert.deepEqual(v2Flag({ env: { FLYT_V2: '1' }, settings: { v2: false } }),
    { enabled: true, source: 'env' });
  assert.deepEqual(v2Flag({ env: noEnv, settings: { v2: true } }),
    { enabled: true, source: 'settings' });

  // And --no-v2 turns it off against a settings file that says on.
  assert.deepEqual(v2Flag({ call: false, env: noEnv, settings: { v2: true } }),
    { enabled: false, source: 'call' });
});

test('FLYT_V2=0 turns it off, rather than on for being present', () => {
  for (const raw of ['0', 'false', 'off', 'no', 'FALSE']) {
    assert.equal(v2Flag({ env: { FLYT_V2: raw } }).enabled, false, `FLYT_V2=${raw}`);
  }
  for (const raw of ['1', 'true', 'on', 'yes']) {
    assert.equal(v2Flag({ env: { FLYT_V2: raw } }).enabled, true, `FLYT_V2=${raw}`);
  }
  // An empty value is not a choice.
  assert.equal(v2Flag({ env: { FLYT_V2: '' }, settings: { v2: true } }).source, 'settings');
});

test('an explicit off flag keeps the v2 tree unloaded', async () => {
  let opened = 0;
  const booted = await bootKernel({
    call: false, env: noEnv,
    load: () => { opened += 1; return import('#kernel'); },
  });
  assert.equal(booted, null);
  assert.equal(opened, 0, 'the only door into v2 was not opened');
});

test('with the flag on, the kernel boots and the seams resolve', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-v2-'));
  const booted = await bootKernel({
    call: true, env: noEnv, profile: 'flyt-loop-worker', runsRoot: dir, approvalMode: 'always',
  });
  try {
    assert.ok(booted, 'it booted');
    assert.equal(booted.profile, 'flyt-loop-worker');
    assert.ok(booted.ctx.sessions, 'ctx.sessions');
    assert.ok(booted.ctx.tools, 'ctx.tools');
    assert.ok(booted.ctx.skills, 'ctx.skills');

    // The session seam writes where we told it to.
    const session = await booted.ctx.sessions.open('run-1');
    await session.append({ type: 'message.user', data: { content: 'hello' } });
    assert.ok(fs.existsSync(path.join(dir, 'run-1', 'session.jsonl')));

    // And a tool contributed by a plugin still meets the gate.
    booted.ctx.tools.register({
      name: 'write_notes',
      description: 'a tool from somewhere',
      parameters: {},
      classification: { effect: 'write', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: 'written' }; },
    });
    const exec = {
      runId: 'run-1', blockId: 'work', step: 1,
      call: { id: 'c1', name: 'write_notes', args: {} },
      ceiling: ['write_notes'],
    };
    assert.equal((await booted.ctx.tools.execute(exec)).content, 'written');

    const refused = await booted.ctx.tools.execute({ ...exec, ceiling: [] });
    assert.match(refused.error, /not in this block's ceiling/, 'the ceiling still holds under the flag');
  } finally {
    await booted?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production boot refuses an external plugin when no review surface can answer', async () => {
  const actual = await import('#kernel');
  let applied = 0;
  const external = {
    name: 'boot-time-external', inject: ['tools'],
    apply() { applied += 1; },
  };
  const load = async () => ({
    ...actual,
    PROFILES: {
      ...actual.PROFILES,
      'review-boot': [
        { id: 'tools', name: 'flyt:tools' },
        { id: 'external', name: 'external-package' },
      ],
    },
    builtinImporter: name => name === 'external-package'
      ? Promise.resolve(external)
      : actual.builtinImporter(name),
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('boot hung waiting for an invisible review')), 250);
  });
  try {
    await assert.rejects(
      Promise.race([bootKernel({ call: true, env: noEnv, profile: 'review-boot', load }), timeout]),
      /requires an attended human classification review/);
    assert.equal(applied, 0, 'refusal precedes external plugin execution');
  } finally {
    clearTimeout(timer);
  }
});

test('an attended host can review a startup plugin before boot settles', async () => {
  const actual = await import('#kernel');
  let detach;
  let reviewed = 0;
  const external = {
    name: 'startup-tool', inject: ['tools'],
    apply(ctx) {
      ctx.tools.register({
        name: 'startup_read', description: 'Read startup state.', parameters: { type: 'object' },
        async execute() { return { content: 'ready' }; },
      });
    },
  };
  const load = async () => ({
    ...actual,
    PROFILES: {
      ...actual.PROFILES,
      'attended-boot': [
        { id: 'tools', name: 'flyt:tools' },
        { id: 'external', name: 'startup-package' },
      ],
    },
    builtinImporter: name => name === 'startup-package'
      ? Promise.resolve(external)
      : actual.builtinImporter(name),
  });
  const booted = await bootKernel({
    call: true, env: noEnv, profile: 'attended-boot', load,
    onReviewReady(prepared) {
      detach = prepared.pluginReviews.subscribe(() => {
        const pending = prepared.pluginReviews.snapshot();
        if (!pending) return;
        reviewed += 1;
        pending.decide(Object.fromEntries(pending.proposals.map(p => [p.name, p])));
      });
    },
  });
  try {
    assert.equal(reviewed, 1);
    assert.equal(booted.ctx.tools.get('startup_read').classification.source, 'confirmed');
  } finally {
    detach?.();
    await booted.dispose();
  }
});

test('the surface decides who it can ask, not the profile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-v2-'));
  const booted = await bootKernel({ call: true, env: noEnv, profile: 'flyt-desktop', runsRoot: dir, approvalMode: 'ask' });
  try {
    booted.ctx.tools.register({
      name: 'write_notes', description: '', parameters: {},
      classification: { effect: 'write', destructive: false, untrustedInput: false, source: 'confirmed' },
      async execute() { return { content: 'written' }; },
    });
    const result = await booted.ctx.tools.execute({
      runId: 'r', blockId: 'b', step: 1, call: { id: 'c', name: 'write_notes', args: {} }, ceiling: ['write_notes'],
    });
    // Nobody is wired up to answer in this process, and that is a refusal.
    assert.match(result.error, /nobody was available to approve it/);
  } finally {
    await booted?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the optional boot switch still guards its own dynamic import', () => {
  // Canonical stack stores may consume the kernel after cutover. The remaining
  // promise is local: bootKernel(call:false) does not open its own dynamic door.
  const source = fs.readFileSync(new URL('../core/v2.js', import.meta.url), 'utf8');
  assert.match(source, /load = \(\) => import\('#kernel'\)/);
  assert.doesNotMatch(source, /^\s*import\s[^\n]*#kernel/m);
});
