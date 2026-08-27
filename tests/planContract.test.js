// Bounded, validated planning (WR-06).
//
// The three production failures these cover:
//   - a focused UI change planned into seven to nine tasks, several existing
//     only to hand prose to the next one;
//   - downstream tasks logging `context_input_missing` and running anyway, on
//     inputs nothing ever produced;
//   - a planner streaming thousands of near-identical "I'll inspect…" sentences
//     without calling a tool, caught only after ~6 minutes by the general
//     heartbeat.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANNER_LIMITS, plannerLimits, normalizeTaskContract, validatePlan, reaskPrompt,
  createSpinDetector, SPIN_DEFAULTS
} from '../core/planContract.js';

const task = (id, extra = {}) => ({ id, effect: 'workspace-change', outputs: [`${id}.out`], ...extra });

// --- limits ------------------------------------------------------------------

test('planner limits come from config but can never exceed the hard ceiling', () => {
  assert.deepEqual(plannerLimits({}), PLANNER_LIMITS);
  assert.equal(plannerLimits({ planner: { maxPlanTasks: 3 } }).maxPlanTasks, 3);
  // A soft cap above the hard one is a configuration mistake, not a licence.
  const silly = plannerLimits({ planner: { maxPlanTasks: 999, maxPlanTasksHard: 8 } });
  assert.equal(silly.maxPlanTasks, 8);
  // Zero re-asks is a legitimate choice; garbage falls back to the default.
  assert.equal(plannerLimits({ planner: { maxReasks: 0 } }).maxReasks, 0);
  assert.equal(plannerLimits({ planner: { maxPlanTasks: -4 } }).maxPlanTasks, PLANNER_LIMITS.maxPlanTasks);
});

// --- contracts ---------------------------------------------------------------

test('a task contract normalizes its declared inputs and effect', () => {
  const c = normalizeTaskContract({
    id: ' t1 ', effect: 'diff', outputs: 'a.md',
    requiredInputs: ['prompt.md', ' '], optionalInputs: ['maybe.md', 'prompt.md'],
    dependsOn: 't0'
  });
  assert.equal(c.id, 't1');
  assert.equal(c.effect, 'workspace-change');
  assert.deepEqual(c.outputs, ['a.md']);
  assert.deepEqual(c.requiredInputs, ['prompt.md']);
  // Declared both ways means REQUIRED — the stricter reading is the safe one.
  assert.deepEqual(c.optionalInputs, ['maybe.md']);
  assert.deepEqual(c.dependsOn, ['t0']);
});

// --- plan validation ---------------------------------------------------------

test('a plan over the task cap is rejected with an actionable reason', () => {
  const specs = Array.from({ length: 9 }, (_, i) => task(`t${i}`));
  const r = validatePlan(specs, { limits: plannerLimits({ planner: { maxPlanTasks: 5 } }), available: [] });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /9 tasks, over the limit of 5/);
  assert.match(r.errors[0], /independently verifiable/);
  assert.equal(r.metrics.taskCount, 9);
});

test('a broad request may be allowed past the soft cap but never past the hard one', () => {
  const specs = Array.from({ length: 9 }, (_, i) => task(`t${i}`));
  assert.equal(validatePlan(specs, { allowExceed: true }).ok, true);
  const huge = Array.from({ length: 20 }, (_, i) => task(`t${i}`));
  assert.equal(validatePlan(huge, { allowExceed: true }).ok, false);
});

test('a required input with no producer is rejected BEFORE anything runs', () => {
  const r = validatePlan([
    task('t1', { requiredInputs: ['prompt.md'] }),
    task('t2', { requiredInputs: ['design-notes.md'] })   // nothing produces this
  ], { available: ['prompt.md'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /task "t2" requires "design-notes.md"/);
  assert.match(r.errors.join(' '), /Declare a producer, mark it optional, or drop it/);
});

test('an input another task produces is fine, and so is one the run already has', () => {
  const r = validatePlan([
    task('t1', { outputs: ['design-notes.md'] }),
    task('t2', { requiredInputs: ['design-notes.md', 'prompt.md'], dependsOn: ['t1'] })
  ], { available: ['prompt.md'] });
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('a missing OPTIONAL input is a warning, not an error', () => {
  const r = validatePlan([task('t1', { optionalInputs: ['nice-to-have.md'] })], { available: [] });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(' '), /may use "nice-to-have.md".*will run without it/);
});

test('two tasks claiming the same output is a contradiction, not a merge', () => {
  const r = validatePlan([
    { id: 't1', effect: 'artifact', outputs: ['report.md'] },
    { id: 't2', effect: 'artifact', outputs: ['report.md'] }
  ], {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /both claim to produce "report.md"/);
});

test('cycles and unknown dependencies are caught', () => {
  const cyclic = validatePlan([
    task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })
  ], {});
  assert.equal(cyclic.ok, false);
  assert.match(cyclic.errors.join(' '), /dependency cycle/);

  const dangling = validatePlan([task('a', { dependsOn: ['ghost'] })], {});
  assert.equal(dangling.ok, false);
  assert.match(dangling.errors.join(' '), /depends on "ghost", which is not in this plan/);
});

test('duplicate task ids are rejected', () => {
  const r = validatePlan([task('a'), task('a')], {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /duplicate task id "a"/);
});

test('a task with nothing checkable is flagged', () => {
  const r = validatePlan([{ id: 'vague' }], {});
  assert.equal(r.ok, true, 'not fatal on its own');
  assert.match(r.warnings.join(' '), /declares neither an output nor an effect/);
});

test('an oversized contract is refused before it is parsed into work', () => {
  const r = validatePlan([task('a')], { contractBytes: 10 * 1024 * 1024 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /over the .* limit/);
});

test('the re-ask names every validator error and restates the hard rules', () => {
  const r = validatePlan(Array.from({ length: 9 }, (_, i) => task(`t${i}`)), {});
  const prompt = reaskPrompt(r, { limits: PLANNER_LIMITS });
  assert.match(prompt, /Your plan was rejected/);
  assert.match(prompt, /over the limit/);
  assert.match(prompt, new RegExp(`at most ${PLANNER_LIMITS.maxPlanTasks} tasks`));
});

// --- planner liveness --------------------------------------------------------

// A clock the test drives, so nothing here waits on real time.
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

test('a planner restating itself is interrupted in ~a minute, not six', () => {
  const clock = fakeClock();
  const d = createSpinDetector({ now: clock.now });

  // The real shape of it: the same sentence, over and over, no tool calls.
  for (let i = 0; i < 40; i++) d.push("I'll inspect the repository structure first.\n");
  assert.equal(d.state().tripped, false, 'not yet — too soon to judge');

  clock.advance(SPIN_DEFAULTS.minMs + 1);
  const s = d.push("I'll inspect the repository structure first.\n");
  assert.equal(s.tripped, true);
  assert.match(s.reason, /called no tool and produced no contract/);
  assert.ok(s.metrics.elapsedMs < 6 * 60 * 1000, 'well inside the six-minute heartbeat');
  assert.ok(s.metrics.novelty < SPIN_DEFAULTS.minNovelty);
});

test('a long stream with genuinely new content is never interrupted', () => {
  const clock = fakeClock();
  const d = createSpinDetector({ now: clock.now });
  for (let i = 0; i < 300; i++) {
    d.push(`Considering the interaction between module alpha${i} and the persistence layer beta${i}.\n`);
    clock.advance(1000);
  }
  const s = d.state();
  assert.equal(s.tripped, false, 'novel work is work');
  assert.ok(s.metrics.novelty > 0.9);
});

test('a quiet reasoning call is not this detector\'s business', () => {
  const clock = fakeClock();
  const d = createSpinDetector({ now: clock.now });
  clock.advance(20 * 60 * 1000);  // twenty silent minutes
  assert.equal(d.state().tripped, false, 'silence is the stall detector\'s job, not this one\'s');
  assert.equal(d.state().metrics.lines, 0);
});

test('a tool call or contract progress clears suspicion even amid repetition', () => {
  const clock = fakeClock();
  const withTool = createSpinDetector({ now: clock.now });
  for (let i = 0; i < 60; i++) withTool.push('Looking at the repository now.\n');
  clock.advance(SPIN_DEFAULTS.minMs + 1);
  withTool.noteToolCall();
  assert.equal(withTool.state().tripped, false, 'it actually did something');

  const withContract = createSpinDetector({ now: clock.now });
  for (let i = 0; i < 60; i++) withContract.push('Looking at the repository now.\n');
  withContract.noteContractProgress();
  assert.equal(withContract.state().tripped, false);
});

test('partial chunks are reassembled into lines', () => {
  const clock = fakeClock();
  const d = createSpinDetector({ now: clock.now });
  // Adapters emit token-sized chunks, not lines.
  for (let i = 0; i < 40; i++) {
    d.push("I'll inspect the ");
    d.push('repository structure ');
    d.push('first.\n');
  }
  clock.advance(SPIN_DEFAULTS.minMs + 1);
  const s = d.state();
  assert.equal(s.metrics.lines, 40);
  assert.equal(s.tripped, true);
});

test('trivial lines do not count as evidence either way', () => {
  const clock = fakeClock();
  const d = createSpinDetector({ now: clock.now });
  for (let i = 0; i < 50; i++) d.push('---\n\nok\n');
  clock.advance(SPIN_DEFAULTS.minMs + 1);
  assert.equal(d.state().metrics.lines, 0);
  assert.equal(d.state().tripped, false);
});

// --- required inputs, through the real executor ------------------------------

test('a task whose REQUIRED input has no producer fails before any model call', async () => {
  const { makeStore, setScript, testConfig } = await import('./helpers.js');
  const { runExecutorTask } = await import('../core/nodes/executor.js');

  const store = makeStore();
  const runId = store.createRun('build it');
  let called = 0;
  setScript(() => { called++; return 'I assumed the design notes said…'; });

  store.writeTasks(runId, { tasks: [{
    id: 'task-2', title: 'Implement', goal: 'Implement from the design notes.',
    inputs: ['prompt.md', 'design-notes.md'],
    requiredInputs: ['design-notes.md'],   // nothing in this run produces it
    constraints: [], tools: [],
    worker: { provider: 'script', model: 'm' }, status: 'pending'
  }] });

  const retro = await runExecutorTask(store, runId, 'task-2', testConfig());

  assert.equal(retro.status, 'failed');
  assert.equal(called, 0, 'no model was called — failing here costs nothing');
  assert.match(retro.problems.join(' '), /Required input\(s\) not available: design-notes\.md/);
  assert.equal(store.readTasks(runId).tasks[0].status, 'failed');
  const ev = (store.readLog(runId) ?? []).find(e => e.event === 'context_input_missing');
  assert.equal(ev.required, true);
});

test('an undeclared missing input still degrades quietly, as it always did', async () => {
  const { makeStore, setScript, testConfig } = await import('./helpers.js');
  const { runExecutorTask } = await import('../core/nodes/executor.js');

  const store = makeStore();
  const runId = store.createRun('build it');
  setScript(() => '## Done\n\nWorked around it.');
  store.writeTasks(runId, { tasks: [{
    id: 'task-2', title: 'Implement', goal: 'Do it.',
    // No requiredInputs: the legacy best-effort contract every existing flow
    // relies on — a fan-out lane's upstream id may legitimately produce nothing.
    inputs: ['prompt.md', 'maybe.md'],
    constraints: [], tools: [],
    worker: { provider: 'script', model: 'm' }, status: 'pending'
  }] });

  const retro = await runExecutorTask(store, runId, 'task-2', testConfig());
  assert.equal(retro.status, 'success');
  const ev = (store.readLog(runId) ?? []).find(e => e.event === 'context_input_missing');
  assert.equal(ev.required, false);
});

// --- planner spin, through the real runner -----------------------------------

test('a spinning planner is interrupted and fails with its reason, not requeued', async () => {
  const { makeStore, setScript, testConfig, waitForStage } = await import('./helpers.js');
  const { StackRunner } = await import('../core/stackRunner.js');

  const store = makeStore();
  // Thresholds tightened so the test does not wait a real minute; the SHAPE of
  // the failure is what is under test, not the wall-clock constant.
  const runner = new StackRunner(store, testConfig({
    planner: { spin: { minLines: 10, minMs: 0, minNovelty: 0.25 } }
  }));

  setScript(({ onText, signal }) => {
    // The real thing: the same sentence, forever, with no tool call — streamed
    // the way every adapter streams, as the WHOLE turn so far rather than the
    // new piece (core/adapters/http.js renderTurn, mock.js). This fake used to
    // emit one repeated chunk instead, which is not a shape any provider
    // produces, and it hid a defect it should have caught: the detector was
    // being fed the cumulative buffer and re-counting every line on every
    // emission, so a healthy long plan tripped it purely for being long.
    let turn = '';
    for (let i = 0; i < 400; i++) {
      turn += "I'll inspect the repository structure first.\n";
      onText?.(turn);
    }
    // A spinning planner does not stop on its own, so the abort has to reach it.
    // Honoring `signal` is what every real adapter does — fetch passes it
    // straight through, the CLI adapters kill the child — so a fake that
    // ignored it would be testing a provider that does not exist.
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(aborted());
      signal?.addEventListener('abort', () => reject(aborted()), { once: true });
      setTimeout(() => resolve('never gets here'), 5000);
    });
  });

  const flow = {
    id: 'f', name: 'F',
    nodes: [
      { id: 'in', type: 'input', data: { text: 'add a small banner' }, position: { x: 0, y: 0 } },
      { id: 'plan', type: 'aiStep', data: { role: 'plan' }, position: { x: 0, y: 0 } },
      { id: 'out', type: 'output', data: {}, position: { x: 0, y: 0 } }
    ],
    edges: [{ id: 'a', source: 'in', target: 'plan' }, { id: 'b', source: 'plan', target: 'out' }]
  };

  const runId = runner.start(flow, {});
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'failed');

  const log = store.readLog(runId) ?? [];
  const spin = log.find(e => e.event === 'planner_spin');
  assert.ok(spin, 'the spin was detected and recorded');
  assert.match(spin.reason, /called no tool and produced no contract/);
  assert.ok(spin.lines >= 10);

  // It failed with the reason — it did not quietly requeue as a user stop.
  assert.equal(log.some(e => e.event === 'node_aborted' && e.node === 'plan'), false);
  assert.match(store.readMeta(runId).error, /Planning was interrupted/);
  // The partial stream survives as evidence.
  assert.match(store.readNodeOutput(runId, 'plan') ?? '', /inspect the repository/);
});

// A long HEALTHY plan, streamed the way a real adapter streams it.
//
// This is the other half of the spin detector, and the half that was broken:
// the cumulative buffer was fed to a detector that expected the new piece, so
// every line was re-counted on every emission and `distinct / recent` collapsed
// as the answer grew. A real planning call died at 77 seconds reporting
// "560,242 lines with only 49 distinct ones" for an answer nowhere near that
// size — a detector written explicitly NOT to judge by elapsed time, judging by
// elapsed time. A plan that says something new in every line must survive being
// long.
test('a long plan that keeps saying new things is not a spin', async () => {
  const { makeStore, setScript, testConfig, waitForStage } = await import('./helpers.js');
  const { StackRunner } = await import('../core/stackRunner.js');

  const store = makeStore();
  const runner = new StackRunner(store, testConfig({
    planner: { spin: { minLines: 10, minMs: 0, minNovelty: 0.25 } }
  }));

  setScript(({ onText }) => {
    let turn = '';
    for (let i = 0; i < 400; i++) {
      turn += `- task ${i}: a distinct step nobody has written yet\n`;
      onText?.(turn);
    }
    onText?.(turn, { final: true });
    return turn;
  });

  const flow = {
    id: 'f', name: 'F',
    nodes: [
      { id: 'in', type: 'input', data: { text: 'plan something large' }, position: { x: 0, y: 0 } },
      { id: 'plan', type: 'aiStep', data: { role: 'plan' }, position: { x: 0, y: 0 } },
      { id: 'out', type: 'output', data: {}, position: { x: 0, y: 0 } }
    ],
    edges: [{ id: 'a', source: 'in', target: 'plan' }, { id: 'b', source: 'plan', target: 'out' }]
  };

  const runId = runner.start(flow, {});
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal((store.readLog(runId) ?? []).find(e => e.event === 'planner_spin'), undefined,
    'four hundred distinct lines is a long plan, not a stuck one');
});
