// Tool suites: the same fixed cases through several tools, measured.
//
// "Which scraper is better" deserves an answer somebody can argue with. The
// agent benchmark does not answer it — that one scores whether a TASK landed —
// and asking a model for its impression is not measurement. Nothing here calls
// a model or reaches the network: the executor is injected, so these exercise
// the judging and the arithmetic, which is where a comparison goes wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadToolSuite, runToolSuite, judge, textOf, renderToolCard } from '../core/toolbench.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-bench-'));

function suiteFile(body) {
  const file = path.join(tmp(), 'suite.json');
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

const SUITE = {
  name: 'readers',
  description: 'reading a page',
  tools: [
    { id: 'plain_fetch', as: 'plain', field: 'text' },
    { id: 'clever_fetch', as: 'clever', field: 'text', args: { mode: 'dynamic' } }
  ],
  cases: [
    { id: 'static', args: { url: 'https://example.com' }, expect: { contains: ['Example'], minChars: 10 } },
    { id: 'js', args: { url: 'https://example.com/js' }, expect: { contains: ['Einstein'] } }
  ]
};

test('a suite is validated as a whole, and says everything that is wrong with it', () => {
  assert.throws(() => loadToolSuite(suiteFile({ name: 'x' })), /no cases[\s\S]*no tools|no tools[\s\S]*no cases/);
  assert.throws(() => loadToolSuite(path.join(tmp(), 'nope.json')), /Could not read the suite/);
  const suite = loadToolSuite(suiteFile(SUITE));
  assert.equal(suite.cases.length, 2);
  assert.equal(suite.tools[1].as, 'clever');
});

// Tools that do the same job return different shapes, because they were written
// by different people for different reasons. A harness that demanded one shape
// could only compare tools somebody had already made comparable.
test('the text under judgement is found by field, by convention, or as a last resort', () => {
  assert.equal(textOf({ text: 'a' }, 'text'), 'a');
  assert.equal(textOf({ page: { body: 'nested' } }, 'page.body'), 'nested');
  assert.equal(textOf({ content: 'by convention' }), 'by convention');
  assert.match(textOf({ results: [{ title: 'one' }] }), /one/, 'a search result is its list');
  assert.match(textOf({ odd: 'shape' }), /odd/, 'crude, and honest about being crude');
});

test('per-tool args are the default and the case overrides them', async () => {
  const seen = [];
  await runToolSuite(loadToolSuite(suiteFile({
    ...SUITE,
    cases: [{ id: 'c', args: { url: 'u', mode: 'fetcher' }, expect: {} }]
  })), { call: (id, args) => { seen.push([id, args]); return { ok: true, ms: 1, result: { text: 'x' } }; } });
  assert.deepEqual(seen.find(([id]) => id === 'clever_fetch')[1], { mode: 'fetcher', url: 'u' },
    'the case is more specific than the tool default and must win');
});

// The distinction the whole thing rests on: a tool that is not set up here has
// not lost a comparison.
test('an unavailable tool is not a bad tool', () => {
  const kase = { expect: { contains: [], absent: [], minChars: 0, maxMs: 0 } };

  const notShipped = judge(kase, { ok: false, error: 'Unknown tool "scrape_page". Available: read_file', ms: 0 });
  assert.equal(notShipped.unavailable, true);
  assert.equal(notShipped.pass, false);

  const noPackage = judge(kase, { ok: true, ms: 5, result: { available: false, reason: 'scrapling is not installed' } });
  assert.equal(noPackage.unavailable, true);
  assert.match(noPackage.reasons[0], /scrapling is not installed/);

  const broke = judge(kase, { ok: false, error: 'connection reset', ms: 30 });
  assert.equal(broke.unavailable, undefined, 'a real failure is a real failure');
  assert.match(broke.reasons[0], /connection reset/);
});

test('every expectation in the case file is checked, and the reason names which failed', () => {
  const kase = { expect: { contains: ['Einstein'], absent: ['Cookie banner'], minChars: 100, maxMs: 50 } };
  const bad = judge(kase, { ok: true, ms: 900, result: { text: 'short. Cookie banner.' } }, 'text');
  assert.equal(bad.pass, false);
  assert.equal(bad.reasons.length, 4, 'all four, not the first one');
  assert.ok(bad.reasons.some(r => /at least 100/.test(r)));
  assert.ok(bad.reasons.some(r => /missing "Einstein"/.test(r)));
  assert.ok(bad.reasons.some(r => /should not contain "Cookie banner"/.test(r)));
  assert.ok(bad.reasons.some(r => /budget was 50ms/.test(r)));

  const good = judge(kase, { ok: true, ms: 10, result: { text: `Einstein ${'x'.repeat(200)}` } }, 'text');
  assert.deepEqual(good.reasons, []);
  assert.equal(good.pass, true);
});

test('a suite runs every tool against every case and totals them honestly', async () => {
  const suite = loadToolSuite(suiteFile(SUITE));
  const card = await runToolSuite(suite, {
    call: (id, args) => {
      if (id === 'plain_fetch') {
        return args.url.endsWith('/js')
          ? { ok: true, ms: 10, result: { text: 'an empty shell' } }
          : { ok: true, ms: 10, result: { text: 'Example Domain, at length' } };
      }
      return { ok: true, ms: 900, result: { text: 'Example Domain — and Einstein said so, at length' } };
    }
  });

  assert.equal(card.rows.length, 4);
  assert.equal(card.totals.plain.passed, 1, 'the plain fetch cannot run scripts');
  assert.equal(card.totals.clever.passed, 2);
  assert.equal(card.totals.plain.medianMs, 10);
  assert.equal(card.totals.clever.medianMs, 900, 'the slower tool must not be flattered by the total');

  const rendered = renderToolCard(card);
  assert.match(rendered, /plain\s+1\/2 passed/);
  assert.match(rendered, /what failed/);
  assert.match(rendered, /missing "Einstein"/);
});

// Averaging a zero from a failure in with real measurements would reward a tool
// for failing quickly and quietly.
test('median characters counts only the cases a tool actually passed', async () => {
  const card = await runToolSuite(loadToolSuite(suiteFile(SUITE)), {
    call: id => (id === 'plain_fetch'
      ? { ok: true, ms: 1, result: { text: '' } }
      : { ok: true, ms: 1, result: { text: `Example Einstein ${'x'.repeat(500)}` } })
  });
  assert.equal(card.totals.plain.medianChars, 0);
  assert.ok(card.totals.clever.medianChars > 500);
});
