// DECISIONS.md D27 — the comparison judge: verdict parsing (including the
// malformed/missing-JSON fallbacks), the record's verdict half, and the
// runner's blind compare-role call over two finished runs' outputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../core/state.js';
import { StackRunner } from '../core/stackRunner.js';
import { JUDGE_SYSTEM, buildJudgePrompt, parseJudgeVerdict } from '../core/judge.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

// A store whose comparisons/ dir lands inside the temp dir (sibling of runs/).
function makeProjectStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-judge-'));
  return new RunStore(path.join(dir, 'runs'));
}

// --- parseJudgeVerdict ------------------------------------------------------

const REPORT = '# Comparison\n\n## Agreements\nBoth fine.\n\n## Verdict\nA wins.';

test('a well-formed verdict parses into summary, winner, axes and notes', () => {
  const text = REPORT + '\n\n```json\n{ "winner": "A", "axes": { "correctness": "A", "completeness": "tie" }, "notes": "A is correct." }\n```';
  const v = parseJudgeVerdict(text);
  assert.equal(v.winner, 'A');
  assert.deepEqual(v.axes, { correctness: 'A', completeness: 'tie' });
  assert.equal(v.notes, 'A is correct.');
  // The summary is the report with the fence stripped — the JSON never renders.
  assert.equal(v.summary, REPORT);
});

test('tie and draw normalize; lowercase winners normalize', () => {
  assert.equal(parseJudgeVerdict('x ```json {"winner":"tie"} ```').winner, 'tie');
  assert.equal(parseJudgeVerdict('x ```json {"winner":"draw"} ```').winner, 'tie');
  assert.equal(parseJudgeVerdict('x ```json {"winner":"b"} ```').winner, 'B');
});

test('a missing JSON block degrades to summary-only with null fields', () => {
  const v = parseJudgeVerdict(REPORT);
  assert.equal(v.summary, REPORT);
  assert.equal(v.winner, null);
  assert.equal(v.axes, null);
  assert.equal(v.notes, null);
});

test('malformed JSON in the only fence degrades to summary-only', () => {
  const text = REPORT + '\n\n```json\n{ "winner": "A", broken \n```';
  const v = parseJudgeVerdict(text);
  assert.equal(v.winner, null);
  assert.equal(v.summary, text.trim()); // nothing stripped — no block was accepted
});

test('an invalid winner value drops to null but the block still parses', () => {
  const v = parseJudgeVerdict('report ```json {"winner":"C","notes":"unclear"} ```');
  assert.equal(v.winner, null);
  assert.equal(v.notes, 'unclear');
});

test('invalid axis entries are dropped; an all-invalid axes object becomes null', () => {
  const v = parseJudgeVerdict('report ```json {"winner":"B","axes":{"correctness":"B","style":"A wins","fit":"?"}} ```');
  assert.deepEqual(v.axes, { correctness: 'B' });
  const none = parseJudgeVerdict('report ```json {"winner":"B","axes":{"style":"?"}} ```');
  assert.equal(none.axes, null);
});

test('a non-verdict ```json fence earlier in the report is left alone', () => {
  // The judge quoted some code; the verdict block comes later and wins.
  const text = 'look: ```json {"foo":1}``` done\n\n```json\n{"winner":"B"}\n```';
  const v = parseJudgeVerdict(text);
  assert.equal(v.winner, 'B');
  assert.match(v.summary, /"foo":1/); // the quoted fence stays in the summary
});

test('a bare fence (no json tag) is accepted; junk input never throws', () => {
  assert.equal(parseJudgeVerdict('r ``` {"winner":"A"} ```').winner, 'A');
  assert.deepEqual(parseJudgeVerdict(''), { summary: '', winner: null, axes: null, notes: null });
  assert.deepEqual(parseJudgeVerdict(null), { summary: '', winner: null, axes: null, notes: null });
});

// --- buildJudgePrompt -------------------------------------------------------

test('buildJudgePrompt labels the alternatives and carries the original prompt', () => {
  const p = buildJudgePrompt({ prompt: 'fix the bug', alternatives: [{ label: 'A', text: 'aaa' }, { label: 'B', text: 'bbb' }] });
  assert.match(p, /ORIGINAL PROMPT:\nfix the bug/);
  assert.match(p, /ALTERNATIVE A:\naaa/);
  assert.match(p, /ALTERNATIVE B:\nbbb/);
});

test('buildJudgePrompt caps a huge alternative with a truncation marker', () => {
  const big = 'x'.repeat(25000);
  const p = buildJudgePrompt({ prompt: 'p', alternatives: [{ label: 'A', text: big }] });
  assert.match(p, /… \(truncated\)/);
  assert.ok(p.length < 25000 + 500);
});

test('the judge contract names the verdict JSON shape and stays blind', () => {
  assert.match(JUDGE_SYSTEM, /ROLE: compare-judge/);
  assert.match(JUDGE_SYSTEM, /"winner": "A" \| "B" \| "tie"/);
  assert.match(JUDGE_SYSTEM, /"axes"/);
  assert.match(JUDGE_SYSTEM, /"notes"/);
});

// --- store.saveComparisonVerdict --------------------------------------------

test('saveComparisonVerdict writes the verdict and re-judging replaces it', () => {
  const store = makeProjectStore();
  const a = store.createRun('p1');
  const b = store.createRun('p2');
  const rec = store.saveComparison({ runIds: [a, b], origin: 'launch' });

  const first = store.saveComparisonVerdict(rec.id, {
    summary: 'report one', winner: 'A', axes: { correctness: 'A' }, notes: 'A won',
    judgeModel: 'judge-1', at: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(first.verdict.summary, 'report one');
  assert.equal(first.verdict.winner, 'A');
  assert.deepEqual(first.verdict.axes, { correctness: 'A' });
  assert.equal(first.verdict.judgeModel, 'judge-1');
  // The rest of the record is untouched.
  assert.equal(first.createdAt, rec.createdAt);
  assert.equal(first.origin, 'launch');
  assert.deepEqual(first.runIds, [a, b]);

  const second = store.saveComparisonVerdict(rec.id, { summary: 'report two', winner: 'tie', judgeModel: 'judge-2' });
  assert.equal(second.verdict.summary, 'report two');
  assert.equal(second.verdict.winner, 'tie');
  assert.equal(second.verdict.judgeModel, 'judge-2');
  // Persisted, not just returned.
  const onDisk = JSON.parse(fs.readFileSync(store.comparisonPath(rec.id), 'utf8'));
  assert.equal(onDisk.verdict.winner, 'tie');
});

test('saveComparisonVerdict sanitizes junk and rejects an unknown record', () => {
  const store = makeProjectStore();
  const a = store.createRun('p1');
  const b = store.createRun('p2');
  const rec = store.saveComparison({ runIds: [a, b], origin: 'manual' });

  const v = store.saveComparisonVerdict(rec.id, {
    summary: 's', winner: 'C', axes: { ok: 'A', bad: 'maybe' }, judgeModel: '', extra: 'nope'
  });
  assert.equal(v.verdict.winner, null);
  assert.deepEqual(v.verdict.axes, { ok: 'A' });
  assert.equal(v.verdict.judgeModel, 'unknown');
  assert.equal(v.verdict.extra, undefined);
  assert.ok(v.verdict.at); // defaulted

  assert.throws(() => store.saveComparisonVerdict('cmp-nope', { summary: 's' }), /not found/);
});

// --- StackRunner.judgeComparison ----------------------------------------------

function judgeFlow() {
  return makeFlow(
    [node('input', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'custom', title: 'Step' }),
     node('output', 'output')],
    [edge('input', 'step'), edge('step', 'output')]);
}

async function settledPair(store, runner) {
  const a = runner.start(judgeFlow(), { userInput: 'brief' });
  const b = runner.start(judgeFlow(), { userInput: 'brief' });
  await waitForStage(store, a, ['done', 'failed']);
  await waitForStage(store, b, ['done', 'failed']);
  assert.equal(store.readMeta(a).stage, 'done');
  assert.equal(store.readMeta(b).stage, 'done');
  return [a, b];
}

const VERDICT_TEXT = '# Comparison\n\n## Verdict\nB is better.\n\n```json\n{ "winner": "B", "axes": { "correctness": "B", "completeness": "tie" }, "notes": "B nails it." }\n```';

test('judgeComparison runs the compare judge over both outputs and parses the verdict', async () => {
  const store = makeStore();
  const calls = [];
  setScript(call => {
    calls.push(call);
    return /compare-judge/.test(call.system) ? VERDICT_TEXT : 'work output';
  });
  const runner = new StackRunner(store, testConfig());
  const [a, b] = await settledPair(store, runner);

  const verdict = await runner.judgeComparison(a, b);
  assert.equal(verdict.winner, 'B');
  assert.deepEqual(verdict.axes, { correctness: 'B', completeness: 'tie' });
  assert.equal(verdict.notes, 'B nails it.');
  assert.equal(verdict.summary, '# Comparison\n\n## Verdict\nB is better.');
  assert.equal(verdict.judgeModel, 'test-model'); // default worker fallback
  assert.ok(verdict.at);

  // The judge call carried both final outputs under blind A/B labels.
  const judgeCall = calls.find(c => /compare-judge/.test(c.system));
  assert.match(judgeCall.prompt, /ALTERNATIVE A:\n/);
  assert.match(judgeCall.prompt, /ALTERNATIVE B:\n/);
  assert.match(judgeCall.prompt, /ORIGINAL PROMPT:\nbrief/);

  // Both runs' logs record the call, from either side.
  for (const [runId, other] of [[a, b], [b, a]]) {
    const events = store.readLog(runId).map(e => e.event);
    assert.ok(events.includes('compare_judge_start'));
    assert.ok(events.includes('compare_judged'));
    const judged = store.readLog(runId).find(e => e.event === 'compare_judged');
    assert.equal(judged.with, other);
    assert.equal(judged.winner, 'B');
  }
});

test('judgeComparison honors a configured judge model over the default worker', async () => {
  const store = makeStore();
  const models = [];
  setScript(call => {
    if (/compare-judge/.test(call.system)) { models.push(call.model); return VERDICT_TEXT; }
    return 'work output';
  });
  const config = testConfig({
    resolveModelSource: model => ({ provider: 'script', model, apiKey: null })
  });
  const runner = new StackRunner(store, config);
  const [a, b] = await settledPair(store, runner);

  const verdict = await runner.judgeComparison(a, b, { judgeModel: 'fancy-judge' });
  assert.deepEqual(models, ['fancy-judge']);
  assert.equal(verdict.judgeModel, 'fancy-judge');
});

test('judgeComparison refuses unsettled runs and runs without a final output', async () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new StackRunner(store, testConfig());
  const [a, b] = await settledPair(store, runner);

  const live = store.createRun('still going'); // meta has no terminal stage
  await assert.rejects(() => runner.judgeComparison(a, live), /hasn't settled/);
  await assert.rejects(() => runner.judgeComparison(a, 'run-nope'), /not found/);

  // A finished run whose output node never wrote has nothing to compare.
  const empty = store.createRun('empty');
  const meta = store.readMeta(empty);
  store.writeMeta(empty, { ...meta, stage: 'done' });
  store.writeFlow(empty, judgeFlow());
  await assert.rejects(() => runner.judgeComparison(a, empty), /no final output/);
});
