// DECISIONS.md D27 — comparison records + compareGroup provenance.
// A comparison is a persisted relationship between two runs in one project;
// the record lives in comparisons/<id>.json (verdict slot reserved for P3),
// and both runs carry meta.compareGroup so siblings are discoverable from
// either side.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../core/state.js';
import { StackRunner } from '../core/stackRunner.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

// A store whose comparisons/ dir lands inside the temp dir (sibling of runs/).
function makeProjectStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-cmp-'));
  return new RunStore(path.join(dir, 'runs'));
}

function twoRuns(store) {
  const a = store.createRun('prompt one');
  const b = store.createRun('prompt two');
  return [a, b];
}

test('saveComparison writes the record with a null verdict slot and stamps both runs', () => {
  const store = makeProjectStore();
  const [a, b] = twoRuns(store);
  const rec = store.saveComparison({ runIds: [a, b], origin: 'launch' });

  assert.match(rec.id, /^cmp-/);
  assert.deepEqual(rec.runIds, [a, b]);
  assert.equal(rec.origin, 'launch');
  assert.equal(rec.verdict, null); // P3 lands the judge verdict here
  assert.ok(rec.createdAt);

  // The file is on disk under comparisons/, and both metas point at the group.
  const onDisk = JSON.parse(fs.readFileSync(store.comparisonPath(rec.id), 'utf8'));
  assert.deepEqual(onDisk, rec);
  assert.deepEqual(store.readMeta(a).compareGroup, { id: rec.id, label: 'A' });
  assert.deepEqual(store.readMeta(b).compareGroup, { id: rec.id, label: 'B' });

  assert.deepEqual(store.listComparisons(), [rec]);
});

test('saveComparison validates the pair and the origin', () => {
  const store = makeProjectStore();
  const [a] = twoRuns(store);
  assert.throws(() => store.saveComparison({ runIds: [a, a], origin: 'manual' }), /two distinct run ids/);
  assert.throws(() => store.saveComparison({ runIds: [a], origin: 'manual' }), /two distinct run ids/);
  assert.throws(() => store.saveComparison({ runIds: [a, ''], origin: 'manual' }), /two distinct run ids/);
  assert.throws(() => store.saveComparison({ runIds: [a, 'b'], origin: 'sweep' }), /Unknown comparison origin/);
});

test('an existing group stamp wins; update preserves createdAt and verdict', () => {
  const store = makeProjectStore();
  const [a, b] = twoRuns(store);
  const first = store.saveComparison({ runIds: [a, b], origin: 'launch' });
  const second = store.saveComparison({ runIds: [a, b], origin: 'manual' });
  // A different pairing gets its own id; the meta stamp stays with the first.
  assert.notEqual(first.id, second.id);
  assert.equal(store.readMeta(a).compareGroup.id, first.id);

  // Updating the same record (P3 will do this with a verdict) keeps history.
  const p = store.comparisonPath(first.id);
  const withVerdict = { ...first, verdict: { summary: 'A won' } };
  fs.writeFileSync(p, JSON.stringify(withVerdict));
  const updated = store.saveComparison({ id: first.id, runIds: [a, b], origin: 'launch' });
  assert.equal(updated.createdAt, first.createdAt);
  assert.deepEqual(updated.verdict, { summary: 'A won' });
});

test('listComparisons is newest-first and tolerates a missing dir; delete cleans up', () => {
  const store = makeProjectStore();
  assert.deepEqual(store.listComparisons(), []);
  const [a, b] = twoRuns(store);
  store.saveComparison({ runIds: [a, b], origin: 'manual' });
  store.deleteComparisonsFor(a);
  assert.deepEqual(store.listComparisons(), []);
});

// --- runner.start writes compareGroup into run meta -------------------------

function cmpFlow() {
  return makeFlow(
    [node('input', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'custom', title: 'Step' }),
     node('output', 'output')],
    [edge('input', 'step'), edge('step', 'output')]);
}

test('start() records compareGroup in meta when given, omits it otherwise', async () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new StackRunner(store, testConfig());

  const a = runner.start(cmpFlow(), { userInput: 'brief', compareGroup: { id: 'cmp-x', label: 'A' } });
  await waitForStage(store, a, ['done', 'failed']);
  assert.deepEqual(store.readMeta(a).compareGroup, { id: 'cmp-x', label: 'A' });

  const b = runner.start(cmpFlow(), { userInput: 'brief' });
  await waitForStage(store, b, ['done', 'failed']);
  assert.equal(store.readMeta(b).compareGroup, undefined);
});

test('start() normalizes a bogus label to A', async () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(cmpFlow(), { userInput: 'brief', compareGroup: { id: 'cmp-y', label: 'C' } });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.deepEqual(store.readMeta(runId).compareGroup, { id: 'cmp-y', label: 'A' });
});
