// The deliverable/effect contract (WR-01).
//
// The production failure these exist for: a code-category task returned polished
// prose, called no write tool, changed no file, and was marked done. The
// interesting cases are the ones that separate "did nothing" from "did something
// that is legitimately not a diff" — an analysis task, a write that was reverted,
// an untracked new file, and a change outside the task's scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  EFFECT_MODES, normalizeEffectMode, inferEffectMode, effectContractFor,
  captureWorkspaceSignature, evaluateTaskEffect, applyScope, describeEffect,
  writesWorkspace, EffectMissingError
} from '../core/effect.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-effect-'));
const gitIn = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });

function makeRepo() {
  const root = path.join(tmp(), 'repo');
  fs.mkdirSync(root, { recursive: true });
  gitIn(['init', '-b', 'main'], root);
  gitIn(['config', 'user.email', 'test@localhost'], root);
  gitIn(['config', 'user.name', 'Test'], root);
  fs.writeFileSync(path.join(root, 'src.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
  gitIn(['add', '-A'], root);
  gitIn(['commit', '-m', 'init', '--no-verify'], root);
  return root;
}

const WRITE_TOOL = { name: 'edit_file', effects: ['write'], scope: 'workspace' };
const READ_TOOL = { name: 'read_file', effects: ['read'], scope: 'workspace' };
const QUEUE_TOOL = { name: 'enqueue_task', effects: ['write'], scope: 'workspace' };
const SHELL_TOOL = { name: 'bash', effects: ['shell'], scope: 'workspace' };

// --- normalization / inference ---------------------------------------------

test('normalizeEffectMode accepts the modes and the spellings a plan produces', () => {
  for (const m of EFFECT_MODES) assert.equal(normalizeEffectMode(m), m);
  assert.equal(normalizeEffectMode('WORKSPACE-CHANGE'), 'workspace-change');
  assert.equal(normalizeEffectMode('diff'), 'workspace-change');
  assert.equal(normalizeEffectMode('markdown'), 'artifact');
  assert.equal(normalizeEffectMode('nonsense'), null);
  assert.equal(normalizeEffectMode(undefined), null);
});

test('a code-category agentTask owes a workspace change', () => {
  assert.equal(inferEffectMode({ type: 'agentTask', category: 'Code general' }), 'workspace-change');
  assert.equal(inferEffectMode({ type: 'agentTask', category: 'Test-creation' }), 'workspace-change');
});

test('analysis and evaluation roles owe an artifact, not a diff', () => {
  assert.equal(inferEffectMode({ type: 'aiStep', role: 'analyze' }), 'artifact');
  assert.equal(inferEffectMode({ type: 'aiStep', role: 'plan-eval' }), 'artifact');
  // A planning role holding write tools is still a planning role.
  assert.equal(inferEffectMode({ type: 'agentTask', role: 'plan', tools: [WRITE_TOOL] }), 'artifact');
});

test('an agentTask with an AUTHORED file-writing grant owes a workspace change', () => {
  assert.equal(inferEffectMode({ type: 'agentTask', tools: [READ_TOOL, WRITE_TOOL] }), 'workspace-change');
  assert.equal(inferEffectMode({ type: 'agentTask', tools: [READ_TOOL] }), 'artifact');
  // enqueue_task writes the queue, not the source: it must not imply a diff.
  assert.equal(inferEffectMode({ type: 'agentTask', tools: [READ_TOOL, QUEUE_TOOL] }), 'artifact');
  assert.equal(writesWorkspace(QUEUE_TOOL), false);
  assert.equal(writesWorkspace(WRITE_TOOL), true);
});

test('the DEFAULT full registry is not evidence that a diff was wanted', () => {
  // An unrestricted agentTask is handed the whole library, create_file
  // included. Inferring intent from that would silently re-define every
  // existing flow's unrestricted nodes as owing a repository change.
  assert.equal(
    inferEffectMode({ type: 'agentTask', tools: [READ_TOOL, WRITE_TOOL], toolsAuthored: false }),
    'artifact');
});

test('a shell grant is a verification grant, not a promise of a diff', () => {
  // Granting bash is how a task is told to run the suite and report back.
  assert.equal(writesWorkspace(SHELL_TOOL), false);
  assert.equal(inferEffectMode({ type: 'agentTask', tools: [SHELL_TOOL] }), 'artifact');
  // …but a code-category task still owes the change: the category said so.
  assert.equal(inferEffectMode({ type: 'agentTask', category: 'Code general', tools: [SHELL_TOOL] }), 'workspace-change');
});

test('structural nodes claim no deliverable', () => {
  assert.equal(inferEffectMode({ type: 'input' }), 'none');
  assert.equal(inferEffectMode({ type: 'output' }), 'none');
});

test('an authored contract overrides inference and is marked as authored', () => {
  const authored = effectContractFor({ type: 'agentTask', category: 'Code general', effect: 'artifact' });
  assert.equal(authored.mode, 'artifact');
  assert.equal(authored.inferred, false);
  const inferred = effectContractFor({ type: 'agentTask', category: 'Code general' });
  assert.equal(inferred.mode, 'workspace-change');
  assert.equal(inferred.inferred, true);
});

test('effect scope normalizes to a glob list', () => {
  assert.deepEqual(effectContractFor({ effectScope: 'src/**' }).scope, ['src/**']);
  assert.deepEqual(effectContractFor({ effectScope: ['src/**', 'tests/**'] }).scope, ['src/**', 'tests/**']);
  assert.equal(effectContractFor({}).scope, null);
});

// --- signatures -------------------------------------------------------------

test('an edited tracked file is a workspace change', () => {
  const root = makeRepo();
  const before = captureWorkspaceSignature(root);
  assert.equal(before.kind, 'git');
  fs.writeFileSync(path.join(root, 'src.js'), 'export const a = 2;\n');
  const after = captureWorkspaceSignature(root);
  const r = evaluateTaskEffect({ contract: { mode: 'workspace-change' }, artifactText: 'done', before, after });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changedPaths, ['src.js']);
});

test('a write followed by a complete revert is not a workspace change', () => {
  const root = makeRepo();
  const original = fs.readFileSync(path.join(root, 'src.js'), 'utf8');
  const before = captureWorkspaceSignature(root);
  fs.writeFileSync(path.join(root, 'src.js'), 'export const a = 999;\n');
  fs.writeFileSync(path.join(root, 'src.js'), original); // put it back
  const after = captureWorkspaceSignature(root);
  const r = evaluateTaskEffect({ contract: { mode: 'workspace-change' }, artifactText: 'done', before, after });
  assert.equal(r.ok, false);
  assert.match(r.reason, /required workspace change was not produced/);
});

test('an untracked new file counts, an ignored one does not', () => {
  const root = makeRepo();
  const before = captureWorkspaceSignature(root);
  fs.writeFileSync(path.join(root, 'new.js'), 'export const b = 1;\n');
  fs.mkdirSync(path.join(root, 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ignored', 'artifact.log'), 'noise\n');
  const after = captureWorkspaceSignature(root);
  const r = evaluateTaskEffect({ contract: { mode: 'workspace-change' }, artifactText: 'done', before, after });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changedPaths, ['new.js']);
});

test('work the agent committed inside the worktree still counts', () => {
  const root = makeRepo();
  const before = captureWorkspaceSignature(root);
  fs.writeFileSync(path.join(root, 'src.js'), 'export const a = 3;\n');
  gitIn(['add', '-A'], root);
  gitIn(['commit', '-m', 'agent work', '--no-verify'], root);
  const after = captureWorkspaceSignature(root);
  // Status is clean again — only the HEAD move proves anything happened.
  assert.deepEqual(after.status, {});
  const r = evaluateTaskEffect({ contract: { mode: 'workspace-change' }, artifactText: 'done', before, after });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changedPaths, ['src.js']);
});

test('a change outside the declared scope does not satisfy the contract', () => {
  const root = makeRepo();
  const before = captureWorkspaceSignature(root);
  fs.writeFileSync(path.join(root, 'NOTES.md'), 'I thought about it.\n');
  const after = captureWorkspaceSignature(root);
  const r = evaluateTaskEffect({
    contract: { mode: 'workspace-change', scope: ['src/**', '*.js'] },
    artifactText: 'done', before, after
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /outside this task's scope/);
  assert.deepEqual(r.outOfScopePaths, ['NOTES.md']);
});

test('a non-git workspace is fingerprinted by content, not mtime', () => {
  const root = path.join(tmp(), 'plain');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  const before = captureWorkspaceSignature(root);
  assert.equal(before.kind, 'scan');
  // Rewritten byte-identical: not a change.
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  let r = evaluateTaskEffect({ contract: { mode: 'workspace-change' }, artifactText: 'x', before, after: captureWorkspaceSignature(root) });
  assert.equal(r.ok, false);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\n');
  r = evaluateTaskEffect({ contract: { mode: 'workspace-change' }, artifactText: 'x', before, after: captureWorkspaceSignature(root) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changedPaths, ['a.txt']);
});

// --- evaluation rules -------------------------------------------------------

test('an artifact task succeeds on prose with no repository diff', () => {
  const root = makeRepo();
  const before = captureWorkspaceSignature(root);
  const r = evaluateTaskEffect({
    contract: { mode: 'artifact' }, artifactText: '# Findings\n\nThree things.',
    before, after: captureWorkspaceSignature(root)
  });
  assert.equal(r.ok, true);
});

test('an artifact task fails on empty text', () => {
  const r = evaluateTaskEffect({ contract: { mode: 'artifact' }, artifactText: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /required artifact was not produced/);
});

test('either accepts an artifact alone', () => {
  const root = makeRepo();
  const before = captureWorkspaceSignature(root);
  const r = evaluateTaskEffect({
    contract: { mode: 'either' }, artifactText: 'text',
    before, after: captureWorkspaceSignature(root)
  });
  assert.equal(r.ok, true);
});

test('none always passes — a control node claims nothing', () => {
  assert.equal(evaluateTaskEffect({ contract: { mode: 'none' }, artifactText: '' }).ok, true);
});

test('an unmeasurable workspace is not a manufactured failure, but it is flagged', () => {
  const before = captureWorkspaceSignature(null);
  assert.equal(before.kind, 'none');
  const r = evaluateTaskEffect({
    contract: { mode: 'workspace-change' }, artifactText: 'I changed it, honest.',
    before, after: captureWorkspaceSignature(null)
  });
  assert.equal(r.ok, true);
  assert.equal(r.unverified, true);
  assert.equal(r.detectable, false);
  // With no artifact either, there is nothing at all to accept.
  const empty = evaluateTaskEffect({ contract: { mode: 'workspace-change' }, artifactText: '', before, after: before });
  assert.equal(empty.ok, false);
});

test('applyScope filters with the small glob dialect', () => {
  const paths = ['src/a.js', 'src/deep/b.js', 'README.md', 'tests/c.test.js'];
  assert.deepEqual(applyScope(paths, ['src/**']), ['src/a.js', 'src/deep/b.js']);
  assert.deepEqual(applyScope(paths, ['**/*.test.js']), ['tests/c.test.js']);
  assert.deepEqual(applyScope(paths, null), paths);
});

test('describeEffect is a short, secret-free summary', () => {
  const root = makeRepo();
  const before = captureWorkspaceSignature(root);
  fs.writeFileSync(path.join(root, 'src.js'), 'export const a = 4;\n');
  const r = evaluateTaskEffect({ contract: { mode: 'workspace-change' }, artifactText: 'ok', before, after: captureWorkspaceSignature(root) });
  const s = describeEffect(r);
  assert.match(s, /required workspace-change/);
  assert.match(s, /1 file\(s\) changed/);
  assert.ok(s.length < 200);
});

test('EffectMissingError carries the result and is distinguishable', () => {
  const r = evaluateTaskEffect({ contract: { mode: 'workspace-change' }, artifactText: 'x', before: { kind: 'git', status: {} }, after: { kind: 'git', status: {} } });
  const err = new EffectMissingError(r);
  assert.equal(err.effectMissing, true);
  assert.equal(err.effect.required, 'workspace-change');
  assert.match(err.message, /required workspace change/);
});
