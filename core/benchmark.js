// The benchmark (LOOP-PLAN §12.1).
//
// Without this file, "improve yourself" degrades into churn that cannot be
// distinguished from progress. The loop already reports what it did — tasks
// landed, dollars spent, reviews passed — but every one of those numbers is
// produced by the thing being measured. A week of green reports is compatible
// with a loop that got steadily worse at everything except reporting.
//
// So: a fixed set of cases, run against a THROWAWAY CLONE, scored by a probe
// the harness runs itself.
//
// Three properties do the work.
//
// A CASE CARRIES ITS OWN PROBE, and a case without one is refused at load time.
// The gates (§7.1) already check "is the suite green", but a task may ADD gates
// and the suite is part of the repo the loop is editing — so gates measure the
// loop's own idea of done. The probe is the outside opinion: an independent
// command, run by the benchmark after the change has landed, that answers "does
// the thing the case asked for actually work". `landed` and `verified` are
// therefore different numbers, and the gap between them is the most interesting
// thing this file produces.
//
// THE CLONE IS A COMMIT, not a working tree. `git clone` carries committed
// state only, which is exactly right: "did this change make the loop better" is
// a question about a revision, and a score of a dirty checkout is a score of
// something nobody else can reproduce.
//
// A CASE MAY SEED ITS OWN FAILURE. `setup` runs in the clone before the loop
// starts and is committed as part of the baseline, so "fix this bug" is a
// repeatable case rather than a story about a bug that happened once.
//
// A benchmark run is otherwise just a loop run: same supervisor, same worktrees,
// same gates, same reviewer, same ledger. Nothing here re-implements the loop —
// if it did, it would be measuring a different system than the one that runs
// overnight.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseYaml } from './flowlang/yaml.js';
import { git, isInside } from './worktree.js';
import { runGate, runGates, gatesFor, readProjectGateConfig } from './gates.js';
import { Backlog } from './backlog.js';
import { configDirFor } from './workspace.js';

export const CASE_SUFFIX = '.bench.md';
export const DEFAULT_SUITE_DIR = 'benchmark';
const DEFAULT_PROBE_TIMEOUT_MS = 5 * 60 * 1000;
const PROBE_OUTPUT_LIMIT = 4000;

// --- cases -----------------------------------------------------------------

const CASE_DEFAULTS = () => ({
  title: '',
  level: null,        // the effort band to START at (§8); escalation is part of the score
  value: 3,
  effort: 3,
  gates: [],          // extra gates for this case, on top of the project's
  blastRadius: [],
  probe: null,        // REQUIRED: the independent check, run after landing
  setup: null,        // optional: seed a failure into the clone before the loop runs
  weight: 1,
  probeTimeoutMs: null
});

/**
 * One case: YAML frontmatter and a markdown body, the same shape as a task
 * (§5.1) because it BECOMES a task. The body is what the agent reads, so it is
 * written for someone who has never seen this repo.
 */
export function parseCase(text, id) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text ?? ''));
  if (!m) throw new Error(`${id}: no YAML frontmatter`);
  const fields = parseYaml(m[1]);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`${id}: frontmatter is not a mapping`);
  }
  const bench = { ...CASE_DEFAULTS(), ...fields, id, body: (m[2] ?? '').trim() };
  if (!bench.title) throw new Error(`${id}: needs a title`);
  // The rule that keeps the number honest. An unprobed case in a scored suite
  // would pass on the loop's own say-so and quietly inflate every score after
  // it, which is precisely the failure this file exists to prevent.
  if (!bench.probe) throw new Error(`${id}: needs a \`probe\` — a case scored by nothing is not a case`);
  bench.weight = Number(bench.weight) > 0 ? Number(bench.weight) : 1;
  return bench;
}

/**
 * Load a suite directory.
 *
 * A malformed case is REPORTED, not thrown past — one bad file must not stop
 * the other nine from being scored — but it is also not silently skipped: the
 * problems ride along on the card, because a suite that shrank without anyone
 * noticing is a score that went up for no reason.
 */
export function loadSuite(dir, { only = null } = {}) {
  const cases = [];
  const problems = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith(CASE_SUFFIX)).sort();
  } catch {
    return { dir, cases, problems: [{ id: null, error: `No suite directory at ${dir}` }] };
  }
  const wanted = only?.length ? new Set(only) : null;
  for (const file of files) {
    const id = file.slice(0, -CASE_SUFFIX.length);
    if (wanted && !wanted.has(id)) continue;
    try { cases.push(parseCase(fs.readFileSync(path.join(dir, file), 'utf8'), id)); }
    catch (err) { problems.push({ id, error: String(err.message ?? err) }); }
  }
  return { dir, cases, problems };
}

// --- the throwaway clone ---------------------------------------------------

/**
 * Where clones live: outside every repository, always — the same rule as
 * worktrees (§6.1) and for the same reason. A clone of the repo inside the repo
 * would be picked up by the repo's own test glob, and the benchmark would end up
 * measuring itself measuring itself.
 */
export function defaultCloneRoot(repoRoot, { home = os.homedir() } = {}) {
  const resolved = path.resolve(repoRoot);
  const key = `${path.basename(resolved)}-${Buffer.from(resolved).toString('base64url').slice(-8)}`;
  return path.join(home, '.flyt', 'benchmark', key);
}

/**
 * Clone `repoRoot` at `revision` into `dest`.
 *
 * `--no-hardlinks` on purpose. A hardlinked local clone is cheaper, and it is
 * also the one configuration where a mistake in the throwaway can reach the
 * repository it was cloned from. The whole value of a throwaway is that
 * deleting it is free of consequence; paying a copy for that is the right
 * trade.
 */
export async function prepareClone({ repoRoot, dest, revision = 'HEAD', log = () => {} }) {
  const root = path.resolve(repoRoot);
  const dir = path.resolve(dest);
  if (isInside(root, dir)) {
    throw new Error(`A benchmark clone must live outside the repository: ${dir} is inside ${root}.`);
  }
  if (fs.existsSync(dir)) throw new Error(`A benchmark clone already exists at ${dir}.`);
  const sha = await git(['rev-parse', revision], { cwd: root });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(['clone', '--no-hardlinks', '--quiet', root, dir], { cwd: path.dirname(dir) });
  // Detached HEAD would leave the loop with no branch to merge into, so the
  // baseline gets a real branch — named for what it is, so a kept clone reads
  // honestly in `git log`.
  await git(['checkout', '-B', 'benchmark-base', sha], { cwd: dir });
  log(`cloned ${root} @ ${sha.slice(0, 8)} → ${dir}`);
  return { dir, revision: sha, base: 'benchmark-base' };
}

/**
 * Run each case's `setup` in the clone and commit the result.
 *
 * Committed, not left dirty: the worktrees the loop creates branch from the
 * base commit, so a seeded failure that is not committed is a seeded failure
 * the task never sees.
 */
export async function applySetup(cases, { cwd, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, log = () => {} }) {
  const applied = [];
  for (const bench of cases) {
    if (!bench.setup) continue;
    const result = await runGate(bench.setup, { cwd, timeoutMs });
    log(`setup ${bench.id}: ${result.status}`);
    if (result.status !== 'pass') {
      // A setup that fails means the case is measuring something other than
      // what it says. Reporting it beats scoring it.
      applied.push({ id: bench.id, ok: false, output: clip(result.output) });
      continue;
    }
    applied.push({ id: bench.id, ok: true });
  }
  if (applied.some(a => a.ok)) {
    const status = await git(['status', '--porcelain'], { cwd });
    if (status.trim()) {
      await git(['add', '-A'], { cwd });
      await git(['-c', 'user.name=Flyt', '-c', 'user.email=flyt@localhost',
        'commit', '--no-verify', '-m', 'benchmark: seed case setup'], { cwd });
    }
  }
  return applied;
}

/**
 * Are the gates green on the seeded baseline, before any case has run?
 *
 * The cases share one clone worked in sequence — which is what an overnight run
 * actually looks like, and is why a benchmark run is a loop run rather than a
 * separate machine. The cost of that choice is contamination: a `setup` that
 * reddens the suite fails every OTHER case's gates for reasons that have
 * nothing to do with them, and the resulting card would read as a bad night for
 * the loop rather than as a bad case file.
 *
 * The alternative — a clone per case — buys isolation and gives up the property
 * that the thing being measured is the thing that runs. So instead the
 * contamination is MEASURED: one gate run before the loop starts, recorded on
 * the card. A red baseline does not stop the benchmark; it tells you not to
 * believe it.
 */
export async function baselineGates(cloneDir, cases, { log = () => {} } = {}) {
  const projectConfig = readProjectGateConfig(cloneDir);
  const gates = gatesFor({ projectConfig, task: {} });
  const out = await runGates(gates, { cwd: cloneDir, timeoutMs: projectConfig.gateTimeoutMs });
  log(`baseline gates: ${out.ok ? 'green' : `RED (${out.failure?.command})`}`);
  return {
    ok: out.ok,
    gates,
    failure: out.failure ? { command: out.failure.command, status: out.failure.status, output: clip(out.failure.output) } : null,
    // The count the anti-gaming check compares against (§7.3): what the suite
    // reported before anyone touched it.
    output: out.results.map(r => r.output).join('\n')
  };
}

/**
 * Write the suite into the clone's backlog.
 *
 * Case ids are preserved as task ids, so every number on the scorecard can be
 * traced back to a file a person can read. The body is the case's own body —
 * the task file is already written for a reader who has not seen this run
 * (§5.1), so there is nothing to summarize.
 */
export function seedBacklog(cloneDir, cases) {
  // configDirFor, not a literal: the clone must end up with the same backlog
  // directory the engine will read from when the project is attached, including
  // the pre-D29 name if the repo still carries one.
  const backlog = new Backlog(path.join(configDirFor(cloneDir), 'backlog'));
  const seeded = [];
  for (const bench of cases) {
    seeded.push(backlog.add({
      id: bench.id,
      title: bench.title,
      body: bench.body,
      level: bench.level ?? undefined,
      value: bench.value,
      effort: bench.effort,
      gates: bench.gates,
      blastRadius: bench.blastRadius,
      createdBy: 'benchmark'
    }));
  }
  return { backlog, seeded };
}

// --- scoring ---------------------------------------------------------------

const clip = text => {
  const s = String(text ?? '');
  return s.length <= PROBE_OUTPUT_LIMIT ? s : `${s.slice(0, PROBE_OUTPUT_LIMIT)}\n…[truncated]`;
};

/**
 * The independent check, run in the clone's main checkout after the loop has
 * finished with it.
 *
 * In the main checkout rather than the worktree, and after the merge rather
 * than before it, because what is being scored is the whole pipeline: an agent
 * that wrote the right code onto a branch that never merged has not delivered
 * anything, and neither has a merge that the canary reverted.
 */
export async function probeCase(bench, { cwd, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const result = await runGate(bench.probe, { cwd, timeoutMs: bench.probeTimeoutMs ?? timeoutMs });
  return {
    command: bench.probe,
    status: result.status,
    code: result.code,
    ms: result.ms,
    // Only on failure: a green probe's stdout is noise, and a red one's is the
    // entire reason anyone will open this file.
    output: result.status === 'pass' ? '' : clip(result.output)
  };
}

/**
 * One case's score.
 *
 * `usd` is null rather than 0 when nothing could be priced, for the reason the
 * ledger records it that way (§9): "$0" must only ever mean free, never "we
 * failed to look". A total built from nulls says so on the card.
 */
export function scoreCase({ bench, task = null, spend = null, probe = null }) {
  const startedAt = task?.startedAt ? Date.parse(task.startedAt) : null;
  const endedAt = task?.updatedAt ? Date.parse(task.updatedAt) : null;
  const attempts = task?.attempts ?? 0;
  const landed = task?.status === 'landed';
  return {
    id: bench.id,
    title: bench.title,
    weight: bench.weight,
    // The bar: the loop landed it AND an independent command agrees it works.
    verified: Boolean(landed && probe?.status === 'pass'),
    landed,
    status: task?.status ?? 'missing',
    probe: probe ?? { command: bench.probe, status: 'skipped', code: null, ms: 0, output: '' },
    usd: spend && spend.calls ? spend.usd : null,
    unknownCalls: spend?.unknown ?? 0,
    ms: startedAt && endedAt && endedAt >= startedAt ? endedAt - startedAt : null,
    attempts,
    // The band it ended at — the top rung it needed, which is the number that
    // moves when the loop gets better at the same work for less.
    level: task?.level ?? bench.level ?? null,
    escalations: Math.max(0, attempts - 1),
    reason: task?.blockedReason ?? null
  };
}

export function scoreSuite({ suite = 'default', revision = null, clone = null, at = new Date().toISOString(), cases = [], problems = [], notes = [], baseline = null }) {
  const sum = (key) => cases.reduce((n, c) => n + (Number(c[key]) || 0), 0);
  const weight = cases.reduce((n, c) => n + c.weight, 0);
  const verifiedWeight = cases.filter(c => c.verified).reduce((n, c) => n + c.weight, 0);
  const priced = cases.filter(c => typeof c.usd === 'number');
  return {
    suite, revision, clone, at,
    cases,
    problems,
    notes,
    // Whether the suite was green before any case ran. A card with a red
    // baseline is a card that measured the setup, not the loop.
    baseline: baseline ? { ok: baseline.ok, gates: baseline.gates, failure: baseline.failure } : null,
    totals: {
      cases: cases.length,
      verified: cases.filter(c => c.verified).length,
      landed: cases.filter(c => c.landed).length,
      // Landed-but-unverified is the number worth staring at: the loop's own
      // definition of done disagreed with an outside check.
      unverifiedLandings: cases.filter(c => c.landed && !c.verified).length,
      weight,
      verifiedWeight,
      usd: priced.length ? Number(priced.reduce((n, c) => n + c.usd, 0).toFixed(6)) : null,
      unpricedCases: cases.length - priced.length,
      unknownCalls: sum('unknownCalls'),
      ms: sum('ms'),
      attempts: sum('attempts'),
      escalations: sum('escalations')
    },
    // 0..1, weighted. One number, so a trend is possible; every input to it is
    // on the card, so the number is never the only thing you have.
    score: weight ? Number((verifiedWeight / weight).toFixed(4)) : 0
  };
}

export function renderScorecard(card) {
  const t = card.totals;
  const lines = [
    `# Benchmark — ${card.suite}`,
    '',
    `${(card.score * 100).toFixed(0)}% verified (${t.verified}/${t.cases})`
      + (t.usd != null ? `, $${t.usd.toFixed(2)}` : ', cost unknown')
      + `, ${Math.round(t.ms / 60000)}min, ${t.attempts} attempt(s), ${t.escalations} escalation(s)`,
    '',
    `- revision: \`${String(card.revision ?? '').slice(0, 12)}\``,
    `- at: ${card.at}`,
    ''
  ];
  if (card.baseline && !card.baseline.ok) {
    lines.push(`**The baseline was RED before any case ran** (\`${card.baseline.failure?.command}\`).`,
      'Every gate result below is suspect: fix the suite or the case setup before believing this card.', '');
  }
  if (t.unverifiedLandings) {
    lines.push(`**${t.unverifiedLandings} case(s) landed but failed their probe** — the loop's definition of done disagreed with the check.`, '');
  }
  if (t.unpricedCases) lines.push(`_${t.unpricedCases} case(s) had no priced calls; the dollar total is partial._`, '');
  lines.push('| case | verified | landed | probe | $ | time | attempts | level |', '|---|---|---|---|---|---|---|---|');
  for (const c of card.cases) {
    lines.push(`| ${c.id} | ${c.verified ? '✔' : '✖'} | ${c.landed ? '✔' : '✖'} | ${c.probe.status} `
      + `| ${c.usd == null ? '—' : `$${c.usd.toFixed(2)}`} | ${c.ms == null ? '—' : `${Math.round(c.ms / 1000)}s`} `
      + `| ${c.attempts} | ${c.level ?? '—'} |`);
  }
  lines.push('');
  const failures = card.cases.filter(c => !c.verified);
  if (failures.length) {
    lines.push('## What did not verify', '');
    for (const c of failures) {
      lines.push(`### ${c.id} — ${c.title}`, '');
      lines.push(`- status: ${c.status}${c.reason ? ` — ${c.reason}` : ''}`);
      lines.push(`- probe: \`${c.probe.command}\` → ${c.probe.status}`);
      if (c.probe.output) lines.push('', '```', c.probe.output.trim(), '```');
      lines.push('');
    }
  }
  for (const p of card.problems ?? []) lines.push(`! case ${p.id ?? '?'} not loaded: ${p.error}`);
  for (const n of card.notes ?? []) lines.push(`_${n}_`);
  return lines.join('\n');
}

// --- where cards live ------------------------------------------------------
//
// Two directories with similar names, kept apart on purpose:
//
//   <repo>/benchmark/       the SUITE — committed, versioned, protected (§7.3),
//                           because a task that can edit the suite is a task
//                           that can edit its own score.
//   <repo>/.flyt/scores/    the RESULTS — local, ignored, append-only in
//                           practice, and copied into the archive at day's end.

export function saveCard(dir, card) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${String(card.at).replace(/[:.]/g, '-')}-${card.suite}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(card, null, 2));
  return { name, file: path.join(dir, name) };
}

export function listCards(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return []; }
}

export function readCard(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, String(name)), 'utf8')); } catch { return null; }
}

// The two most recent cards for a suite, newest first — what `bench compare`
// uses when nobody names a pair. Scoped by suite because comparing a card from
// one suite against another is the incomparable case `compareCards` refuses.
export function recentCards(dir, { suite = null, limit = 2 } = {}) {
  return listCards(dir)
    .map(name => ({ name, card: readCard(dir, name) }))
    .filter(e => e.card && (!suite || e.card.suite === suite))
    .sort((a, b) => String(b.card.at).localeCompare(String(a.card.at)))
    .slice(0, limit);
}

// --- the gradient ----------------------------------------------------------

/**
 * Two cards, compared (§12.1).
 *
 * "Did this make the loop better" is only a question when the suite did not
 * move under it, so a comparison across DIFFERENT case sets refuses to produce
 * a headline number and says which cases differ instead. A score that quietly
 * compares nine cases against ten is worse than no score.
 */
export function compareCards(prev, next) {
  const prevIds = new Set((prev?.cases ?? []).map(c => c.id));
  const nextIds = new Set((next?.cases ?? []).map(c => c.id));
  const added = [...nextIds].filter(id => !prevIds.has(id));
  const removed = [...prevIds].filter(id => !nextIds.has(id));
  const comparable = !added.length && !removed.length;

  const byId = new Map((prev?.cases ?? []).map(c => [c.id, c]));
  const cases = (next?.cases ?? []).map(c => {
    const was = byId.get(c.id) ?? null;
    return {
      id: c.id,
      verified: c.verified,
      wasVerified: was?.verified ?? null,
      // The four transitions worth naming. Everything else is noise.
      change: !was ? 'new'
        : c.verified && !was.verified ? 'fixed'
          : !c.verified && was.verified ? 'regressed'
            : 'same',
      usd: delta(was?.usd, c.usd),
      ms: delta(was?.ms, c.ms),
      attempts: delta(was?.attempts, c.attempts)
    };
  });

  const totals = {
    score: delta(prev?.score, next?.score),
    verified: delta(prev?.totals?.verified, next?.totals?.verified),
    usd: delta(prev?.totals?.usd, next?.totals?.usd),
    ms: delta(prev?.totals?.ms, next?.totals?.ms),
    attempts: delta(prev?.totals?.attempts, next?.totals?.attempts),
    escalations: delta(prev?.totals?.escalations, next?.totals?.escalations)
  };

  return {
    comparable,
    added, removed,
    from: { at: prev?.at ?? null, revision: prev?.revision ?? null, score: prev?.score ?? null },
    to: { at: next?.at ?? null, revision: next?.revision ?? null, score: next?.score ?? null },
    cases,
    totals,
    regressions: cases.filter(c => c.change === 'regressed').map(c => c.id),
    // The plan's definition, verbatim: same benchmark, fewer dollars, fewer
    // attempts, fewer escalations. Only claimable when the suite held still.
    verdict: !comparable ? 'incomparable'
      : totals.score.delta > 0 ? 'better'
        : totals.score.delta < 0 ? 'worse'
          : cheaper(totals) ? 'cheaper'
            : 'same'
  };
}

function cheaper(totals) {
  const moved = [totals.usd, totals.attempts, totals.escalations].filter(d => d.delta != null);
  return moved.length > 0 && moved.every(d => d.delta <= 0) && moved.some(d => d.delta < 0);
}

function delta(before, after) {
  const a = typeof before === 'number' ? before : null;
  const b = typeof after === 'number' ? after : null;
  return { before: a, after: b, delta: a == null || b == null ? null : Number((b - a).toFixed(6)) };
}

export function renderComparison(cmp) {
  const lines = [`# Benchmark comparison — ${cmp.verdict}`, ''];
  if (!cmp.comparable) {
    lines.push('The suite changed, so the scores are not comparable.',
      cmp.added.length ? `- added: ${cmp.added.join(', ')}` : '',
      cmp.removed.length ? `- removed: ${cmp.removed.join(', ')}` : '', '');
  }
  const line = (label, d, fmt = n => String(n)) =>
    `- ${label}: ${d.before == null ? '—' : fmt(d.before)} → ${d.after == null ? '—' : fmt(d.after)}`
    + (d.delta == null ? '' : ` (${d.delta > 0 ? '+' : ''}${fmt(d.delta)})`);
  lines.push(line('score', cmp.totals.score, n => `${(n * 100).toFixed(0)}%`));
  lines.push(line('verified', cmp.totals.verified));
  lines.push(line('spend', cmp.totals.usd, n => `$${n.toFixed(2)}`));
  lines.push(line('wall clock', cmp.totals.ms, n => `${Math.round(n / 60000)}min`));
  lines.push(line('attempts', cmp.totals.attempts));
  lines.push(line('escalations', cmp.totals.escalations));
  lines.push('');
  if (cmp.regressions.length) lines.push(`**Regressed: ${cmp.regressions.join(', ')}**`, '');
  for (const c of cmp.cases.filter(c => c.change !== 'same')) {
    lines.push(`- ${c.id}: ${c.change}`);
  }
  return lines.join('\n').trim();
}

// --- the run ---------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Drive the loop over the seeded clone until it stops.
 *
 * Deliberately no clock. The supervisor's ladder ends in parking (§11.4), so a
 * benchmark terminates for the same reasons an overnight run does — and a
 * second, shorter deadline here would make the benchmark measure a loop nobody
 * actually runs. Wall clock is SCORED, not bounded.
 */
async function driveWithSupervisor({ api, projectId, pollMs = 2000, log = () => {} }) {
  // Unbounded on purpose. Capping it at one start per case looks tidy and
  // quietly makes two of the scored axes unmeasurable: a case would get exactly
  // one attempt, so `attempts` could never exceed 1 and the top rung reached
  // would always be the one it started at. The loop is bounded by the backlog —
  // every case ends landed or parked, because the ladder ends in parking.
  await api.invoke('loop:start', { projectId, parallelism: 1 });
  for (;;) {
    await sleep(pollMs);
    const status = await api.invoke('loop:status', { projectId });
    if (!status.running) {
      log(`loop finished: ${status.stopping ?? 'done'}`);
      return status;
    }
  }
}

/**
 * The whole thing: clone, seed, run, probe, score.
 *
 * `drive` is injected so the assembly can be tested without a model — and so a
 * caller can run the suite by hand, one case at a time, against the same clone
 * the loop would have got.
 */
export async function runBenchmark({
  engine,
  api,
  repoRoot,
  suiteDir = null,
  only = null,
  revision = 'HEAD',
  cloneRoot = null,
  suite = 'default',
  keep = false,
  drive = driveWithSupervisor,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  log = () => {},
  now = () => Date.now()
} = {}) {
  const root = path.resolve(repoRoot);
  const dir = suiteDir ?? path.join(root, DEFAULT_SUITE_DIR);
  const { cases, problems } = loadSuite(dir, { only: only ?? null });
  if (!cases.length) {
    throw new Error(`No benchmark cases in ${dir}${problems.length ? ` (${problems.length} unreadable)` : ''}.`);
  }

  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const dest = path.join(cloneRoot ?? defaultCloneRoot(root), stamp);
  const clone = await prepareClone({ repoRoot: root, dest, revision, log });
  const notes = [];
  let projectId = null;

  try {
    const setup = await applySetup(cases, { cwd: clone.dir, log });
    for (const s of setup) if (!s.ok) notes.push(`setup for ${s.id} failed; its score is not meaningful`);

    const baseline = await baselineGates(clone.dir, cases, { log });
    if (!baseline.ok) {
      notes.push(`the baseline suite was red before any case ran (${baseline.failure?.command}); every gate result on this card is suspect`);
    }

    seedBacklog(clone.dir, cases);
    // Attached rather than opened: the clone must be drivable by every command
    // in the API without becoming a tab in the user's session, and it has to be
    // droppable again when the directory is deleted underneath it.
    projectId = engine.registry.attach(clone.dir).id;
    log(`benchmark ${suite}: ${cases.length} case(s) against ${clone.dir}`);

    await drive({ api, engine, projectId, cases, clone, log });

    // Everything from here is read off disk — the clone's own backlog files and
    // ledger lines — so a benchmark whose driver died halfway still scores what
    // actually happened rather than what a process remembered.
    const backlog = engine.backlogFor(projectId);
    const ledger = engine.ledgerFor(projectId);
    const scored = [];
    for (const bench of cases) {
      const task = backlog?.get(bench.id) ?? null;
      const probe = await probeCase(bench, { cwd: clone.dir, timeoutMs: probeTimeoutMs });
      log(`probe ${bench.id}: ${probe.status}`);
      scored.push(scoreCase({
        bench, task, probe,
        spend: ledger?.totals({ taskId: bench.id }) ?? null
      }));
    }
    return scoreSuite({
      suite, revision: clone.revision, clone: keep ? clone.dir : null,
      at: new Date(now()).toISOString(), cases: scored, problems, notes, baseline
    });
  } finally {
    if (projectId) {
      // Stop the loop BEFORE the directory goes away. If the drive threw — a
      // failed poll, a cap, a bug — the supervisor may still be working, and
      // deleting a clone out from under a running one leaves it grinding
      // against a repository that no longer exists.
      try { await api?.invoke?.('loop:stop', { projectId, reason: 'benchmark finished' }); }
      catch { /* no loop to stop */ }
      // The worktrees the loop made point INTO the clone's git dir; leaving them
      // behind when the clone is deleted leaves directories nobody can explain.
      try { await removeWorktrees(engine, projectId); } catch { /* best effort */ }
      try { engine.registry.detach(projectId); } catch { /* not attached */ }
    }
    if (!keep) {
      fs.rmSync(clone.dir, { recursive: true, force: true });
      log(`removed ${clone.dir}`);
    } else {
      log(`kept ${clone.dir}`);
    }
  }
}

async function removeWorktrees(engine, projectId) {
  const pool = engine.poolFor(projectId);
  if (!pool) return;
  fs.rmSync(pool.baseDir, { recursive: true, force: true });
}
