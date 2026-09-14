import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createLocalExecutionWorld, layeredEnv, scrubbedParentEnv } from '#kernel';

const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('desktop sandbox probe runs with Electron execPath and no inherited Node-mode flag', {
  skip: process.env.FLYT_RELEASE_SANDBOX_E2E !== '1',
}, () => {
  const electron = createRequire(import.meta.url)('electron');
  const kernel = new URL('../kernel/dist/index.js', import.meta.url).href;
  const script = `(async()=>{
    delete process.env.ELECTRON_RUN_AS_NODE;
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const {createLocalExecutionWorld}=await import(${JSON.stringify(kernel)});
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'flyt-electron-probe-'));
    const world=await createLocalExecutionWorld({workspaceRoot:root,mode:'workspace-write',minimumEnforcement:'partial',allowAttendedEscalation:false,runsTempRoot:path.join(root,'.runs'),allowElevatedWindowsRunnerForTest:process.env.GITHUB_ACTIONS==='true'});
    try{const probe=await world.sandbox.probe(true);if(!probe.available)throw new Error(probe.reason);console.log('desktop-probe-ok');}finally{await world.dispose();fs.rmSync(root,{recursive:true,force:true});}
  })().catch(e=>{console.error(e);process.exitCode=1});`;
  const output = execFileSync(electron, ['-e', script], {
    env: {...process.env,ELECTRON_RUN_AS_NODE:'1'}, encoding:'utf8',windowsHide:true,timeout:30000,
  });
  assert.match(output,/desktop-probe-ok/);
});

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
    const probe = await world.sandbox.probe(true);
    if (!probe.available) {
      await world.dispose();
      throw Object.assign(new Error(`Sandbox unavailable: ${probe.reason ?? 'functional probe failed'}`), {
        code: 'SANDBOX_UNAVAILABLE', probe,
      });
    }
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
test('Windows confined shell preserves command text, nested quotes and exit codes', { skip: process.platform !== 'win32' }, async t => {
  const local = await localWorld(t);
  if (!local) return;
  const { root, world } = local;
  try {
    const cases = [
      ['echo hello', 0, 'hello'],
      [`"${process.execPath}" -e "process.stdout.write('a & b');process.exit(7)"`, 7, 'a & b'],
      ['echo kept>"file with spaces.txt"', 0, ''],
    ];
    for (const [index, [command, code, output]] of cases.entries()) {
      const result = await world.shell.run(command, {
        execution: { owner: { runId: 'shell-quotes', callId: String(index) }, tool: 'bash', attended: false },
        timeoutMs: 15_000,
      });
      assert.equal(result.code, code, result.stderr);
      assert.equal(result.stdout.trim(), output);
      assert.equal(result.sandbox.backend, 'windows-restricted-token');
      assert.equal(result.sandbox.escalated, false);
    }
    assert.equal(fs.readFileSync(path.join(root, 'file with spaces.txt'), 'utf8').trim(), 'kept');
  } finally { await world.dispose(); }
});

test('the probe reports whether the native Node test runner can use piped children', async t => {
  const local = await localWorld(t);
  if (!local) return;
  const { root, world } = local;
  try {
    const probe = await world.sandbox.probe();
    assert.equal(typeof probe.nodePipedChildren, 'boolean');
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node --test test/child.test.cjs' } }));
    fs.writeFileSync(path.join(root, 'test', 'child.test.cjs'), "require('node:test')('native test child',()=>require('node:assert/strict').equal(2+2,4));\n");
    const result = await world.shell.run('npm test', {
      execution: { owner: { runId: 'native-test-runner', callId: 'npm-test' }, tool: 'bash', attended: false }, timeoutMs: 20_000,
      // Otherwise Node sees its parent's node:test marker and treats this as a
      // recursive runner invocation: zero tests may exit successfully.
      env: { NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(result.sandbox.escalated, false);
    if (probe.nodePipedChildren) {
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /native test child/);
    } else {
      assert.equal(process.platform, 'win32', 'Linux and macOS release backends must support ordinary piped Node children');
      assert.notEqual(result.code, 0, 'An unsupported exact test command must never be recorded as passing');
      assert.match(result.stderr + result.stdout, /EPERM|EACCES|spawn/i);
    }
    if (process.env.FLYT_RELEASE_SANDBOX_E2E === '1') {
      assert.equal(probe.nodePipedChildren, true,
        'Release blocked: the confined execution world cannot run the unchanged npm/Node test runner. Diagnostic success is not compatibility.');
    }
  } finally { await world.dispose(); }
});

test('Windows piped grandchildren retain file restrictions across native and 32-bit shell launches', { skip: process.platform !== 'win32' }, async t => {
  for (const mode of ['workspace-write', 'read-only']) {
    const local = await localWorld(t, mode);
    if (!local) return;
    const { root, world } = local;
    const outsideRoot = temp('flyt-piped-outside-');
    try {
      const outside = path.join(outsideRoot, 'denied.txt');
      const inside = path.join(root, 'child.txt');
      const leaf = `const f=require('fs');let inside=false,outside=false;try{f.writeFileSync(${JSON.stringify(inside)},'ok');inside=true}catch{};try{f.writeFileSync(${JSON.stringify(outside)},'bad');outside=true}catch{};console.log(JSON.stringify({inside,outside}))`;
      const script = `const c=require('child_process');const r=c.spawnSync(process.execPath,['-e',${JSON.stringify(leaf)}],{encoding:'utf8'});if(r.error)throw r.error;process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1)`;
      const policy = await world.sandboxPolicy.resolve({ runId: 'piped-child', callId: mode, tool: 'platform-test', attended: false });
      const handle = await spawnConfined(world, policy, script);
      assert.equal((await handle.done).exitCode, 0, handle.stderr.text);
      assert.deepEqual(JSON.parse(handle.stdout.text), { inside: mode === 'workspace-write', outside: false });
      assert.equal(fs.existsSync(outside), false);
      // cmd.exe is a 32-bit descendant, which then starts the ordinary 64-bit
      // Node executable. The adapter must cross both architecture transitions.
      const shell32 = path.join(process.env.SystemRoot, 'SysWOW64', 'cmd.exe');
      const mixed = await world.shell.run(`"${shell32}" /d /s /c "\"${process.execPath}\" -e \"require('child_process').execFileSync(process.execPath,['-e','console.log(42)'],{stdio:'pipe'});console.log('mixed-pipes-ok')\""`, {
        execution: { owner: { runId: 'mixed-child', callId: mode }, tool: 'bash', attended: false }, timeoutMs: 15_000,
      });
      assert.equal(mixed.code, 0, mixed.stderr + mixed.stdout);
      assert.match(mixed.stdout, /mixed-pipes-ok/);
      assert.equal(mixed.sandbox.escalated, false);
    } finally { await world.dispose(); fs.rmSync(outsideRoot, { recursive: true, force: true }); }
  }
});

test('Windows default pipes work for their own descendants and deny a sibling invocation', { skip: process.platform !== 'win32' }, async t => {
  const local = await localWorld(t);
  if (!local) return;
  const { world } = local;
  try {
    const pipe = `\\\\.\\pipe\\flyt-private-${process.pid}-${Date.now()}`;
    const first = await world.sandboxPolicy.resolve({ runId: 'pipes', callId: 'first', tool: 'platform-test', attended: false });
    const second = await world.sandboxPolicy.resolve({ runId: 'pipes', callId: 'second', tool: 'platform-test', attended: false });
    const ownClient = `const n=require('net');const c=n.connect(${JSON.stringify(pipe)},()=>{console.log('own-connected');c.end()});c.on('error',e=>{console.error(e);process.exit(1)})`;
    const script = `require('net').createServer(s=>s.end()).listen(${JSON.stringify(pipe)},()=>{const c=require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(ownClient)}],{encoding:'utf8'});if(c.status!==0)throw new Error(c.stderr);console.log('pipe-ready')});`;
    const owner = await spawnConfined(world, first, script);
    const deadline = Date.now() + 5_000;
    while (!owner.stdout.text.includes('pipe-ready') && Date.now() < deadline) await delay(20);
    assert.match(owner.stdout.text, /pipe-ready/, owner.stderr.text);
    const sibling = await spawnConfined(world, second, `const c=require('net').connect(${JSON.stringify(pipe)},()=>{console.log('unexpected access');c.end();process.exitCode=1});c.on('error',e=>{console.log(e.code);process.exitCode=['EPERM','EACCES'].includes(e.code)?0:2})`);
    assert.equal((await sibling.done).exitCode, 0, sibling.stderr.text + sibling.stdout.text);
    assert.match(sibling.stdout.text, /EPERM|EACCES/);
    await owner.terminate('pipe test complete');
  } finally { await world.dispose(); }
});

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
  const lateInside = path.join(root, 'descendant-late.txt');
  const outside = path.join(temp('flyt-platform-stop-outside-'), 'late.txt');
  try {
    const policy = await world.sandboxPolicy.resolve({ runId: 'stop-tree', callId: 'tree', tool: 'platform-test', attended: false });
    const grandchild = `const f=require('fs');f.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{f.writeFileSync(${JSON.stringify(lateInside)},'late');try{f.writeFileSync(${JSON.stringify(outside)},'late')}catch{}},1500);setInterval(()=>{},1000)`;
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const handle = await spawnConfined(world, policy, script, { timeoutMs: 10_000 });
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await delay(20);
    assert.equal(fs.existsSync(ready), true, 'descendant reached its ready point');
    await handle.terminate('platform tree test');
    await handle.waitForExit();
    await delay(1_700);
    assert.equal(fs.existsSync(outside), false);
    assert.equal(fs.existsSync(lateInside), false, 'the descendant stopped, rather than merely failing an outside write');
    assert.deepEqual(world.subprocess.active('stop-tree'), []);
  } finally { await world.dispose(); }
});
