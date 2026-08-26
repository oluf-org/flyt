// The landing sequence (DESIGN-SPEC.md §8), and the pin that keeps it alive.
//
// Everything from "the agent says it is done" to "it is on main or it never
// happened", in one place, so the supervisor's loop reads as the sequence it
// actually is rather than as a pile of git calls.
//
//   verify   → the harness runs the gates in the worktree (§7.1)
//   review   → a second model reads the diff (§7.2)
//   land     → merge --no-ff, canary, revert on red (§6.2)
//
// Each stage returns rather than throws, and each records why. A task that does
// not land must leave behind enough for the next attempt to be better than the
// last, or the loop is just re-rolling dice.
import fs from 'node:fs';
import path from 'node:path';
import { runGates, gatesFor, readProjectGateConfig, protectedViolations, testCountRegression, testCountStagnation, testCountUncheckable, testCountFrom } from './gates.js';
import { WorktreePool, land as gitLand, git } from './worktree.js';
import { reviewDiff, reviewWorker } from './diffReview.js';
import { assessRepair, NO_CHANGE_GUIDANCE } from './repair.js';

/**
 * Run the gates against a task's worktree.
 *
 * The harness runs them; the agent's claim is not consulted. A failure returns
 * its bounded output so it can be handed back as guidance for another attempt
 * — a red suite the agent never sees teaches nothing.
 */
export async function verifyTask({ pool, taskId, task = {}, log = () => {} }) {
  const dir = pool.dirFor(taskId);
  if (!fs.existsSync(dir)) return { ok: false, reason: 'no-worktree', results: [] };
  const projectConfig = readProjectGateConfig(dir);
  const gates = gatesFor({ projectConfig, task });
  log(`gates: ${gates.join(', ')}`);
  const out = await runGates(gates, {
    cwd: dir,
    timeoutMs: projectConfig.gateTimeoutMs,
    onResult: r => log(`  ${r.command} → ${r.status}${r.code != null ? ` (${r.code})` : ''} in ${r.ms}ms`)
  });
  return { ...out, gates };
}

/**
 * Everything that must be true before a reviewer is even asked.
 *
 * These are the mechanical closures from §7.3 — the cheap exits an agent
 * optimizing for "gates green" would otherwise take. They run BEFORE the review
 * because they cost nothing and because a model should not be asked to
 * adjudicate something a rule already settles.
 */
export function mechanicalChecks({ changedFiles, task = {}, baselineOutput = null, currentOutput = null }) {
  const problems = [];

  // A task may touch a protected path only when it is explicitly about it, in
  // which case it lands with a human's approval, never unattended.
  const violations = protectedViolations(changedFiles, { allow: task.blastRadius ?? [] });
  if (violations.length) {
    problems.push(`Touched protected path(s) no task may change on its own: ${violations.join(', ')}.`);
  }

  // Green with fewer tests is the most convincing way to fail.
  const regression = testCountRegression(baselineOutput, currentOutput);
  if (regression) problems.push(regression);

  // Test count stagnation: source changed but test count didn't rise.
  // This catches "green because same tests pass, not because new code is exercised".
  const stagnation = testCountStagnation({ changedFiles, baselineOutput, currentOutput });
  if (stagnation) problems.push(stagnation);

  // Said, not swallowed. A check that could not run is not a check that
  // passed, and the reviewer and the report both need to know which they got.
  const notes = [];
  const uncheckable = testCountUncheckable(baselineOutput, currentOutput);
  if (uncheckable) notes.push(uncheckable);

  return { ok: problems.length === 0, problems, notes };
}

/**
 * The full sequence for one finished task.
 *
 * `dryRun` stops after the review and pushes nothing — the posture for the
 * first nights (§6.4), where branches are pushed for a human to read and
 * nothing merges itself.
 */
export async function landTask({
  pool, repoRoot, taskId, task, base,
  config = {}, apiKey = null,
  verify = null,           // injected so the canary is testable without a suite
  push = null,
  dryRun = false,
  baselineOutput = null,
  log = () => {}
}) {
  const steps = [];
  const record = (step, result) => { steps.push({ step, ...result }); return result; };

  // The commit this attempt is being judged on. `work:land` commits the
  // worktree before calling in, so there is one from here onward, and every
  // failure below can name it — which is what lets the NEXT attempt start from
  // the work instead of from the base branch (api.js work:land, `resumeFrom`).
  let attemptCommit = null;
  try { attemptCommit = (await git(['rev-parse', 'HEAD'], { cwd: pool.dirFor(taskId) })).trim(); }
  catch { /* no sha is a smaller loss than a failed landing report */ }
  const withCommit = result => (attemptCommit ? { ...result, attemptCommit } : result);

  // 1. Gates, in the worktree.
  const gateRun = record('gates', await verifyTask({ pool, taskId, task, log }));
  if (!gateRun.ok) {
    // Red gates are a correction case, and the most specific one there is: the
    // output names the assertion. Watched two tasks arrive with the module
    // written, the tool registered, and one pinned test list not updated — and
    // both were thrown away and rebuilt from nothing on a dearer model.
    //
    // So before a rung is spent, ask whether there is work here worth
    // correcting (core/repair.js). The answer is mechanical and free, and it
    // needs the diff — which is why `changedFiles` is read HERE and not only in
    // the branch below: "which files did this touch" is what separates a change
    // breaking its own tests from a change breaking the repository.
    const changed = await pool.changedFiles(taskId, { base }).catch(() => []);
    const repair = assessRepair({
      failure: gateRun.failure,
      changedFiles: changed,
      repairs: task.repairs ?? 0,
      lastSignature: task.failureSignature ?? null,
      lastCount: task.failureCount ?? null,
      maxRepairs: config.loop?.maxRepairs
    });
    log(`gates: ${repair.verdict} — ${repair.reason}`);
    return withCommit({
      landed: false, stage: 'gates', steps, repair, changedFiles: changed,
      // The feedback IS the guidance now: the failures by name, place and
      // assertion, under an instruction not to start over. The guidance used to
      // be the gate's whole bounded output, which then became the task's
      // `blockedReason` — twenty thousand characters of mostly-passing tests in
      // a field the board renders as one line.
      guidance: repair.feedback
    });
  }

  // 2. Mechanical checks — free, and not a model's judgment call.
  const changedFiles = await pool.changedFiles(taskId, { base });

  // Nothing changed. That is not a diff to review, it is the absence of one,
  // and asking a model to review it buys a paragraph explaining that the diff
  // is empty — which we already know for free, and which every failed attempt
  // pays for again. Seen live: a task whose target file does not exist in this
  // repository produced no change three times, and three reviewers were paid to
  // say so.
  //
  // It is a failure, not a pass: a task that changed nothing has not done the
  // work whatever its run produced, and "landing" an empty merge would put a
  // commit on the base branch attesting to work that did not happen. The
  // guidance separates the two ways to get here, because they need different
  // answers from the next attempt.
  if (!changedFiles.length) {
    // A third way to get here, and the one that reads as the first: the file
    // WAS written, into a path `.gitignore` covers. `git status --porcelain`
    // omits ignored files, so the work is invisible to everything above, and
    // the guidance below would send the next attempt to write a file that is
    // already sitting in the worktree. Every attempt would do it again.
    const ignored = typeof pool.ignoredFiles === 'function'
      ? await pool.ignoredFiles(taskId).catch(() => [])
      : [];
    if (ignored.length) {
      return withCommit({
        landed: false, stage: 'no-changes', steps, ignored,
        guidance: `The task wrote ${ignored.length === 1 ? 'a file' : 'files'} that git is ignoring, `
          + `so there is nothing to land: ${ignored.slice(0, 5).join(', ')}`
          + `${ignored.length > 5 ? `, and ${ignored.length - 5} more` : ''}. Writing `
          + 'it again will not help. Either the deliverable belongs somewhere the repository '
          + 'tracks, or this path is ignored on purpose and a person has to decide which.'
      });
    }
    return {
      landed: false, stage: 'no-changes', steps,
      // Shared with the run-failure path: `core/effect.js` catches the same
      // situation one step earlier, and for the tasks that hit it there, this
      // sentence used to be unreachable.
      guidance: NO_CHANGE_GUIDANCE
    };
  }
  // One reading of what the suite said, shared by the mechanical checks and
  // the reviewer, so the two can never disagree about the same run.
  const gateOutput = gateRun.results.map(r => r.output).join('\n');
  const mech = record('checks', mechanicalChecks({
    changedFiles, task,
    baselineOutput,
    currentOutput: gateOutput
  }));
  // A check that could not run is announced, not swallowed. `notes` carries the
  // unknowables — no baseline, no readable count — and a note that only ever
  // reached the step record would be a check that quietly does not exist, which
  // is the failure this whole path is about.
  for (const note of mech.notes ?? []) log(note);
  if (!mech.ok) {
    return { landed: false, stage: 'checks', steps, guidance: mech.problems.join(' ') };
  }

  // 3. The reviewer.
  const diff = await pool.diff(taskId, { base });
  const review = record('review', await reviewDiff({
    worker: reviewWorker(config), apiKey, task, diff,
    gates: gateRun.results, blastRadius: task.blastRadius ?? [], changedFiles,
    // What the suite did, so "no new tests" is a fact in front of the reviewer
    // rather than something it has to infer from a diff it cannot run.
    testDelta: { before: testCountFrom(baselineOutput), after: testCountFrom(gateOutput) },
    retry: config.retry, timeout: config.timeout
  }));
  log(`review: ${review.verdict}${review.reason ? ` — ${review.reason}` : ''}`);
  if (review.verdict !== 'approve') {
    // The commit the reviewer actually read.
    //
    // A rejection at this stage means the gates ALREADY PASSED and a reviewer
    // then found something specific — a stray file, a name, a missing case.
    // Throwing the whole attempt away and rebuilding it from the base branch on
    // a bigger model is an expensive answer to "delete this file": watched a
    // correct 244-line implementation discarded over an empty file called `1`.
    // Naming the reviewed commit is what lets the next attempt start from the
    // work instead of from nothing.
    return withCommit({
      landed: false, stage: 'review', steps, review,
      guidance: [review.reason, ...review.changes].filter(Boolean).join(' ')
    });
  }

  if (dryRun) {
    log('dry run: approved, not merging');
    return { landed: false, stage: 'dry-run', steps, review, approved: true };
  }

  // 4. Merge, canary, revert on red.
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: pool.dirFor(taskId) });
  const result = record('land', await gitLand({
    repoRoot, branch, base,
    message: `${task.title ?? taskId}\n\nTask ${taskId}. Landed by Flyt after gates and review.`,
    verify, push, log
  }));

  if (!result.landed) {
    return {
      landed: false, stage: result.reason === 'conflict' ? 'merge' : 'canary', steps, review,
      guidance: result.reason === 'conflict'
        ? `The branch no longer merges cleanly into ${base}: ${result.error}. Rebase onto the current ${base} and re-run.`
        : `The change passed its own gates but broke ${base} once merged; the merge was reverted. ${canaryGuidance(result.canary)}`
    };
  }
  return {
    landed: true, stage: 'landed', steps, review,
    mergeSha: result.mergeSha, pushed: result.pushed,
    // What the suite said on the merged base. The caller keeps it and hands it
    // back as `baselineOutput` for the next task, which is what makes the
    // test-count check (§7.3) fire at all in an unattended run: with nothing to
    // compare against, `testCountRegression` skips, and "green with fewer
    // tests" is the most convincing way to fail.
    canaryOutput: (result.canary?.results ?? []).map(r => r.output).join('\n') || null
  };
}

function canaryGuidance(canary) {
  const f = canary?.failure;
  return f ? `\`${f.command}\` failed on the merged result:\n${f.output}` : '';
}

// --- the supervisor pin (§6.3) ---------------------------------------------
//
// The supervisor is running the code it is editing. A merge that breaks the
// gate runner breaks the thing that would have reverted it, and the loop eats
// itself at 11am. So the supervisor runs from a SEPARATE checkout at a known-
// good revision, and that pin only advances to a revision that has proven
// itself twice: the full suite, and a supervisor self-test.
//
// The result is that improvements to the harness reach the harness one verified
// step behind, never mid-flight. This is the single most important safety
// property in the plan.

export function readPin(pinDir) {
  try { return JSON.parse(fs.readFileSync(path.join(pinDir, 'pin.json'), 'utf8')); }
  catch { return null; }
}

export function writePin(pinDir, pin) {
  fs.mkdirSync(pinDir, { recursive: true });
  fs.writeFileSync(path.join(pinDir, 'pin.json'), JSON.stringify(pin, null, 2));
  return pin;
}

/**
 * Should the pin advance to `revision`?
 *
 * `checks` is a list of async () => ({ ok, name, detail }) — the full suite and
 * the supervisor self-test, injected so this module does not decide what
 * "healthy" means for a given project.
 *
 * A pin that fails to advance is NOT an error: the loop keeps running on the
 * old pin and files the problem. Refusing to adopt a bad revision is the
 * mechanism working.
 */
export async function advancePin({ pinDir, revision, checks = [], log = () => {} }) {
  const results = [];
  for (const check of checks) {
    const r = await check();
    results.push(r);
    log(`pin check ${r.name}: ${r.ok ? 'ok' : 'FAILED'}${r.detail ? ` — ${r.detail}` : ''}`);
    if (!r.ok) {
      return { advanced: false, revision, results, reason: `${r.name} failed${r.detail ? `: ${r.detail}` : ''}` };
    }
  }
  const previous = readPin(pinDir);
  writePin(pinDir, { revision, at: new Date().toISOString(), previous: previous?.revision ?? null });
  return { advanced: true, revision, results, previous: previous?.revision ?? null };
}
