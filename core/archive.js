// The archive (DESIGN-SPEC.md §8).
//
// A day of unattended work leaves its evidence scattered across four places
// that all keep moving: the ledger appends, the backlog is rewritten in place,
// the git history grows, and the supervisor's status dies with the process. Ask
// on Thursday what Tuesday cost and there is no answer — not because nothing
// was recorded, but because everything that recorded it has since been edited.
//
// So at the end of a day the numbers are COPIED, not referenced. An archive
// that points at live files is not an archive; it is a second name for the
// present. `.flyt/archive/<date>/` is therefore self-contained and never
// rewritten, and `day.json` is the small summary the trend reads so that
// "did this make the loop better" is a series rather than an anecdote.
//
// SICA's finding, which this implements: the loop needs a score and an archive,
// and the best archived version is what proposes the next improvement.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './worktree.js';

export const DAY_FILE = 'day.json';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dateStamp = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

const nextDay = date => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return dateStamp(d);
};

function assertDate(date) {
  const s = String(date ?? '');
  // The date becomes a directory name and arrives from a CLI flag and an HTTP
  // body, so it is validated rather than trusted.
  if (!DATE_RE.test(s)) throw new Error(`Invalid archive date "${s}" (expected YYYY-MM-DD).`);
  return s;
}

export function archiveDir(root, date) { return path.join(root, assertDate(date)); }

export const RETIRE_FILE = 'retirement.json';

/**
 * Where a retired task's run folders and retirement record live.
 *
 * Deliberately keyed on the task id, not a date: a task is retired once, and
 * its record belongs to the task rather than to the day somebody pressed the
 * button. `listArchive`/`readArchive`/`trend` stay keyed on DATE_RE, so this
 * sibling never shows up in the day list or the trend.
 */
export function retiredDir(root, taskId) { return path.join(root, 'retired', String(taskId)); }

/**
 * Write the record of a retirement (the archive-side half of retiring a task).
 *
 * Idempotent by overwrite, like writeArchive: a task has one retirement and
 * rewriting it replaces the facts rather than appending a second set.
 */
export function writeRetirement({
  root, taskId, reason = null, retiredBy = null,
  retiredAt = new Date().toISOString(), movedRunIds = [], resumeFrom = null
} = {}) {
  const dir = retiredDir(root, taskId);
  fs.mkdirSync(dir, { recursive: true });
  // A task retired AGAIN after a revival starts a fresh retirement: the new
  // `retiredAt` is the current fact and a stale `revivedAt` beside it would
  // read as "retired, and also back", which is the one thing it is not. The
  // count survives, because how many times this has happened is the history.
  const before = readRetirement(root, String(taskId));
  const record = {
    taskId, reason, retiredBy, retiredAt, movedRunIds, resumeFrom,
    ...(before?.revivedCount ? { revivedCount: before.revivedCount } : {})
  };
  const file = path.join(dir, RETIRE_FILE);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return { dir, file, record };
}

/**
 * Record that a retired task came back, without pretending it was never gone.
 *
 * The contract, decided here rather than left implicit: **the runs stay in the
 * archive and the record says the revival happened.** The alternative — moving
 * every run folder back — is the operation that already fails on this platform
 * (see moveRunFolder: Flyt's own watcher holds `.flyt/runs` open, and t-0033's
 * eleven folders failed EPERM on the first one), it risks a half-moved task for
 * no gain, and the pointer stubs already resolve. A revival is a second life,
 * not an erasure.
 *
 * So both halves are amended in place. The retirement record keeps `retiredAt`
 * and gains `revivedAt`; every pointer stub the retirement wrote gains the same
 * date, so a reader who opens one of the task's runs is told the task is back in
 * the queue rather than being told it was retired — which stopped being true.
 *
 * `revivedCount` is what makes a repeat cycle legible: retire, revive, retire
 * again is a real sequence, and a record that only ever holds the last pair
 * cannot show it happened three times.
 */
export function markRevived({ root, runsDir, taskId, revivedAt = new Date().toISOString() } = {}) {
  const record = readRetirement(root, String(taskId));
  if (!record) return null;

  const next = { ...record, revivedAt, revivedCount: (record.revivedCount ?? 0) + 1 };
  fs.writeFileSync(path.join(retiredDir(root, String(taskId)), RETIRE_FILE), JSON.stringify(next, null, 2));

  // Each stub the retirement left behind. A stub that is missing, unreadable or
  // belongs to another task is skipped rather than rewritten — this is amending
  // a record, and a revival that corrupted an unrelated run's pointer would be
  // a far worse bug than the one it fixes.
  const stubs = [];
  for (const runId of Array.isArray(next.movedRunIds) ? next.movedRunIds : []) {
    const at = path.join(runsDir, String(runId));
    try {
      if (!fs.existsSync(at) || !fs.statSync(at).isFile()) continue;
      const stub = JSON.parse(fs.readFileSync(at, 'utf8'));
      if (stub?.taskId !== String(taskId)) continue;
      fs.writeFileSync(at, JSON.stringify({ ...stub, revivedAt }, null, 2));
      stubs.push(String(runId));
    } catch { /* an unreadable stub is not a reason to fail the revival */ }
  }
  return { record: next, revivedAt, stubs };
}

export function readRetirement(root, taskId) {
  const file = path.join(retiredDir(root, taskId), RETIRE_FILE);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Move a task's run folders into the retired archive and leave a pointer where
 * each one used to be.
 *
 * The source files are MOVED, never copied: an archive that leaves the live
 * files in place is not retirement, it is a second name for the present. The
 * pointer file at the original `.flyt/runs/<runId>` path is what tells a
 * reader where the run went, so a vanished run folder reads as relocated
 * rather than as lost.
 */
export function relocateRetiredRuns({
  root, runsDir, taskId, runIds = [], reason = null, retiredBy = null,
  retiredAt = new Date().toISOString(), resumeFrom = null
} = {}) {
  const dir = retiredDir(root, taskId);
  const runsDest = path.join(dir, 'runs');
  const moved = [];
  // What DID move, written whether or not the rest of them do. A retirement
  // that fell over halfway used to leave moved folders in the archive with no
  // record naming them — a pile nothing points at, which is the one thing an
  // archive may not be.
  const record = () => writeRetirement({
    root, taskId, reason, retiredBy, retiredAt,
    movedRunIds: moved.map(m => m.runId), resumeFrom
  });
  try {
    for (const runId of runIds) {
      const from = path.join(runsDir, runId);
      const to = path.join(runsDest, runId);
      // Already in the archive, from an earlier pass over the same task. It is
      // still one of this retirement's runs, so it stays in the record: a retry
      // that reported fewer runs than the first attempt would shrink the record
      // every time it ran.
      if (fs.existsSync(to)) { moved.push({ runId, from, to }); continue; }
      if (!fs.existsSync(from)) continue;             // never existed
      if (fs.statSync(from).isFile()) continue;       // a pointer whose archive is gone
      fs.mkdirSync(runsDest, { recursive: true });
      moveRunFolder(from, to);
      // The pointer replaces the folder at its original path, so the spot a
      // reader looks first says where the run went rather than staying empty.
      fs.writeFileSync(from, JSON.stringify({ taskId, retiredAt, archivePath: to }, null, 2));
      moved.push({ runId, from, to });
    }
  } catch (err) {
    record();
    throw err;
  }
  return { dir, record: record(), moved };
}

/**
 * Move one run folder into the archive.
 *
 * `fs.renameSync` is the right move when it works: one atomic operation, and no
 * second copy of a folder that is routinely hundreds of megabytes. On Windows
 * it frequently does not work. A directory with an open handle anywhere beneath
 * it cannot be renamed, and Flyt watches `.flyt/runs` in order to stream a run
 * into the canvas — so the app's own watcher is usually that handle. Retiring
 * t-0033's eleven run folders failed EPERM on the first one; a same-parent
 * rename of that same folder failed identically, while copying it succeeded.
 *
 * So rename first, and fall back only for the two codes that mean "this path
 * cannot be renamed" rather than "this move is wrong": EPERM (a held handle)
 * and EXDEV (a different volume). Anything else is a real error and propagates.
 */
function moveRunFolder(from, to) {
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    if (err?.code !== 'EPERM' && err?.code !== 'EXDEV') throw err;
  }
  fs.cpSync(from, to, { recursive: true });
  // maxRetries covers the same held handle that defeated the rename: a watcher
  // releasing a moment later is the common case.
  fs.rmSync(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  // The pointer is written where the folder WAS, so the original must actually
  // be gone. A copy whose removal failed would leave the run in both places and
  // the pointer unwritable, which is the one state no reader can make sense of.
  if (fs.existsSync(from)) {
    throw Object.assign(
      new Error(`copied ${path.basename(from)} into the archive, but could not remove the original at ${from} — `
        + 'something still holds it open. The archived copy is intact; nothing was lost.'),
      { code: 'ERETIREBUSY' });
  }
}

/**
 * What landed, from git rather than from the backlog.
 *
 * `--first-parent` on the base branch is exactly the loop's landing sequence:
 * every task arrives as one `--no-ff` merge (§6.2), so first-parent history is
 * the list of things that landed and nothing else. Reverts show up too, which
 * is correct — a canary that fired is part of the day.
 */
export async function commitsOn({ repoRoot, base = 'HEAD', date, log = () => {} }) {
  try {
    const out = await git([
      'log', '--first-parent', base,
      `--since=${date}T00:00:00Z`, `--until=${nextDay(date)}T00:00:00Z`,
      '--format=%H%x09%aI%x09%s'
    ], { cwd: repoRoot });
    return out.split('\n').filter(Boolean).map(line => {
      const [sha, at, subject] = line.split('\t');
      return { sha, at, subject, revert: /^Revert /.test(subject ?? '') };
    });
  } catch (err) {
    log(`could not read git history: ${err.message}`);
    return [];
  }
}

/**
 * Write one day's archive.
 *
 * Idempotent by overwrite: running it twice on the same day replaces that day's
 * files rather than appending a second one, because a day has one set of facts
 * and two directories for it would be a question nobody can answer.
 */
export async function writeArchive({
  root, date = dateStamp(), backlog = null, ledger = null, card = null,
  report = null, repoRoot = null, base = 'HEAD', windowMs = 24 * 60 * 60 * 1000,
  log = () => {}
} = {}) {
  const dir = archiveDir(root, date);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, data) => {
    fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    return name;
  };
  const files = [];

  const tasks = backlog?.list() ?? [];
  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const parked = tasks.filter(t => t.status === 'parked')
    .map(t => ({ id: t.id, title: t.title, level: t.level, attempts: t.attempts, reason: t.blockedReason }));

  if (tasks.length) files.push(write('tasks.json', tasks));
  // The pile that needs a person gets its own file even when it is empty: an
  // absence is an answer, and having to infer it from a missing file is not.
  files.push(write('parked.json', parked));

  const spend = ledger?.totals({ sinceMs: windowMs }) ?? null;
  if (ledger) {
    // The ledger's own file for this date, copied verbatim. The totals above are
    // a summary; this is the audit trail, and a summary is not one.
    const src = path.join(ledger.rootDir, `${date}.jsonl`);
    try { fs.copyFileSync(src, path.join(dir, 'ledger.jsonl')); files.push('ledger.jsonl'); }
    catch { /* nothing spent that day */ }
  }

  const commits = repoRoot ? await commitsOn({ repoRoot, base, date, log }) : [];
  if (commits.length) files.push(write('commits.json', commits));

  if (card) {
    files.push(write('benchmark.json', card));
  }
  if (report) files.push(write('report.md', report));

  // The index the trend reads. Deliberately small and flat: a series is only
  // useful if reading a year of it is cheap.
  const day = {
    date,
    at: new Date().toISOString(),
    spend: spend ? { usd: spend.usd, calls: spend.calls, unknown: spend.unknown, estimated: spend.estimated } : null,
    tasks: { total: tasks.length, ...counts },
    landed: commits.filter(c => !c.revert).length,
    reverts: commits.filter(c => c.revert).length,
    parked: parked.length,
    benchmark: card ? {
      suite: card.suite,
      score: card.score,
      verified: card.totals.verified,
      cases: card.totals.cases,
      unverifiedLandings: card.totals.unverifiedLandings,
      usd: card.totals.usd,
      ms: card.totals.ms,
      attempts: card.totals.attempts,
      escalations: card.totals.escalations,
      revision: card.revision
    } : null
  };
  files.push(write(DAY_FILE, day));
  log(`archived ${date}: ${files.length} file(s) in ${dir}`);
  return { dir, date, files, day };
}

export function listArchive(root) {
  let names = [];
  try { names = fs.readdirSync(root).filter(n => DATE_RE.test(n)).sort(); } catch { return []; }
  return names.map(date => {
    try { return JSON.parse(fs.readFileSync(path.join(root, date, DAY_FILE), 'utf8')); }
    // A directory with no day.json is a half-written archive, reported as
    // itself rather than dropped: a gap in a trend should be visible.
    catch { return { date, incomplete: true }; }
  });
}

export function readArchive(root, date) {
  const dir = archiveDir(root, date);
  if (!fs.existsSync(dir)) return null;
  const read = name => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
  };
  return {
    date,
    dir,
    day: read(DAY_FILE),
    benchmark: read('benchmark.json'),
    parked: read('parked.json') ?? [],
    commits: read('commits.json') ?? [],
    tasks: read('tasks.json') ?? [],
    report: (() => { try { return fs.readFileSync(path.join(dir, 'report.md'), 'utf8'); } catch { return null; } })()
  };
}

/**
 * The series (§12.1): the gradient the picker and the tier table read.
 *
 * Only days that actually ran a benchmark carry a score, and a day without one
 * is kept in the series with `score: null` rather than dropped — the shape of
 * the gaps is part of what the trend says.
 */
export function trend(root, { limit = 30 } = {}) {
  const days = listArchive(root).slice(-limit);
  const points = days.map(d => ({
    date: d.date,
    score: d.benchmark?.score ?? null,
    verified: d.benchmark?.verified ?? null,
    cases: d.benchmark?.cases ?? null,
    usd: d.benchmark?.usd ?? d.spend?.usd ?? null,
    benchUsd: d.benchmark?.usd ?? null,
    spendUsd: d.spend?.usd ?? null,
    attempts: d.benchmark?.attempts ?? null,
    escalations: d.benchmark?.escalations ?? null,
    landed: d.landed ?? null,
    parked: d.parked ?? null,
    incomplete: Boolean(d.incomplete)
  }));
  const scored = points.filter(p => p.score != null);
  const first = scored[0] ?? null;
  const last = scored[scored.length - 1] ?? null;
  return {
    points,
    scored: scored.length,
    latest: last,
    // The one claim the trend is allowed to make. Two scored days or it says
    // nothing, because a single point is a measurement, not a direction.
    direction: scored.length < 2 || !first || !last ? null
      : last.score > first.score ? 'improving'
        : last.score < first.score ? 'declining'
          : 'flat'
  };
}

export function renderTrend(series) {
  if (!series.points.length) return 'No archived days yet.';
  const lines = ['# Trend', '', '| date | score | verified | bench $ | day $ | attempts | landed | parked |', '|---|---|---|---|---|---|---|---|'];
  for (const p of series.points) {
    lines.push(`| ${p.date} | ${p.score == null ? '—' : `${(p.score * 100).toFixed(0)}%`} `
      + `| ${p.verified == null ? '—' : `${p.verified}/${p.cases}`} `
      + `| ${p.benchUsd == null ? '—' : `$${p.benchUsd.toFixed(2)}`} `
      + `| ${p.spendUsd == null ? '—' : `$${p.spendUsd.toFixed(2)}`} `
      + `| ${p.attempts ?? '—'} | ${p.landed ?? '—'} | ${p.parked ?? '—'} |`);
  }
  lines.push('', series.direction
    ? `${series.scored} scored day(s): ${series.direction}.`
    : 'Not enough scored days to call a direction.');
  return lines.join('\n');
}
