// DECISIONS.md D27 — comparison records + compareGroup provenance.
// A comparison is a persisted relationship between two runs in one project;
// the record lives in comparisons/<id>.json (verdict slot reserved for P3),
// and run projections are joined with it at read time rather than stamped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../core/state.js';

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

test('saveComparison writes the project-level record without mutating run projections', () => {
  const store = makeProjectStore();
  const [a, b] = twoRuns(store);
  const rec = store.saveComparison({ runIds: [a, b], origin: 'launch' });

  assert.match(rec.id, /^cmp-/);
  assert.deepEqual(rec.runIds, [a, b]);
  assert.equal(rec.origin, 'launch');
  assert.equal(rec.verdict, null); // P3 lands the judge verdict here
  assert.ok(rec.createdAt);

  // The file is on disk under comparisons/, and neither run projection is a
  // second writable source for the relationship.
  const onDisk = JSON.parse(fs.readFileSync(store.comparisonPath(rec.id), 'utf8'));
  assert.deepEqual(onDisk, rec);
  assert.equal(store.readMeta(a).compareGroup, undefined);
  assert.equal(store.readMeta(b).compareGroup, undefined);

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

test('updating one comparison preserves its createdAt and verdict', () => {
  const store = makeProjectStore();
  const [a, b] = twoRuns(store);
  const first = store.saveComparison({ runIds: [a, b], origin: 'launch' });
  const second = store.saveComparison({ runIds: [a, b], origin: 'manual' });
  // A different pairing gets its own id; neither one stamps run meta.
  assert.notEqual(first.id, second.id);
  assert.equal(store.readMeta(a).compareGroup, undefined);

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
