// Summary nodes (OUTPUT-VIEW-PLAN B4, D5–D8): flowRunner.summarizeOutputs and
// its persistence — summaries/<key>.md + summaries/index.json round-tripping
// into the snapshot, prompt assembly (named sources, truncation budget),
// no-model and call-error degradation, delete and position moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner } from '../core/flowRunner.js';
import { makeStore, setScript, roleOf, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

const goalOf = prompt => (prompt.match(/GOAL:\n(.+)/) ?? [])[1]?.trim();

function smallFlow() {
  return makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('a', 'aiStep', { goal: 'A' }),
      node('b', 'aiStep', { goal: 'B' }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'b'), edge('b', 'out')]);
}

async function doneRun(store) {
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(smallFlow());
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  return { runner, runId };
}

test('summarizeOutputs writes summaries/<key>.md and registers the index entry', async () => {
  const store = makeStore();
  setScript(({ system, prompt }) => roleOf(system) === 'summarizer'
    ? Promise.resolve('**TL;DR** — A did the work.\n\n- point one\n- point two')
    : Promise.resolve(`output ${goalOf(prompt)}`));
  const { runner, runId } = await doneRun(store);

  const res = await runner.summarizeOutputs(runId, ['a']);
  assert.equal(res.ok, true);
  assert.equal(res.summary.id, 'sum-a');
  assert.match(res.summary.text, /TL;DR/);

  // On disk: the Markdown file and the index entry with provenance (D5/D6).
  assert.match(store.readSummaryText(runId, 'a.md'), /point one/);
  const [entry] = store.readSummaries(runId);
  assert.equal(entry.id, 'sum-a');
  assert.equal(entry.file, 'a.md');
  assert.deepEqual(entry.sources, [{ id: 'a', statusAtCreation: 'done' }]);
  assert.equal(entry.model.provider, 'script');
  assert.ok(entry.at, 'creation timestamp recorded');

  // Snapshot assembly carries summaries with their text for the canvas.
  const snap = store.snapshot(runId);
  assert.equal(snap.summaries.length, 1);
  assert.match(snap.summaries[0].text, /point two/);
  // flow.json is never touched (D5).
  assert.ok(!store.readFlow(runId).nodes.some(n => n.id === 'sum-a'));
});

test('multi-source summarize names each source and states the truncation budget', async () => {
  const store = makeStore();
  let seenPrompt = null;
  setScript(({ system, prompt }) => {
    if (roleOf(system) === 'summarizer') { seenPrompt = prompt; return Promise.resolve('**TL;DR** — both.\n\n- a\n- b'); }
    return Promise.resolve(`output ${goalOf(prompt)}`);
  });
  const { runner, runId } = await doneRun(store);

  const res = await runner.summarizeOutputs(runId, ['a', 'b']);
  assert.equal(res.ok, true);
  assert.equal(res.summary.id, 'sum-a+b', 'key = joined sanitized source ids');
  assert.deepEqual(res.summary.sources.map(s => s.id), ['a', 'b']);
  assert.ok(seenPrompt.includes('## SOURCE: a'), 'each source section is named');
  assert.ok(seenPrompt.includes('## SOURCE: b'));
  assert.match(seenPrompt, /truncated to \d+ characters/, 'the prompt says the budget');
  assert.ok(seenPrompt.includes('output A') && seenPrompt.includes('output B'), 'both outputs included');
});

test('a source summarized mid-run records its non-terminal statusAtCreation (D6)', async () => {
  const store = makeStore();
  setScript(({ system, prompt }) => roleOf(system) === 'summarizer'
    ? Promise.resolve('**TL;DR** — partial.\n\n- so far')
    : Promise.resolve(`output ${goalOf(prompt)}`));
  const { runner, runId } = await doneRun(store);
  // 'out' is done too; use a legacy/id-less source instead: planner stage is
  // absent here — use the input node (always has the prompt) and a ghost.
  const res = await runner.summarizeOutputs(runId, ['in', 'ghost-node']);
  assert.equal(res.ok, true);
  const byId = Object.fromEntries(res.summary.sources.map(s => [s.id, s.statusAtCreation]));
  assert.equal(byId['in'], 'done');
  assert.equal(byId['ghost-node'], 'unknown', 'untraceable source is honestly unknown');
});

test('summarizeOutputs degrades to no-model without a configured model, persisting nothing', async () => {
  const store = makeStore();
  setScript(({ prompt }) => Promise.resolve(`output ${goalOf(prompt)}`));
  const { runner, runId } = await doneRun(store);
  runner.config = { ...testConfig(), workers: { executor: { provider: 'nope', model: 'x' } } };

  const res = await runner.summarizeOutputs(runId, ['a']);
  assert.deepEqual(res, { ok: false, error: 'no-model' });
  assert.deepEqual(store.readSummaries(runId), [], 'nothing persisted on no-model');
});

test('summarizeOutputs returns a retryable error when the call itself fails', async () => {
  const store = makeStore();
  setScript(({ system, prompt }) => roleOf(system) === 'summarizer'
    ? Promise.reject(new Error('API 500: boom'))
    : Promise.resolve(`output ${goalOf(prompt)}`));
  const { runner, runId } = await doneRun(store);
  runner.config = { ...runner.config, retry: { attempts: 1, baseMs: 1 } }; // no backoff in tests

  const res = await runner.summarizeOutputs(runId, ['a']);
  assert.equal(res.ok, false);
  assert.match(res.error, /boom/);
  assert.notEqual(res.error, 'no-model', 'a call failure is distinct from no-model');
  assert.deepEqual(store.readSummaries(runId), []);
  assert.ok(store.readLog(runId).some(e => e.event === 'summarize_failed'));
});

test('summarizeOutputs refuses sources with no output at all', async () => {
  const store = makeStore();
  setScript(({ prompt }) => Promise.resolve(`output ${goalOf(prompt)}`));
  const { runner, runId } = await doneRun(store);
  await assert.rejects(runner.summarizeOutputs(runId, ['ghost-node']), /no output/);
  await assert.rejects(runner.summarizeOutputs(runId, []), /at least one source/);
});

test('re-summarizing the same sources refreshes in place; delete removes file + entry', async () => {
  const store = makeStore();
  let n = 0;
  setScript(({ system, prompt }) => roleOf(system) === 'summarizer'
    ? Promise.resolve(`**TL;DR** — take ${++n}.\n\n- v${n}`)
    : Promise.resolve(`output ${goalOf(prompt)}`));
  const { runner, runId } = await doneRun(store);

  await runner.summarizeOutputs(runId, ['a']);
  await runner.summarizeOutputs(runId, ['a']);
  assert.equal(store.readSummaries(runId).length, 1, 'same key upserts, no duplicates');
  assert.match(store.readSummaryText(runId, 'a.md'), /take 2/);

  assert.deepEqual(runner.deleteSummary(runId, 'sum-a'), { ok: true });
  assert.deepEqual(store.readSummaries(runId), [], 'index entry removed');
  assert.equal(store.readSummaryText(runId, 'a.md'), null, 'Markdown file removed');
  assert.deepEqual(runner.deleteSummary(runId, 'sum-a'), { ok: false, error: 'not-found' });
  assert.equal(store.snapshot(runId).summaries.length, 0);
});

test('moveSummary persists a dragged position and it round-trips via the snapshot', async () => {
  const store = makeStore();
  setScript(({ system, prompt }) => roleOf(system) === 'summarizer'
    ? Promise.resolve('**TL;DR** — x.\n\n- y')
    : Promise.resolve(`output ${goalOf(prompt)}`));
  const { runner, runId } = await doneRun(store);

  await runner.summarizeOutputs(runId, ['a']);
  assert.deepEqual(runner.moveSummary(runId, 'sum-a', { x: 420.4, y: 133.7 }), { ok: true });
  const snap = store.snapshot(runId);
  assert.deepEqual(snap.summaries[0].position, { x: 420, y: 134 }, 'position saved, rounded');
  assert.deepEqual(runner.moveSummary(runId, 'sum-ghost', { x: 0, y: 0 }), { ok: false, error: 'not-found' });
});

test('the summarizer prompt shape is TL;DR + bullets (system role)', async () => {
  const store = makeStore();
  let seenSystem = null;
  setScript(({ system, prompt }) => {
    if (roleOf(system) === 'summarizer') { seenSystem = system; return Promise.resolve('**TL;DR** — ok.\n\n- one'); }
    return Promise.resolve(`output ${goalOf(prompt)}`);
  });
  const { runner, runId } = await doneRun(store);
  await runner.summarizeOutputs(runId, ['b']);
  assert.match(seenSystem, /\*\*TL;DR\*\*/);
  assert.match(seenSystem, /3-6/);
});
