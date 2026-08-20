// A reviewer's objection is a correction, not a reason to rebuild.
//
// A landing that fails at REVIEW is the one failure where the gates have
// already passed: the work is sound and a reviewer has named one specific thing
// about it. The loop's answer used to be to throw the attempt away, reset the
// branch to the base, and pay the next rung of the model ladder to write the
// whole thing again — watched a correct 244-line implementation discarded
// because it also left behind an empty file called `1`.
//
// So a review rejection records the commit that was reviewed, and the next
// attempt starts from it with the objection attached. Every other failure —
// red gates, an empty diff — clears it, because those say the attempt is wrong
// in a way a fresh start may fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { git } from '../core/worktree.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-resume-'));

async function repo() {
  const dataRoot = tmp();
  const folder = path.join(dataRoot, 'work');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'README.md'), '# a repository\n');
  await git(['init', '-b', 'main'], { cwd: folder });
  await git(['config', 'user.email', 'test@example.com'], { cwd: folder });
  await git(['config', 'user.name', 'Test'], { cwd: folder });
  await git(['add', '-A'], { cwd: folder });
  await git(['commit', '-m', 'first'], { cwd: folder });

  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  engine.settings.workers = { executor: { provider: 'mock', model: 'mock-large' } };
  engine.rebuildRuntimeConfig();
  const api = createApi(engine);
  const { id: projectId } = await api.invoke('project:open', { folder });
  return { api, engine, projectId, folder };
}

test('a task carries the commit a reviewer rejected, and only that', async () => {
  const { api, engine, projectId } = await repo();
  const backlog = engine.backlogFor(projectId);
  const task = backlog.add({ title: 'A task', goal: 'do a thing' });
  assert.equal(task.resumeFrom, null, 'a new task has nothing to resume from');

  backlog.update(task.id, { resumeFrom: 'a'.repeat(40) });
  assert.equal(backlog.get(task.id).resumeFrom, 'a'.repeat(40), 'it survives the round trip through the file');

  // And it is a real frontmatter field, not something a reader invents.
  const file = fs.readFileSync(path.join(backlog.rootDir, `${task.id}.task.md`), 'utf8');
  assert.match(file, /^resumeFrom: a{40}$/m);
  await api.invoke('project:list');
});

test('work:start begins from the reviewed commit when there is one', async () => {
  const { api, engine, projectId, folder } = await repo();
  const backlog = engine.backlogFor(projectId);
  const task = backlog.add({ title: 'Resume me', goal: 'g' });

  // A commit that is NOT on main: exactly the shape of a rejected attempt.
  await git(['checkout', '-b', 'scratch'], { cwd: folder });
  fs.writeFileSync(path.join(folder, 'attempt.txt'), 'the work a reviewer read\n');
  // Only the attempt's own file: `add -A` would sweep the backlog directory
  // into the commit, and checking main out again would then delete the very
  // task this test is about.
  await git(['add', 'attempt.txt'], { cwd: folder });
  await git(['commit', '-m', 'the attempt'], { cwd: folder });
  const reviewed = (await git(['rev-parse', 'HEAD'], { cwd: folder })).trim();
  await git(['checkout', 'main'], { cwd: folder });

  backlog.update(task.id, { resumeFrom: reviewed });
  const wt = await api.invoke('work:start', { projectId, taskId: task.id });
  try {
    assert.equal(wt.resumedFrom, reviewed, 'the caller is told it inherited work');
    assert.equal(fs.readFileSync(path.join(wt.dir, 'attempt.txt'), 'utf8').trim(), 'the work a reviewer read',
      'the previous attempt has to actually be in the worktree');
    assert.equal(backlog.get(task.id).resumedFrom, reviewed);
  } finally {
    await api.invoke('work:discard', { projectId, taskId: task.id });
  }
});

// A sha that no longer resolves — the branch was gc'd, the repository was
// re-cloned — must degrade to the base branch. Failing the attempt over a
// missing object would wedge the task permanently.
test('a resumeFrom that no longer exists degrades to the base branch and is cleared', async () => {
  const { api, engine, projectId } = await repo();
  const backlog = engine.backlogFor(projectId);
  const task = backlog.add({ title: 'Ghost', goal: 'g' });
  backlog.update(task.id, { resumeFrom: 'f'.repeat(40) });

  const wt = await api.invoke('work:start', { projectId, taskId: task.id });
  try {
    assert.equal(wt.resumedFrom, undefined, 'nothing was inherited');
    assert.ok(fs.existsSync(path.join(wt.dir, 'README.md')), 'it started from the base branch instead');
    assert.equal(backlog.get(task.id).resumeFrom, null, 'a sha that cannot resolve is not kept');
  } finally {
    await api.invoke('work:discard', { projectId, taskId: task.id });
  }
});

test('the brief tells the worker its work is already there, and only then', async () => {
  const { engine, projectId } = await repo();
  const backlog = engine.backlogFor(projectId);
  const task = backlog.add({ title: 'T', goal: 'g' });

  // The supervisor builds the brief from the task file, so the task file is
  // what decides whether the line appears. Assert on the field that drives it
  // and on the sentence the supervisor emits for it.
  const source = fs.readFileSync(path.join(projectRoot, 'core', 'supervisor.js'), 'utf8');
  assert.match(source, /task\.resumeFrom/, 'the brief has to consult the field');
  assert.match(source, /THE PREVIOUS ATTEMPT IS ALREADY HERE/);
  assert.match(source, /Do not start over/);

  assert.equal(backlog.get(task.id).resumeFrom, null, 'a first attempt is not told it inherited anything');
  backlog.update(task.id, { resumeFrom: 'c'.repeat(40), blockedReason: 'a stray file at the repo root' });
  const after = backlog.get(task.id);
  assert.equal(after.resumeFrom, 'c'.repeat(40));
  assert.equal(after.blockedReason, 'a stray file at the repo root',
    'the objection and the commit travel together, or the correction has nothing to correct');
});
