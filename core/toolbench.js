// Measuring one tool against another, on cases somebody wrote down.
//
// "Which scraper is better" is not a question a model should answer from its
// impressions, and it is not a question the agent benchmark answers either:
// that one scores whether a TASK landed (core/benchmark.js §12.1), which is a
// different axis entirely. This is the small deterministic thing in between —
// run the same fixed cases through several tools and print what happened.
//
// It is deliberately not clever. No model is called, nothing is judged, and the
// only opinions expressed are the ones written into the case file: what the
// result must contain, how much of it there should be, how long it may take.
// Everything else is measurement, and measurement is what makes a preference
// arguable instead of merely stated.
//
// A suite is one JSON file:
//
//   {
//     "name": "scrapers",
//     "description": "what this suite is actually asking",
//     "cases": [
//       { "id": "static", "url-ish args": ..., "expect": { "contains": ["Example Domain"], "minChars": 100 } }
//     ],
//     "tools": [
//       { "id": "web_fetch", "as": "builtin" },
//       { "id": "scrape_page", "as": "scrapling", "args": { "mode": "fetcher" } }
//     ]
//   }
//
// Per-tool `args` are merged UNDER the case's, so a suite can say "this tool
// needs mode: dynamic" without every case repeating it, and a case can still
// override. `field` names where the text to check lives in that tool's result
// when the tools disagree about their own shape — which they will, because they
// were written by different people for different reasons.
import fs from 'node:fs';
import path from 'node:path';

export const SUITE_DIR = path.join('benchmark', 'tools');

const str = v => (typeof v === 'string' ? v : '');
const list = v => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Read and validate a suite file. Throws with what is wrong, never a partial suite. */
export function loadToolSuite(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { throw new Error(`Could not read the suite at ${file}: ${err.message}`); }

  const problems = [];
  const cases = list(raw.cases).map((c, i) => {
    const id = str(c?.id).trim() || `case-${i + 1}`;
    if (!c?.args || typeof c.args !== 'object') problems.push(`case "${id}": needs an "args" object`);
    return {
      id,
      about: str(c?.about).trim(),
      args: c?.args ?? {},
      expect: {
        contains: list(c?.expect?.contains).map(String),
        absent: list(c?.expect?.absent).map(String),
        minChars: Number(c?.expect?.minChars) || 0,
        maxMs: Number(c?.expect?.maxMs) || 0
      }
    };
  });
  const tools = list(raw.tools).map((t, i) => {
    const id = str(t?.id).trim();
    if (!id) problems.push(`tools[${i}]: needs an "id"`);
    return { id, as: str(t?.as).trim() || id, args: t?.args ?? {}, field: str(t?.field).trim() || null };
  });

  if (!cases.length) problems.push('the suite declares no cases');
  if (!tools.length) problems.push('the suite names no tools');
  if (problems.length) throw new Error(`${file} is not a usable suite:\n- ${problems.join('\n- ')}`);

  return { name: str(raw.name).trim() || path.basename(file, '.json'), description: str(raw.description).trim(), cases, tools };
}

/**
 * The text a case's assertions are checked against.
 *
 * Tools that do the same job return different shapes, and a harness that
 * demanded one shape would only be able to compare tools somebody had already
 * made comparable. So: an explicit `field` when the suite names one, otherwise
 * the conventional text-bearing keys, otherwise the whole result serialized —
 * which is crude, and honest about being crude.
 */
export function textOf(result, field = null) {
  if (result == null) return '';
  if (field) {
    const found = field.split('.').reduce((v, k) => (v == null ? v : v[k]), result);
    return typeof found === 'string' ? found : JSON.stringify(found ?? '');
  }
  if (typeof result === 'string') return result;
  // A conventional key only counts when it has something in it. A refused page
  // comes back with `text: ''` beside a `status: 403` and a `challenge: true`,
  // and taking the empty string reported "returned 0 characters" about a result
  // that had told the caller exactly what happened.
  for (const key of ['text', 'content', 'markdown', 'body']) {
    if (typeof result[key] === 'string' && result[key].length) return result[key];
  }
  // A search-shaped result: the answer is the list, not a field on it.
  if (Array.isArray(result.results)) return JSON.stringify(result.results);
  return JSON.stringify(result);
}

/** Judge one result against one case. Pure, so it is testable without a tool. */
export function judge(kase, record, field = null) {
  const reasons = [];
  if (!record.ok) {
    // A tool this build does not ship is not a tool that performed badly. A
    // suite naming next month's tool alongside this month's should read as
    // "one of these is not here yet", not as a clean sweep for the incumbent.
    if (/^Unknown tool/.test(String(record.error ?? ''))) {
      return { pass: false, unavailable: true, chars: 0, reasons: ["not in this build's tool library"] };
    }
    // A THROW is still an answer, and for "what does this do when the page says
    // no" it is the only answer there is. So the expectations are checked
    // against the error text: a tool that names the status in its message has
    // told the caller something actionable, and one that says "request failed"
    // has not. The failure is still recorded — this is not a way to pass by
    // crashing informatively — but `contains` gets its say.
    // Judge what the tool SAID, not the echo of what it was given. Every one of
    // these messages quotes the URL back, and `httpbin.org/status/403` contains
    // "403" — so a tool whose whole answer was "could not fetch <url>" scored
    // as having reported the status. An expectation satisfied only by the echo
    // of the input is not satisfied.
    const echoed = Object.values(record.args ?? kase.args ?? {}).filter(v => typeof v === 'string');
    const said = echoed.reduce((text, value) => text.split(value).join(' '), String(record.error ?? ''));
    const missing = kase.expect.contains.filter(n => !said.toLowerCase().includes(String(n).toLowerCase()));
    return {
      pass: false, chars: 0, threw: true,
      reasons: [`the call threw: ${said || 'no reason given'}`,
        ...(kase.expect.contains.length
          ? [missing.length ? `and the message does not name ${missing.join(', ')}` : 'though the message does name what was expected']
          : [])]
    };
  }
  // A tool that reports its own unavailability is neither a pass nor a crash:
  // it is a machine that is not set up, and saying so is the whole point of
  // that convention (TOOLS.md). It must never read as a quality difference.
  if (record.result?.available === false) {
    return {
      pass: false, unavailable: true, chars: 0,
      reasons: [`unavailable here: ${record.result.reason ?? 'no reason given'}`]
    };
  }
  const text = textOf(record.result, field);
  const chars = text.length;
  if (kase.expect.minChars && chars < kase.expect.minChars) {
    reasons.push(`returned ${chars} characters, wanted at least ${kase.expect.minChars}`);
  }
  for (const needle of kase.expect.contains) {
    if (!text.toLowerCase().includes(needle.toLowerCase())) reasons.push(`missing "${needle}"`);
  }
  for (const needle of kase.expect.absent) {
    if (text.toLowerCase().includes(needle.toLowerCase())) reasons.push(`should not contain "${needle}"`);
  }
  if (kase.expect.maxMs && record.ms > kase.expect.maxMs) {
    reasons.push(`took ${record.ms}ms, budget was ${kase.expect.maxMs}ms`);
  }
  return { pass: reasons.length === 0, chars, reasons };
}

/**
 * Run every tool against every case.
 *
 * `call(id, args)` is injected rather than imported so this module never
 * decides what a tool call means — the API command passes its own executor, and
 * a test passes a stub. Sequential on purpose: these cases reach the network,
 * and a parallel run measures contention rather than the tool.
 */
export async function runToolSuite(suite, { call, onProgress = () => {} } = {}) {
  const started = Date.now();
  const rows = [];
  for (const kase of suite.cases) {
    for (const tool of suite.tools) {
      const args = { ...tool.args, ...kase.args };
      onProgress({ case: kase.id, tool: tool.as });
      let record;
      try { record = await call(tool.id, args); }
      catch (err) { record = { ok: false, error: String(err?.message ?? err), ms: 0 }; }
      // The arguments travel with the record so `judge` can tell what a tool
      // said from what it was given.
      const verdict = judge({ ...kase, args }, record, tool.field);
      rows.push({
        case: kase.id, tool: tool.as, toolId: tool.id,
        ok: Boolean(record.ok), ms: record.ms ?? 0,
        ...verdict
      });
    }
  }
  return { suite: suite.name, description: suite.description, at: new Date().toISOString(), ms: Date.now() - started, rows, totals: totalsFor(suite, rows) };
}

function totalsFor(suite, rows) {
  const out = {};
  for (const tool of suite.tools) {
    const mine = rows.filter(r => r.tool === tool.as);
    const passed = mine.filter(r => r.pass);
    out[tool.as] = {
      tool: tool.id,
      passed: passed.length,
      cases: mine.length,
      unavailable: mine.filter(r => r.unavailable).length,
      // Median, not mean: one 30-second browser launch should not decide what
      // "typical" means for a tool that is otherwise fast.
      medianMs: median(mine.map(r => r.ms)),
      totalMs: mine.reduce((n, r) => n + r.ms, 0),
      // Only over the cases it actually passed — averaging in the zero from a
      // failure would reward a tool for failing quietly.
      medianChars: median(passed.map(r => r.chars))
    };
  }
  return out;
}

const median = xs => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/** The card as a person reads it. */
export function renderToolCard(card) {
  const names = Object.keys(card.totals);
  const width = Math.max(6, ...card.rows.map(r => r.case.length));
  const lines = [`# ${card.suite}`];
  if (card.description) lines.push('', card.description);
  lines.push('', `${'case'.padEnd(width)}  ${names.map(n => n.padEnd(16)).join('')}`);

  for (const id of [...new Set(card.rows.map(r => r.case))]) {
    const cells = names.map(n => {
      const r = card.rows.find(x => x.case === id && x.tool === n);
      if (!r) return '—'.padEnd(16);
      const mark = r.unavailable ? '·' : r.pass ? '✓' : '✗';
      return `${mark} ${r.ms}ms ${r.pass ? `${r.chars}c` : ''}`.padEnd(16);
    });
    lines.push(`${id.padEnd(width)}  ${cells.join('')}`);
  }

  lines.push('', 'totals');
  for (const [name, t] of Object.entries(card.totals)) {
    lines.push(`  ${name.padEnd(width)}  ${t.passed}/${t.cases} passed, median ${t.medianMs}ms, median ${t.medianChars} chars`
      + (t.unavailable ? `, ${t.unavailable} unavailable here` : ''));
  }

  // The failures are the interesting half, and a table of ticks hides them.
  const failed = card.rows.filter(r => !r.pass && !r.unavailable);
  if (failed.length) {
    lines.push('', 'what failed');
    for (const r of failed) lines.push(`  ${r.tool} / ${r.case}: ${r.reasons.join('; ')}`);
  }
  const unavailable = card.rows.filter(r => r.unavailable);
  if (unavailable.length) {
    lines.push('', 'not set up here (not a quality difference)');
    for (const r of [...new Map(unavailable.map(r => [r.tool, r])).values()]) {
      lines.push(`  ${r.tool}: ${r.reasons.join('; ')}`);
    }
  }
  return lines.join('\n');
}
