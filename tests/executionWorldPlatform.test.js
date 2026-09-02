import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalExecutionWorld, layeredEnv, scrubbedParentEnv } from '#kernel';

const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function localWorld(t, mode = 'workspace-write') {
  const requestedRoot = temp(`flyt-platform-${mode}-`);
  const runs = temp('flyt-platform-runs-');
  try {
    const world = await createLocalExecutionWorld({ workspaceRoot: requestedRoot, mode,
      minimumEnforcement: 'partial', allowAttendedEscalation: false, runsTempRoot: runs,
      // GitHub's Windows hosted runner is elevated. Production launches still
      // refuse that posture; this option exists only to exercise the restricted
      // child token and ACL boundary on the ephemeral CI machine.
      allowElevatedWindowsRunnerForTest: process.platform === 'win32'
        && process.env.GITHUB_ACTIONS === 'true' && process.env.FLYT_RELEASE_SANDBOX_E2E === '1',
    });
    // macOS exposes os.tmpdir() through /var while its canonical filesystem path
    // is /private/var. Exercise the exact path carried by the execution world so
    // Seatbelt's subpath rules and the child process agree on one identity.
    return { root: world.world.hostRoot, runs, world };
  } catch (error) {
    if (error?.code === 'SANDBOX_UNAVAILABLE' || /sandbox backend/i.test(String(error?.message))) {
      if (process.env.FLYT_RELEASE_SANDBOX_E2E === '1') throw error;
      t.skip(`platform sandbox unavailable: ${error?.probe?.reason ?? error.message}`);
      return null;
    }
    throw error;
  }
}

async function spawnConfined(world, policy, script, options = {}) {
  const confined = await world.sandbox.confine([process.execPath, '-e', script], policy);
  const handle = world.subprocess.spawn({
    owner: policy.owner, argv: confined.argv, cwd: policy.workspaceRoot,
    env: layeredEnv(scrubbedParentEnv(), { TMPDIR: policy.privateTemp, TEMP: policy.privateTemp, TMP: policy.privateTemp }),
    stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 16_384 }, timeoutMs: 15_000, graceMs: 500,
    runnerFailure: confined.runnerFailure, ...options,
  });
  return handle;
}

// Ordinary developer machines may not have their platform backend installed.
// Release CI treats a skip from this file as a failed release prerequisite.
test('the installed platform backend permits workspace writes and denies external writes', async t => {
  const local = await localWorld(t);
  if (!local) return;
  const { root, world } = local;
  const outsideRoot = temp('flyt-platform-outside-');
  const inside = path.join(root, 'inside.txt');
  const outside = path.join(outsideRoot, 'outside.txt');
  const descendantInside = path.join(root, 'descendant.txt');
  const descendantOutside = path.join(outsideRoot, 'descendant-outside.txt');
  const link = path.join(root, 'outside-link');
  try {
    fs.symlinkSync(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    const policy = await world.sandboxPolicy.resolve({ runId: 'platform', callId: 'write', tool: 'platform-test', attended: false });
    const grandchild = `const f=require('fs');f.writeFileSync(${JSON.stringify(descendantInside)},'inside');try{f.writeFileSync(${JSON.stringify(descendantOutside)},'outside')}catch{};try{f.writeFileSync(${JSON.stringify(path.join(link, 'linked.txt'))},'outside')}catch{}`;
    const child = `require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'})`;
    const script = `const f=require('fs');f.writeFileSync(${JSON.stringify(inside)},'inside');try{f.writeFileSync(${JSON.stringify(outside)},'outside')}catch{};require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});process.exit(f.existsSync(${JSON.stringify(outside)})||f.existsSync(${JSON.stringify(descendantOutside)})||f.existsSync(${JSON.stringify(path.join(outsideRoot, 'linked.txt'))})?42:0)`;
    const handle = await spawnConfined(world, policy, script);
    const outcome = await handle.done;
    assert.equal(outcome.runnerFailed, undefined, handle.stderr.text);
    assert.equal(outcome.exitCode, 0, handle.stderr.text);
    assert.equal(fs.readFileSync(inside, 'utf8'), 'inside');
    assert.equal(fs.readFileSync(descendantInside, 'utf8'), 'inside', 'a grandchild ran and retained workspace authority');
    assert.equal(fs.existsSync(outside), false);
    assert.equal(fs.existsSync(descendantOutside), false);
    assert.equal(fs.existsSync(path.join(outsideRoot, 'linked.txt')), false);
  } finally { await world.dispose(); }
});

test('read-only denies workspace and private-temp writes', async t => {
  const local = await localWorld(t, 'read-only');
  if (!local) return;
  const { root, world } = local;
  const workspaceFile = path.join(root, 'denied.txt');
  try {
    const policy = await world.sandboxPolicy.resolve({ runId: 'readonly', callId: 'deny', tool: 'platform-test', attended: false });
    const script = `const f=require('fs');for(const p of [${JSON.stringify(workspaceFile)},${JSON.stringify(path.join(policy.privateTemp, 'denied.txt'))}])try{f.mkdirSync(require('path').dirname(p),{recursive:true});f.writeFileSync(p,'bad')}catch{};process.exit(f.existsSync(${JSON.stringify(workspaceFile)})||f.existsSync(${JSON.stringify(path.join(policy.privateTemp, 'denied.txt'))})?42:0)`;
    const handle = await spawnConfined(world, policy, script);
    const outcome = await handle.done;
    assert.equal(outcome.runnerFailed, undefined, handle.stderr.text);
    assert.equal(outcome.exitCode, 0, handle.stderr.text);
    assert.equal(fs.existsSync(workspaceFile), false);
    assert.equal(fs.existsSync(path.join(policy.privateTemp, 'denied.txt')), false);
  } finally { await world.dispose(); }
});

test('workspace calls cannot use one another private-temp capability', async t => {
  const local = await localWorld(t);
  if (!local) return;
  const { world } = local;
  try {
    const first = await world.sandboxPolicy.resolve({ runId: 'temps', callId: 'first', tool: 'platform-test', attended: false });
    const second = await world.sandboxPolicy.resolve({ runId: 'temps', callId: 'second', tool: 'platform-test', attended: false });
    const own = path.join(first.privateTemp, 'own.txt');
    const foreign = path.join(second.privateTemp, 'foreign.txt');
    const script = `const f=require('fs');f.writeFileSync(${JSON.stringify(own)},'own');try{f.writeFileSync(${JSON.stringify(foreign)},'foreign')}catch{};process.exit(f.existsSync(${JSON.stringify(foreign)})?42:0)`;
    const handle = await spawnConfined(world, first, script);
    const outcome = await handle.done;
    assert.equal(outcome.runnerFailed, undefined, handle.stderr.text);
    assert.equal(outcome.exitCode, 0, handle.stderr.text);
    assert.equal(fs.readFileSync(own, 'utf8'), 'own');
    assert.equal(fs.existsSync(foreign), false);
  } finally { await world.dispose(); }
});

test('terminating a confined owner kills its descendant tree', async t => {
  const local = await localWorld(t);
  if (!local) return;
  const { root, world } = local;
  const ready = path.join(root, 'descendant-ready.txt');
  const outside = path.join(temp('flyt-platform-stop-outside-'), 'late.txt');
  try {
    const policy = await world.sandboxPolicy.resolve({ runId: 'stop-tree', callId: 'tree', tool: 'platform-test', attended: false });
    const grandchild = `const f=require('fs');f.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{try{f.writeFileSync(${JSON.stringify(outside)},'late')}catch{}},1500);setInterval(()=>{},1000)`;
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const handle = await spawnConfined(world, policy, script, { timeoutMs: 10_000 });
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await delay(20);
    assert.equal(fs.existsSync(ready), true, 'descendant reached its ready point');
    await handle.terminate('platform tree test');
    await handle.waitForExit();
    await delay(1_700);
    assert.equal(fs.existsSync(outside), false);
    assert.deepEqual(world.subprocess.active('stop-tree'), []);
  } finally { await world.dispose(); }
});
