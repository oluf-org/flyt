import test from 'node:test';
import assert from 'node:assert/strict';
import { degradeTaskGraphPlan } from '#kernel';

test('graceful degradation preserves valid tasks, removes only invalid edges, and exposes transformations', () => {
  const candidate = JSON.stringify({ summary: 'candidate', tasks: [
    { id: 'build', title: 'Build', goal: 'Build it', dependsOn: ['missing'], produces: ['app'], requires: [], optional: [], writeFiles: ['src/app.js'] },
    { id: 'test', title: 'Test', goal: 'Test it', dependsOn: ['test'], produces: ['report'], requires: ['app'], optional: [], writeFiles: [] },
    { id: 'BROKEN', title: '', goal: '', dependsOn: [], produces: [], requires: [], optional: [], writeFiles: [] },
  ] });
  const degraded = degradeTaskGraphPlan(candidate, 'Build and test it.');
  assert.deepEqual(degraded.plan.tasks.map(task => task.id), ['build', 'test']);
  assert.deepEqual(degraded.plan.tasks[0].dependsOn, []);
  assert.deepEqual(degraded.plan.tasks[1].dependsOn, ['build']);
  assert.ok(degraded.plan.degraded);
  assert.ok(degraded.plan.transformations.some(item => item.action === 'remove_task'));
  assert.ok(degraded.plan.transformations.some(item => item.action === 'remove_edge'));
});

test('simple requests fall back to one worker, while complex parallel intent fails closed', () => {
  const simple = degradeTaskGraphPlan('', 'Fix the typo in README.');
  assert.equal(simple.plan.tasks.length, 1);
  assert.equal(simple.plan.transformations.at(-1).action, 'single_worker_fallback');
  assert.deepEqual(simple.plan.tasks[0].writeFiles, ['*']);

  const complex = degradeTaskGraphPlan('', 'Use multiple independent workers in parallel to redesign the backend and frontend.');
  assert.equal(complex.plan, null);
  assert.match(complex.reason, /materially change/);
});
