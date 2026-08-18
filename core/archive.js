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
