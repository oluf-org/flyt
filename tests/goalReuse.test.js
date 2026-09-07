import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoalController } from '../core/goalController.js';
import { GoalAuthoring } from '../core/goalAuthoring.js';
import { goalRequirements, goalFolder, referencedGoalPaths } from '../core/goalRequirements.js';
import { GOAL_RECIPE } from '../src/v2/goalDefaults.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-goal-reuse-'));
  const entries = new Map(['source', 'target'].map(id => {
    const folder = path.join(root, id); fs.mkdirSync(folder);
    return [id, { id, name: id, folder, store: { rootDir: path.join(root, `${id}-runs`) } }];
  }));
  const goals = new GoalController({ runs: {}, project: id => { const item = entries.get(id); if (!item) throw new Error('Project closed'); return item; }, worker: () => ({ provider: 'mock', model: 'test' }) });
  const author = new GoalAuthoring({ root: path.join(root, 'authoring'), goals, call: () => { throw new Error('Reuse must not call a model'); } });
  const definition = { name: 'Security audit', objective: 'Audit the repository', recipe: GOAL_RECIPE, requiredPaths: ['src', 'docs/security.md'], createFolder: false,
    folder: entries.get('source').folder, criteria: [{ type: 'output_contains', value: 'Audit' }], worker: { provider: 'mock', model: 'test' } };
  t.after(async () => { await author.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const draft = await author.open({ projectId: 'source', definition });
  return { root, entries, goals, author, draft };
}

test('persisted definitions can be reused after the source project closes without copying execution or authoring state', async t => {
  const f = await fixture(t);
  const args = { projectId: 'source', draftId: f.draft.id };
  const published = await f.author.publish({ ...args, baseRevision: 1 });
  published.requests = [{ id: 'old-request', status: 'complete', text: 'private conversation' }];
  published.grants = [{ id: 'old-grant' }]; published.ui.selectedFiles = 'private.md'; published.authoringCalls = 80; published.knownUsd = 5;
  f.author.save(published);
  const originalBytes = fs.readFileSync(f.author.file('source', f.draft.id), 'utf8');
  const [loop] = f.author.library();
  assert.equal(loop.name, 'Security audit');
  assert.equal(loop.definition, undefined); assert.equal(loop.requests, undefined);
  f.entries.delete('source');
  const reopened = new GoalAuthoring({ root: f.author.root, goals: f.goals });
  assert.equal(reopened.library()[0].id, loop.id);
  const reused = await reopened.reuse({ projectId: 'target', libraryId: loop.id });
  assert.equal(reused.projectId, 'target'); assert.equal(reused.goalId, null); assert.equal(reused.definition.folder, '');
  assert.equal(reused.approvedHash, null); assert.equal(reused.authoringCalls, 0); assert.equal(reused.knownUsd, 0);
  assert.deepEqual(reused.grants, []); assert.deepEqual(reused.requests, []); assert.deepEqual(reused.proposals, []);
  assert.equal(reused.definition.authoringId, undefined); assert.equal(reused.definition.folderIdentity, undefined);
  assert.deepEqual(reused.definition.requiredPaths, ['src', 'docs/security.md']);
  const report = await reopened.requirements({ projectId: 'target', draftId: reused.id });
  assert.deepEqual(report.paths.map(item => item.status), ['missing', 'missing']);
  const next = await reopened.publish({ projectId: 'target', draftId: reused.id, baseRevision: reused.revision });
  const run = f.goals.get('target', next.goalId);
  assert.equal(run.contract.folder, f.entries.get('target').folder);
  assert.equal(run.iteration, 0); assert.equal(run.calls, 0); assert.deepEqual(run.memory, []);
  const [directory, id] = loop.id.split(':');
  assert.equal(fs.readFileSync(path.join(f.author.root, directory, `${id}.json`), 'utf8'), originalBytes);
});

test('library survives corrupt records and rejects path traversal IDs', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(path.dirname(f.author.file('source', f.draft.id)), 'broken.json'), '{');
  assert.equal(f.author.library().length, 1);
  for (const libraryId of ['../secret', `../:${f.draft.id}`, `${'a'.repeat(64)}:../../secret`, null]) await assert.rejects(f.author.reuse({ projectId: 'target', libraryId }), /INVALID_ID/);
});

test('required paths resolve in the destination, refresh after project changes and distinguish outputs from inputs', async t => {
  const f = await fixture(t), project = f.entries.get('target');
  const definition = { ...f.draft.definition, folder: '', criteria: [{ type: 'file_contains', path: 'audit/output.md', value: 'done' }] };
  fs.mkdirSync(path.join(project.folder, 'src'));
  const references = [{ path: 'audit/output.md', address: 'recipe/improve/config/instructions' }, { path: 'README.md', address: 'goal/objective' }];
  const first = goalRequirements(definition, project, { references });
  assert.deepEqual(first.paths.map(item => item.status), ['present', 'missing', 'missing']);
  assert.equal(first.paths.find(item => item.path === 'audit/output.md'), undefined);
  fs.mkdirSync(path.join(project.folder, 'docs')); fs.writeFileSync(path.join(project.folder, 'docs/security.md'), '');
  assert.deepEqual(goalRequirements(definition, project).paths.map(item => item.status), ['present', 'present']);
  fs.rmSync(path.join(project.folder, 'docs/security.md'));
  assert.equal(goalRequirements(definition, project).paths[1].status, 'missing');
});

test('new workspaces warn about parent files that will not be copied, then inspect actual runtime workspace', async t => {
  const f = await fixture(t), project = f.entries.get('target');
  fs.mkdirSync(path.join(project.folder, 'src'));
  const definition = { folder: '', createFolder: true, requiredPaths: ['src'] };
  const preview = goalRequirements(definition, project);
  assert.equal(preview.paths[0].status, 'new_workspace'); assert.equal(preview.warnings[0].code, 'dedicated_workspace');
  const workspace = path.join(project.folder, 'actual'); fs.mkdirSync(workspace);
  assert.equal(goalRequirements(definition, project, { workspace }).paths[0].status, 'missing');
  fs.mkdirSync(path.join(workspace, 'src'));
  assert.equal(goalRequirements(definition, project, { workspace }).paths[0].status, 'present');
});

test('cross-platform absolute paths, traversal and escaping links are warnings without probing outside the workspace', async t => {
  const f = await fixture(t), project = f.entries.get('target');
  fs.symlinkSync(f.root, path.join(project.folder, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = goalRequirements({ requiredPaths: ['C:\\source\\src', '/home/source/src', '..\\source', 'escape/missing/file', 'src\\nested'] }, project);
  assert.deepEqual(report.paths.map(item => item.status), ['absolute', 'absolute', 'outside', 'outside', 'missing']);
  fs.unlinkSync(path.join(project.folder, 'escape'));
});

test('relative workspace bindings resolve against the selected project, not the app cwd', async t => {
  const f = await fixture(t), project = f.entries.get('target');
  fs.mkdirSync(path.join(project.folder, 'subproject'));
  assert.equal(goalFolder({ folder: 'subproject' }, project), path.join(project.folder, 'subproject'));
  assert.equal(f.goals.contract({ ...f.draft.definition, folder: 'subproject' }, 'target').folder, fs.realpathSync(path.join(project.folder, 'subproject')));
  assert.equal(goalRequirements({ folder: 'absent' }, project).warnings[0].code, 'workspace');
});

test('legacy quoted path references identify their fields without interpreting ordinary prose or URLs as paths', () => {
  const address = 'recipe/a/config/instructions';
  const result = referencedGoalPaths(new Map([[address, 'Read `src/auth.js` and `SECURITY.md`; old C:\\repo\\audit.js. Also docs/security.md. Skip `https://example.org/a.js` and `npm test`.'], ['goal/name', '`ignore.js`']]));
  assert.deepEqual([...new Set(result.map(item => item.path))], ['src/auth.js', 'SECURITY.md', 'C:\\repo\\audit.js', 'docs/security.md']);
  assert.ok(result.every(item => item.address === address));
});

test('requirements are editable before start, fixed after publish and supplied to runtime context', async t => {
  const f = await fixture(t), args = { projectId: 'source', draftId: f.draft.id };
  await assert.rejects(f.author.edit({ ...args, baseRevision: 1, operations: [{ op: 'replace', address: 'goal/requiredPaths', value: [42] }] }), /INVALID_WORKFLOW/);
  const draft = await f.author.edit({ ...args, baseRevision: 1, operations: [{ op: 'replace', address: 'goal/requiredPaths', value: ['missing.md'] }] });
  const published = await f.author.publish({ ...args, baseRevision: draft.revision });
  await assert.rejects(f.author.edit({ ...args, baseRevision: draft.revision, operations: [{ op: 'replace', address: 'goal/requiredPaths', value: [] }] }), /LOCKED_FIELD/);
  const goal = f.goals.get('source', published.goalId); goal.workspace = { path: f.entries.get('source').folder };
  assert.equal(f.goals.packet(goal).projectRequirements.paths[0].status, 'missing');
});

test('unavailable saved models are surfaced without blocking reuse', async t => {
  const f = await fixture(t);
  const draft = await f.author.reuse({ projectId: 'target', libraryId: f.author.library()[0].id });
  const args = { projectId: 'target', draftId: draft.id };
  assert.equal((await f.author.requirements(args)).warnings.some(item => item.code === 'model'), true);
  f.author.models = () => [{ id: 'test' }];
  assert.equal((await f.author.requirements(args)).warnings.some(item => item.code === 'model'), false);
});
