// Is the work salvageable, or is it too far gone? (DESIGN-SPEC.md §8)
//
// A task that fails its gates has, up to that moment, done everything the loop
// asked of it: it read the repository, wrote the code, and committed. Then one
// assertion goes red and the whole attempt is pushed up a band for a dearer
// model to write again.
//
// Watched it: t-0037 spent $1.4964 across 40 calls, `npm test` exited 1, and
// the loop escalated. The next band re-read the same files, re-derived the same
// design, and produced a diff that differed from the first mostly in wording.
// The money bought the same work twice and the second copy was not better, only
// dearer. The failing assertion, meanwhile, was a few lines in one test file.
//
// So a red gate asks a question before it spends a rung: is there work here
// worth correcting? The judgement is MECHANICAL — the failing tests are named
// in the gate's own output, and whether they sit in files this change touched
// is a set intersection, not an opinion. A model is not asked to adjudicate
// something the output already settles (§7.3), and nothing here costs a call.
//
// Two ways to answer:
//
//   repair   — the failures are few, they are about this change, and the work
//              underneath them is real. Hand the failures back as feedback and
//              let the SAME band correct them in place. No rung is spent.
//   escalate — the corrections are not landing, the change broke things it
//              never touched, or there is nothing underneath to correct. The
//              existing ladder takes it from here, work still attached.
//
// The bound matters as much as the mechanism. "Give it another go" with no
// ceiling is a task that corrects itself forever on a failure it cannot see, so
// every path out of here either makes progress or runs out.
import crypto from 'node:crypto';

/**
 * How many corrections one body of work gets before the ladder takes over.
 *
 * Two, because the first correction catches the ordinary case — a stale pinned
 * list, an unhandled null, an import that moved — and a second catches the one
 * the first uncovered. A third that is still failing the same way is not a
 * correction, it is a model that cannot see the problem, and more of it is the
 * expensive way to find that out.
 */
export const MAX_REPAIRS = 2;

/**
 * The hard ceiling when corrections ARE working.
 *
 * A run that goes from nine failures to four to one is fixing them, and cutting
 * it off at two would throw away the answer one attempt before it arrived. So
 * strict progress buys more rope — but not unlimited rope, because "fewer
 * failures than last time" can also describe a change that is slowly deleting
 * the suite.
 */
export const REPAIR_CEILING = 4;

/**
 * When a failure count stops being "this change is broken" and starts being
 * "this change broke the repository".
 *
 * Ten is not a magic number; it is well above what a normal regression in one
 * area produces and well below a suite-wide collapse. It only decides anything
 * in combination with scope: ten failures in files the change touched is a bad
 * afternoon, and ten in files it never opened is a different event.
 */
export const BROAD_FAILURES = 10;

// How far under a `not ok` line the YAML block can run before we stop reading.
// A node --test failure block is the assertion, the diff and a stack; forty
// lines reaches the useful part without swallowing the next test.
const BLOCK_LINES = 40;

// Aggregate failures, not failures. `node --test` fails the FILE when a subtest
// in it fails, so every real failure arrives twice — once as itself and once as
// the file that contains it. Counting both doubles every number here and turns
// five failures into "broad breakage".
const AGGREGATE = /^(?:subtestsFailed|testAggregateFailure)$/;

/**
 * A path a set of these can be compared against: forward slashes, no `./`.
 *
 * The doubled-separator collapse is not tidiness. A Windows path inside TAP
 * arrives escaped — `location: 'C:\\Users\\Olav\\...'` — so the text really
 * does hold two backslashes, and a naive swap turns them into `C://Users//`,
 * which matches nothing and reads as a typo in every log line.
 */
const normalizePath = p => String(p ?? '')
  .replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '').trim();

/** The file part of a TAP `location: 'tests/foo.test.js:75:1'`. */
function fileOf(location) {
  if (!location) return null;
  const cleaned = normalizePath(location);
  const m = /^(.*?):\d+(?::\d+)?$/.exec(cleaned);
  return (m ? m[1] : cleaned) || null;
}

/** The `:75` off the end of a location, for a line worth naming. */
function lineOf(location) {
  const m = /:(\d+)(?::\d+)?$/.exec(normalizePath(location));
  return m ? m[1] : null;
}

/**
 * Say where a failure is the way the REPOSITORY says it.
 *
 * A gate runs inside a worktree, so `node --test` reports
 * `C:/Users/…/.flyt/worktrees/<project>-<hash>/t-0037/tests/phase2.test.js`
 * while the diff is a list of repo-relative paths like `tests/phase2.test.js`.
 * Compared as strings those never intersect — so every failure looked as though
 * it were outside the change, every scope came back `broad`, and the one signal
 * that separates "this change broke itself" from "this change broke the
 * repository" was answering `broad` to both.
 *
 * Matching on the tail fixes it without teaching this module where worktrees
 * live: a changed file matches when the failure's path ends with it at a
 * segment boundary. The relative form then REPLACES the absolute one, so the
 * fingerprint is stable across worktrees and the log line is readable.
 */
export function relativize(failures = [], changedFiles = []) {
  const changed = changedFiles.map(normalizePath).filter(Boolean);
  const match = norm => changed.find(c => norm === c || norm.endsWith(`/${c}`));

  // Where the gate ran, learned from any one failure that IS in the diff. One
  // match teaches the prefix for all of them — including the failures OUTSIDE
  // the change, which are the ones a reader most needs spelled the normal way,
  // because they are the evidence that the blast radius is wider than the diff.
  let root = null;
  for (const f of failures) {
    if (!f.file) continue;
    const norm = normalizePath(f.file);
    const hit = match(norm);
    if (hit && norm !== hit) { root = norm.slice(0, norm.length - hit.length); break; }
  }

  return failures.map(f => {
    if (!f.file) return f;
    const norm = normalizePath(f.file);
    const hit = match(norm);
    if (hit) return { ...f, file: hit };
    if (root && norm.startsWith(root)) return { ...f, file: norm.slice(root.length) };
    // Nothing to anchor against: keep the tail rather than a machine name, a
    // project hash and a task id nobody reading a log needs.
    const tail = norm.split('/');
    return { ...f, file: tail.length > 3 ? tail.slice(-3).join('/') : norm };
  });
}

// The first line of a TAP block's `error: |-` body, which is the sentence a
// person would read out. Falls back to a bare `error: '...'` for the runners
// that inline it.
function errorLine(block) {
  // `$` is deliberately NOT used to close this: under /m — which `^` needs —
  // it matches at every line end, so the lazy capture stopped after the FIRST
  // line of the error and `assert.equal`'s header travelled without the
  // comparison under it. `(?![\s\S])` is the real end of the string.
  const multi = /^[ \t]*error:[ \t]*\|-?[ \t]*\n([\s\S]*?)(?=\n[ \t]*(?:code|stack|failureType|expected|actual):|\n[ \t]*\.\.\.|(?![\s\S]))/m.exec(block);
  if (multi) {
    const body = multi[1].split('\n').map(s => s.trim()).filter(Boolean);
    // `assert.equal` opens with a header and puts the comparison on the line
    // after it: "Expected values to be strictly equal:" then "3 !== 4". The
    // header alone names no value and is the same sentence for every such
    // failure, so a line ending in a colon takes the next one with it.
    if (body[0]?.endsWith(':') && body[1]) return `${body[0]} ${body[1]}`;
    if (body[0]) return body[0];
  }
  const inline = /^[ \t]*error:[ \t]*'([^']*)'/m.exec(block) ?? /^[ \t]*error:[ \t]*"([^"]*)"/m.exec(block);
  return inline ? inline[1] : null;
}

// Error shapes that arrive without TAP around them: a build, a linter, a
// compiler, or a suite that died before it could report.
const BARE = [
  [/^\s*(?:.*\s)?error TS(\d+):\s*(.+)$/, m => ({ name: `TS${m[1]}`, detail: m[2].trim() })],
  [/\bCannot find module\s+'([^']+)'/, m => ({ name: `Cannot find module '${m[1]}'`, detail: null })],
  [/^\s*(SyntaxError|TypeError|ReferenceError|RangeError|AssertionError):\s*(.+)$/,
    m => ({ name: `${m[1]}: ${m[2].trim()}`, detail: null })],
  // eslint: `  12:3  error  Something is wrong  rule/name`
  [/^\s*\d+:\d+\s+error\s+(.+?)(?:\s{2,}[\w@/-]+)?\s*$/, m => ({ name: m[1].trim(), detail: null })]
];

/**
 * The failures a gate's output names, as things rather than as text.
 *
 * TAP first, because `npm test` is `node --test` and TAP says where the failure
 * was — which is the half that decides whether this change caused it. When
 * there is no TAP at all the bare shapes are scanned instead: a suite that died
 * on a syntax error never reaches `not ok`, and "the output named nothing" and
 * "the output named a SyntaxError" call for different answers.
 *
 * @param output — the gate's (already bounded) output.
 * @returns `[{ name, location, file, code, detail }]`, deduplicated.
 */
export function readFailures(output) {
  const lines = String(output ?? '').split('\n');
  const tap = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const block = [];
    for (let j = i + 1; j < lines.length && j - i <= BLOCK_LINES; j++) {
      const line = lines[j];
      if (!line.trim()) { block.push(line); continue; }
      if (line.length - line.trimStart().length <= indent) break;
      block.push(line);
    }
    const text = block.join('\n');
    // The file that contains a failure is not a second failure.
    if (AGGREGATE.test(/failureType:\s*'([^']+)'/.exec(text)?.[1] ?? '')) continue;
    const location = /location:\s*'([^']+)'/.exec(text)?.[1] ?? null;
    tap.push({
      name: m[2].trim(),
      location,
      file: fileOf(location),
      code: /code:\s*'([^']+)'/.exec(text)?.[1] ?? null,
      detail: errorLine(text)
    });
  }
  if (tap.length) return dedupe(tap);

  const bare = [];
  for (const line of lines) {
    for (const [re, build] of BARE) {
      const m = re.exec(line);
      if (!m) continue;
      bare.push({ location: null, file: null, code: null, detail: null, ...build(m) });
      break;
    }
  }
  return dedupe(bare);
}

// Same test, same place, once. A retried test and a test reported by two
// reporters are one failure to fix.
function dedupe(failures) {
  const seen = new Map();
  for (const f of failures) {
    const key = `${f.file ?? ''}|${f.name}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

/**
 * What KIND of failure this is, in the vocabulary a next attempt can act on.
 *
 * Not a severity. `syntax` is trivially fixable and `assertion` may be the
 * hardest thing in the repository; the kind is here so the feedback can say
 * what it is looking at, and so a log line reads as something other than
 * "the gate failed".
 */
export function classify(failure = {}) {
  const text = `${failure.code ?? ''} ${failure.name ?? ''} ${failure.detail ?? ''}`;
  if (/ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND/.test(text)) return 'missing-module';
  if (/SyntaxError/.test(text)) return 'syntax';
  if (/(?:^|\s)TS\d+|error TS\d+/.test(text)) return 'types';
  if (/ERR_ASSERTION|AssertionError/.test(text)) return 'assertion';
  if (/TypeError|ReferenceError|RangeError/.test(text)) return 'runtime-error';
  if (/ERR_TEST_FAILURE/.test(text)) return 'assertion';
  return 'unknown';
}

/**
 * A fingerprint of WHICH failures these are, so an identical repeat is visible.
 *
 * Identity only — the test's name and where it lives. Not the message, which
 * carries timings and object dumps that differ run to run, and not the count,
 * which is compared separately. Two runs with the same signature failed in
 * exactly the same places, and a correction that produced one has corrected
 * nothing.
 */
export function failureSignature(failures = []) {
  if (!failures.length) return null;
  const parts = failures.map(f => `${f.file ?? ''}::${f.name}`).sort();
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Are these failures about the change, or about the rest of the repository?
 *
 * `local` means every failure we could place sits in a file this change
 * touched: the change broke its own work, which is the ordinary correctable
 * case. `broad` means most of them are elsewhere — the change moved something
 * the repository depends on, and the blast radius is larger than the diff.
 * `unknown` when the output never said where anything was; the honest answer,
 * and it deliberately does not count as evidence in either direction.
 */
export function scopeOf(failures = [], changedFiles = []) {
  const placed = failures.map(f => f.file).filter(Boolean).map(normalizePath);
  if (!placed.length) return 'unknown';
  const changed = new Set(changedFiles.map(normalizePath));
  const inside = placed.filter(f => changed.has(f)).length;
  if (inside === placed.length) return 'local';
  return inside * 2 >= placed.length ? 'mixed' : 'broad';
}

/**
 * Should this red gate be corrected in place, or handed to the ladder?
 *
 * Everything it needs is already on disk: the gate result, the diff, and what
 * the task recorded about its last correction. No call, no clock.
 *
 * @param opts.failure       — the failing gate, from `runGates`.
 * @param opts.changedFiles  — what this attempt actually changed.
 * @param opts.repairs       — corrections already spent on this body of work.
 * @param opts.lastSignature — the fingerprint the previous correction faced.
 * @param opts.lastCount     — how many failures the previous correction faced.
 * @param opts.maxRepairs    — the budget, for a project that wants a different one.
 * @returns a verdict, why, and the feedback the next attempt is handed.
 */
export function assessRepair({
  failure = null,
  changedFiles = [],
  repairs = 0,
  lastSignature = null,
  lastCount = null,
  maxRepairs = MAX_REPAIRS
} = {}) {
  const spent = Math.max(0, Number(repairs) || 0);

  // Defensive: a red gate run with no failing gate in it is a bug in the
  // caller, and guessing at what went wrong is worse than saying so.
  if (!failure) {
    return verdict('escalate', 'The gates did not pass and did not say which one.', {
      failures: [], signature: null, scope: 'unknown', count: 0, kind: 'unknown',
      spent, budget: maxRepairs, failure: null
    });
  }

  // A HANG is not a failing assertion. There is no output naming what stopped,
  // so a correction is a guess — worth one, because the usual cause is a handle
  // this very change left open and the agent knows what it opened. Not worth
  // two: the second guess has no more to go on than the first.
  if (failure.status === 'timeout') {
    const base = {
      failures: [], signature: `timeout:${failure.command}`, scope: 'unknown', count: 0,
      spent, budget: 1, kind: 'timeout', failure
    };
    return spent >= 1
      ? verdict('escalate', `\`${failure.command}\` still hangs after a correction. `
        + 'Finding what blocks is not something another try at this band will do.', base)
      : verdict('repair', `\`${failure.command}\` hung rather than failed — one correction to find what blocks.`, base);
  }

  // Relativized BEFORE anything is computed from it: the fingerprint, the
  // scope and every printed line all want the repository's own spelling.
  const failures = relativize(readFailures(failure.output), changedFiles);
  const signature = failureSignature(failures);
  const scope = scopeOf(failures, changedFiles);
  const count = failures.length;
  const kind = dominantKind(failures);
  const base = { failures, signature, scope, count, kind, spent, budget: maxRepairs, failure };

  // Nothing to salvage. A red gate over an empty diff is the base branch's
  // problem or the run's absence, and neither is corrected by asking this
  // attempt to try again — there is no "this attempt" to correct.
  if (!changedFiles.length) {
    return verdict('escalate', 'The gates are red and this attempt changed no file, '
      + 'so there is no work here to correct.', base);
  }

  // The same failures, after a correction aimed at them. The feedback reached
  // the model and the model could not act on it; a third copy of the same
  // sentence is not new information. This is the check that stops a correction
  // loop being a loop.
  if (spent > 0 && signature && lastSignature && signature === lastSignature) {
    return verdict('escalate', `The same ${plural(count, 'failure')} as before the last correction`
      + ' — the feedback is not landing, so more of it will not help.', base);
  }

  // Corrections that are WORKING buy more rope. Nine failures becoming four is
  // a model converging, and cutting it off one attempt from green is the same
  // waste this whole module exists to stop.
  const progressing = lastCount != null && count > 0 && count < lastCount;
  const budget = progressing ? Math.max(maxRepairs, REPAIR_CEILING) : maxRepairs;
  base.budget = budget;
  base.progressing = progressing;
  if (spent >= budget) {
    return verdict('escalate', `${plural(spent, 'correction')} did not get \`${failure.command}\` green.`, base);
  }

  // The change broke things it never touched, at scale. That is not a stale
  // assertion to update; it is a design that does not hold, and correcting it
  // in place asks a model that already got it wrong to see why.
  if (count >= BROAD_FAILURES && scope === 'broad') {
    return verdict('escalate', `${plural(count, 'failure')} across the suite, mostly in files this `
      + 'change never touched — the breakage is wider than the diff.', base);
  }

  return verdict('repair', count
    ? `${plural(count, 'failure')}${scope === 'local' ? ', all in files this change touched' : ''}`
      + ' — the work stands, the failures go back as feedback.'
    : `\`${failure.command}\` exited ${failure.code} without naming a failure — one correction to read it properly.`,
  base);
}

function verdict(kind, reason, base) {
  const result = { verdict: kind, reason, ...base };
  result.feedback = kind === 'repair' ? repairFeedback(result) : escalationNote(result);
  return result;
}

function dominantKind(failures) {
  if (!failures.length) return 'unknown';
  const counts = new Map();
  for (const f of failures) {
    const k = classify(f);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // A known kind beats `unknown` even when unknown is commoner: "three
  // assertions and four things we could not name" is best described as
  // assertions, which is the half somebody can act on.
  const ranked = [...counts].sort((a, b) =>
    (a[0] === 'unknown' ? 1 : 0) - (b[0] === 'unknown' ? 1 : 0) || b[1] - a[1]);
  return ranked[0][0];
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One failure, as a line somebody can read in a log without opening anything. */
export function failureLine(f) {
  // `f.file` and not `f.location`: the file has been relativized, the location
  // is still whatever the runner printed, and an absolute worktree path is not
  // a place a reader can go.
  const line = lineOf(f.location);
  const where = f.file ? `${f.file}${line ? `:${line}` : ''} — ` : '';
  const detail = f.detail && f.detail !== f.name ? ` (${trim(f.detail, 90)})` : '';
  return `${where}${trim(f.name, 110)}${detail}`;
}

const trim = (s, n) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

/**
 * How much raw gate output travels with the task, and when.
 *
 * None of it, normally. This text becomes the task's `blockedReason`, and that
 * field is not a scratch buffer: it is written into YAML frontmatter, read back
 * on every `task:list` (which the Loop view polls every three seconds), shown
 * on the board, and quoted in the archive. The old guidance pasted the gate's
 * whole bounded output — up to twenty thousand characters — into all of that.
 *
 * It is also not needed. The failures are already extracted above by name,
 * place and assertion, which is the part the `clip()` in gates.js goes to such
 * lengths to preserve; and the attempt reading this is standing in the worktree
 * with the work checked out and is told to run the gate itself, so the full
 * transcript is a command away rather than a field away.
 *
 * The exception is a gate whose output named nothing we could parse. Then the
 * raw text is the only evidence there is, and a bounded tail of it — where the
 * summary and the last thing to run both live — travels instead.
 */
const RAW_TAIL = 1_500;
function rawEvidence(failure, failures) {
  const output = String(failure?.output ?? '');
  if (failures.length || !output.trim()) return [];
  const tail = output.length > RAW_TAIL ? `…${output.slice(-RAW_TAIL)}` : output;
  return ['', 'The gate named no failure this could read. The end of its output:', tail];
}

/**
 * What the correcting attempt is told.
 *
 * The shape matters more than the words. It has to say, in this order: the work
 * is still here, here is exactly what is red, fix THAT and nothing else, and do
 * not take the cheap exit. An attempt that reads this and starts over has
 * understood none of it, so the first line is the one that says not to.
 */
export function repairFeedback(assessment) {
  const { failure, failures = [], scope, spent = 0, budget = MAX_REPAIRS, progressing, reason } = assessment;
  const remaining = Math.max(0, budget - spent);
  const out = [
    // A summary sentence FIRST, because this text has two readers. It becomes
    // the task's `blockedReason`, and the board's collapsed card shows the
    // first line of that as its one-line explanation of why the task is not
    // moving. A card whose line reads "YOUR PREVIOUS ATTEMPT IS HERE AND ITS
    // GATES ARE RED." is shouting an instruction at somebody who is not the
    // one being instructed.
    // Some reasons already open with the gate's name ("`npm test` hung…"), so
    // prefixing those would say it twice.
    String(reason ?? '').startsWith('`') ? reason : `\`${failure?.command ?? 'The gate'}\` failed: ${reason}`,
    '',
    'YOUR PREVIOUS ATTEMPT IS HERE AND ITS GATES ARE RED.',
    '',
    'The work is not being thrown away and you are not starting over. It is committed in this'
      + ' worktree — read it with `git show HEAD` and `git diff HEAD~1`. What follows is the only'
      + ' thing standing between it and landing.'
  ];

  if (failure?.status === 'timeout') {
    out.push('',
      `\`${failure.command}\` did not fail — it HUNG, and was killed after ${Math.round((failure.ms ?? 0) / 1000)}s.`,
      'Something your change started does not finish: an open handle, an unresolved promise, a',
      'listener nobody closes, a watcher nobody stops. Find it in what you changed. Raising the',
      'timeout is not a fix, and the gate will be run again at the same one.');
  } else {
    out.push('', `\`${failure?.command ?? 'the gate'}\` failed (exit ${failure?.code ?? '?'}).`);
    if (failures.length) {
      out.push('', `${plural(failures.length, 'failure')}:`, '');
      out.push(...failures.slice(0, 12).map((f, i) => `  ${i + 1}. ${failureLine(f)}`));
      if (failures.length > 12) out.push(`  …and ${failures.length - 12} more in the output below.`);
      if (scope === 'local') {
        out.push('', 'Every one of them is in a file this change touched, so this is your own work'
          + ' disagreeing with itself rather than something else breaking.');
      } else if (scope === 'broad' || scope === 'mixed') {
        out.push('', 'Some of them are in files this change never touched — something you moved or'
          + ' renamed is depended on elsewhere. Follow the callers before you change the tests.');
      }
    }
    out.push(...rawEvidence(failure, failures));
    out.push('', `Run \`${failure?.command ?? 'the gate'}\` yourself to see the whole thing — you are`
      + ' standing in the worktree it was run in.');
  }

  out.push('',
    'FIX EXACTLY THAT.',
    '',
    '- Do not rewrite the parts nobody objected to. They are the reason this attempt was kept.',
    '- Do not delete, skip or weaken a test to go green. The harness counts tests before and after,'
      + ' and a suite that passed by getting smaller is rejected outright.',
    '- Do not widen the change to something the task did not ask for.',
    '- Run the gate yourself before you finish. `bash` reports a non-zero exit as data, so read the'
      + ' exit code — the harness will, and its reading is the one that counts.');

  out.push('',
    remaining > 1
      ? `This is correction ${spent + 1}; ${remaining - 1} more follow${remaining - 1 === 1 ? 's' : ''} it`
        + ' before the task goes to a stronger model or to a person.'
      : 'This is the LAST correction at this level. If the gate is still red after it, the task'
        + ' leaves this model.');
  if (progressing) {
    out.push('The previous correction did reduce the failures, which is why there is another one.');
  }
  return out.join('\n');
}

/**
 * What the ladder is told when the work is past correcting.
 *
 * Still specific. A task climbing a band with "the gates failed" attached tells
 * the dearer model nothing it would not have found out for itself, and the
 * whole point of escalating with the work preserved is that the next model
 * starts where this one stopped.
 */
export function escalationNote(assessment) {
  const { failure, failures = [], reason, spent = 0 } = assessment;
  const out = [`The gate \`${failure?.command ?? '?'}\` `
    + (failure?.status === 'timeout'
      ? `timed out after ${failure.ms}ms.`
      : `failed (exit ${failure?.code ?? '?'}).`)];
  if (spent > 0) out.push(`${plural(spent, 'correction')} at the previous level did not clear it.`);
  if (reason) out.push(reason);
  if (failures.length) {
    out.push('', 'What is red:', ...failures.slice(0, 12).map((f, i) => `  ${i + 1}. ${failureLine(f)}`));
    if (failures.length > 12) out.push(`  …and ${failures.length - 12} more.`);
  }
  out.push(...rawEvidence(failure, failures));
  return out.join('\n');
}

/**
 * Did this run fail because the work never reached the workspace?
 *
 * `core/effect.js` already makes this judgement and makes it well: a block with
 * a `workspace-change` contract that produced no change fails the run rather
 * than recording a completion. The supervisor then read the failed run as a
 * generic failure — "The run itself failed." — and spent a rung of the ladder
 * on it.
 *
 * That is a rung bought with a diagnosis. The model did not lack capability; it
 * answered in prose and never wrote a file, and a dearer model asked the same
 * question mostly answers the same way. Watched t-0013 spend SEVEN attempts and
 * t-0033 three, every one escalating on that sentence, while the run meta said
 * exactly what went wrong.
 *
 * Two shapes, because they need different answers: nothing was written at all,
 * or things were written outside what the task said it would touch.
 *
 * @param error — the run's recorded error.
 * @returns `{ reason, outOfScope }`, or null when this is some other failure.
 */
export function effectMissing(error) {
  const s = String(error ?? '');
  if (!s) return null;
  // Greedy to the last `)` on the line, because the detail itself contains
  // parentheses — "3 file(s) changed outside this task's scope" — and a lazy
  // match stops at the one inside `file(s)`.
  const m = /required (workspace change|artifact) was not produced(?:\s*\(([^\n]*)\))?/i.exec(s);
  if (!m) return null;
  return { reason: m[0], kind: m[1], outOfScope: m[2] ?? null };
}

/**
 * What an attempt that produced nothing is told.
 *
 * `landTask` says this well already for an empty diff, and this is the same
 * situation reached one step earlier — the effect contract catches it before
 * the landing sequence ever runs, so the good sentence was unreachable for
 * exactly the tasks that needed it. One definition, both callers.
 */
export const NO_CHANGE_GUIDANCE =
  'The task produced no change to the repository at all. If its deliverable is a '
  + 'file, write it into the workspace — an answer that exists only in the run\'s own output '
  + 'cannot land. If the task is investigative and was never going to change code, it cannot '
  + 'land by this route and needs a person to close it.';

/**
 * The feedback for a run that stopped because nothing reached the workspace.
 *
 * Deliberately NOT the gate-correction shape: there is no work here to preserve
 * and no failing test to name, so telling this attempt that "your previous
 * attempt is here" would send it looking for a commit that does not exist.
 * What it needs is the opposite instruction — write the thing.
 */
export function noChangeFeedback({ effect = null, spent = 0, budget = MAX_REPAIRS } = {}) {
  const remaining = Math.max(0, budget - spent);
  const out = [];
  if (effect?.outOfScope) {
    out.push(`Your last attempt changed files, but every one of them was outside this task's scope: ${effect.outOfScope}.`,
      '',
      'The workspace change this task is judged on did not happen. Change what the task actually names —',
      'a file written somewhere else does not count, and a reviewer would reject it even if it did.');
  } else {
    out.push('YOUR LAST ATTEMPT WROTE NOTHING.', '', NO_CHANGE_GUIDANCE);
  }
  out.push('',
    'This is not a failure of capability and you are not being given a bigger model. Read what the task',
    'names, then END BY WRITING — `create_file` or `write_file`. A final message, however correct, is not',
    'a deliverable.',
    '',
    remaining > 1
      ? `Attempt ${spent + 1} at this; ${remaining - 1} more before the task leaves this model.`
      : 'This is the LAST try at this level. If nothing is written again, the task leaves this model.');
  return out.join('\n');
}

/**
 * The backlog fields a correction writes.
 *
 * One definition, because two callers need it to be the same thing: `work:land`
 * applies it for real, and anything standing in for `work:land` has to apply
 * exactly what it applies or it is testing itself. The status transition and
 * the counter live together here for the same reason they matter together — a
 * correction that is queued without being counted is unbounded.
 *
 * `attempts` goes up and the LEVEL does not. That is the whole decision: money
 * was spent so the per-task ceiling has to see it, and capability was never the
 * missing piece so the ladder must not move.
 */
export function correctionFields(task = {}, repair = {}) {
  return {
    status: 'queued',
    attempts: (task.attempts ?? 0) + 1,
    repairs: (task.repairs ?? 0) + 1,
    // What this correction is aimed at, so the next assessment can tell
    // "different failures" from "the same failures again".
    failureSignature: repair.signature ?? null,
    failureCount: repair.count ?? null,
    blockedReason: repair.feedback ?? null
  };
}

/**
 * The log lines for one assessment: a headline, then the failures under it.
 *
 * Separate lines rather than one string with newlines in it, because the loop
 * log is one event per line and `flyt loop log` prints a timestamp in front of
 * each. A multi-line event reads as a timestamped first line followed by
 * orphans, which is how the old `✖ t-0037 gates: The gate \`npm test\` failed
 * (exit 1). Output:` came to be the whole story a person got.
 */
export function repairLogLines(assessment, { taskId = '', limit = 5 } = {}) {
  const { verdict: v, reason, failures = [], kind } = assessment;
  const head = `✖ ${taskId} gates: ${reason}`;
  const lines = failures.slice(0, limit).map(f => `    ${failureLine(f)}`);
  if (failures.length > limit) lines.push(`    …and ${failures.length - limit} more`);
  return {
    headline: kind && kind !== 'unknown' && failures.length ? `${head} [${kind}]` : head,
    failures: lines,
    decision: v
  };
}
