import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createFsSeam, createLocalExecutionWorld, createSandboxPolicy, scrubbedParentEnv,
} from '#kernel';

const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const execution = (callId = 'c') => ({ owner: { runId: 'r', callId }, tool: 'test', attended: false });
const worldFor = (root, mode) => Object.freeze({
  id: `test:${mode}:${root}`, provider: 'local', workspaceId: 'test', hostRoot: root, processRoot: root,
  platform: process.platform,
  sandbox: Object.freeze({ standingMode: mode, backend: mode === 'danger-full-access' ? 'unconfined' : 'bubblewrap',
    enforcement: mode === 'danger-full-access' ? 'none' : 'full', network: 'ambient' }),
});

test('managed subprocess preserves argv and scrubs ambient credentials', async () => {
  const root = temp('flyt-world-');
  const owner = await createLocalExecutionWorld({ workspaceRoot: root, mode: 'danger-full-access',
    minimumEnforcement: 'partial', allowAttendedEscalation: false, runsTempRoot: temp('flyt-world-runs-') });
  try {
    const env = scrubbedParentEnv({ ...process.env, FLYT_INTERNAL: 'no', DEMO_TOKEN: 'no', ORDINARY_VALUE: 'yes' });
    const handle = owner.subprocess.spawn({
      owner: { runId: 'r', callId: 'c' }, argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({a:process.argv[1],token:process.env.DEMO_TOKEN,ordinary:process.env.ORDINARY_VALUE}))', 'a b&c'],
      cwd: root, env, stdout: { maxBytes: 10_000 }, stderr: { maxBytes: 10_000 }, timeoutMs: 5_000, graceMs: 100,
    });
    const outcome = await handle.done;
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(JSON.parse(handle.stdout.text), { a: 'a b&c', ordinary: 'yes' });
    assert.deepEqual(owner.subprocess.active('r'), []);
  } finally { await owner.dispose(); }
});

test('sandbox policy narrows without prompting and consumes exact widening once', async () => {
  const root = temp('flyt-policy-');
  const world = Object.freeze({ id: 'w', provider: 'local', workspaceId: 'x', hostRoot: root, processRoot: root,
    platform: process.platform, sandbox: Object.freeze({ standingMode: 'read-only', backend: 'unconfined', enforcement: 'none', network: 'ambient' }) });
  let approvals = 0;
  const policy = createSandboxPolicy({ mode: 'read-only', workspaceRoot: root, minimumEnforcement: 'partial', allowAttendedEscalation: true },
    world, temp('flyt-policy-runs-'), { approve: async () => { approvals++; return 'allowed-once'; } });
  const first = await policy.resolve({ runId: 'r', callId: 'c', tool: 'write_file', requestedMode: 'workspace-write', justification: 'create output', attended: true });
  assert.equal(first.mode, 'workspace-write'); assert.equal(first.escalated, true); assert.equal(approvals, 1);
  await assert.rejects(() => policy.resolve({ runId: 'r', callId: 'c', tool: 'write_file', requestedMode: 'workspace-write', justification: 'again', attended: true }), /already consumed/);
});

test('unattended widening is rejected before an approver is called', async () => {
  const root = temp('flyt-policy-loop-');
  const world = Object.freeze({ id: 'w', provider: 'local', workspaceId: 'x', hostRoot: root, processRoot: root,
    platform: process.platform, sandbox: Object.freeze({ standingMode: 'workspace-write', backend: 'unconfined', enforcement: 'none', network: 'ambient' }) });
  let approvals = 0;
  const policy = createSandboxPolicy({ mode: 'workspace-write', workspaceRoot: root, minimumEnforcement: 'partial', allowAttendedEscalation: false },
    world, temp('flyt-policy-loop-runs-'), { approve: async () => { approvals++; return 'allowed-once'; } });
  await assert.rejects(() => policy.resolve({ runId: 'r', callId: 'c', tool: 'bash', requestedMode: 'danger-full-access', justification: 'outside', attended: false }), /not available/);
  assert.equal(approvals, 0);
});

test('a voluntary narrower mode is not recorded as an escalation', async () => {
  const root = temp('flyt-policy-narrow-');
  const world = worldFor(root, 'danger-full-access');
  const policy = createSandboxPolicy({ mode: 'danger-full-access', workspaceRoot: root,
    minimumEnforcement: 'partial', allowAttendedEscalation: true }, world, temp('flyt-policy-narrow-runs-'));
  const resolved = await policy.resolve({ runId: 'narrow', callId: 'one', tool: 'write_file',
    requestedMode: 'workspace-write', justification: 'use less authority', attended: true });
  assert.equal(resolved.mode, 'workspace-write');
  assert.equal(resolved.escalated, false);
});

test('filesystem modes deny read-only mutations and never widen past the seam root', async () => {
  const root = temp('flyt-fs-policy-');
  const outside = temp('flyt-fs-outside-');
  fs.writeFileSync(path.join(root, 'kept.txt'), 'before');
  const readOnly = createFsSeam(root, { world: worldFor(root, 'read-only'), resolveMutation: async () => ({ mode: 'read-only' }) });
  await assert.rejects(() => readOnly.write('kept.txt', 'after', { execution: execution('write') }), error => error.code === 'FS_SANDBOX_DENIED');
  await assert.rejects(() => readOnly.remove('kept.txt', { execution: execution('remove') }), error => error.code === 'FS_SANDBOX_DENIED');
  assert.equal(fs.readFileSync(path.join(root, 'kept.txt'), 'utf8'), 'before');

  const writable = createFsSeam(root, { world: worldFor(root, 'workspace-write'), resolveMutation: async () => ({ mode: 'workspace-write' }) });
  await writable.write('inside.txt', 'inside', { execution: execution('inside') });
  assert.equal(await writable.read('inside.txt'), 'inside');
  await assert.rejects(() => writable.write('../escape.txt', 'bad', { execution: execution('escape') }), /escapes the workspace root/);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escape.txt')), false);

  const unconfined = createFsSeam(root, { world: worldFor(root, 'danger-full-access'), resolveMutation: async () => ({ mode: 'danger-full-access' }) });
  await assert.rejects(() => unconfined.write(path.join(outside, 'bad.txt'), 'bad', { execution: execution('absolute') }), /escapes the workspace root/);
  assert.equal(fs.existsSync(path.join(outside, 'bad.txt')), false);
});

test('filesystem mutations reject a symlink or junction escape', async t => {
  const root = temp('flyt-fs-link-');
  const outside = temp('flyt-fs-link-outside-');
  try { fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`links unavailable: ${error.code ?? error.message}`); return; }
  const seam = createFsSeam(root, { world: worldFor(root, 'workspace-write'), resolveMutation: async () => ({ mode: 'workspace-write' }) });
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside');
  assert.equal((await seam.list()).some(entry => entry.path.includes('private.txt')), false);
  await assert.rejects(() => seam.write('link/escaped.txt', 'bad', { execution: execution('link') }), /symlink escape/);
  assert.equal(fs.existsSync(path.join(outside, 'escaped.txt')), false);
});

test('managed subprocess distinguishes truncation, spill, non-zero exit, timeout, and runner failure', async () => {
  const root = temp('flyt-process-cases-');
  const owner = await createLocalExecutionWorld({ workspaceRoot: root, mode: 'danger-full-access',
    minimumEnforcement: 'partial', allowAttendedEscalation: false, runsTempRoot: temp('flyt-process-runs-') });
  const spawn = (callId, script, extra = {}) => owner.subprocess.spawn({
    owner: { runId: 'cases', callId }, argv: [process.execPath, '-e', script], cwd: root,
    env: scrubbedParentEnv(), stdout: { maxBytes: 8, spillMaxBytes: 256 }, stderr: { maxBytes: 64 },
    timeoutMs: 5_000, graceMs: 50, ...extra,
  });
  try {
    const clipped = spawn('clipped', `process.stdout.write('abcdefghijklmnopqrstuvwxyz')`);
    assert.equal((await clipped.done).exitCode, 0);
    assert.equal(clipped.stdout.truncated, true);
    assert.equal(clipped.stdout.text, 'stuvwxyz');
    assert.equal(fs.readFileSync(clipped.stdout.spillPath, 'utf8'), 'abcdefghijklmnopqrstuvwxyz');

    const failed = spawn('failed', 'process.exit(7)');
    assert.equal((await failed.done).exitCode, 7);

    const timed = spawn('timeout', 'setInterval(()=>{},1000)', { timeoutMs: 40 });
    assert.equal((await timed.done).timedOut, true);

    const ordinary120 = spawn('ordinary-120', 'process.exit(120)', {
      runnerFailure: { exitCodes: [120], stderrSignature: 'FLYT_SANDBOX_RUNNER:' },
    });
    assert.equal((await ordinary120.done).runnerFailed, undefined);
    const runner120 = spawn('runner-120', `process.stderr.write('FLYT_SANDBOX_RUNNER: setup failed');process.exit(120)`, {
      runnerFailure: { exitCodes: [120], stderrSignature: 'FLYT_SANDBOX_RUNNER:' },
    });
    assert.equal((await runner120.done).runnerFailed?.code, 'SANDBOX_RUNNER_FAILED');
  } finally { await owner.dispose(); await owner.dispose(); }
});

test('screened shell restores bounded spill output for durable tool-result archival', async () => {
  const root = temp('flyt-shell-spill-');
  const owner = await createLocalExecutionWorld({ workspaceRoot: root, mode: 'danger-full-access',
    minimumEnforcement: 'partial', allowAttendedEscalation: false, runsTempRoot: temp('flyt-shell-spill-runs-') });
  try {
    const result = await owner.shell.run(`"${process.execPath}" -e "process.stdout.write('x'.repeat(5000010))"`, {
      execution: { owner: { runId: 'spill', callId: 'shell' }, tool: 'bash', attended: false },
      timeoutMs: 10_000,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 5_000_010);
    assert.equal(result.stdout.startsWith('…[truncated'), false);
  } finally { await owner.dispose(); }
});

test('credential-shaped environment names are scrubbed unless explicitly forwarded', () => {
  const parent = { Path: 'ordinary', api_KEY: 'secret', ClientToken: 'secret-2', FLYT_AUTH: 'internal', HOME: 'home' };
  assert.deepEqual(scrubbedParentEnv(parent), { Path: 'ordinary', HOME: 'home' });
  assert.deepEqual(scrubbedParentEnv(parent, ['api_KEY']), { Path: 'ordinary', api_KEY: 'secret', HOME: 'home' });
});
