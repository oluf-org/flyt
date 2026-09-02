// Gates: the definition of done, run by the harness (DESIGN-SPEC.md §8).
//
// `DESIGN-SPEC.md` §8 names the weakest joint in the whole system: `bash`
// returns a non-zero exit as DATA, so `ok: true` means the tool ran, not that
// the command succeeded. An agent can therefore report a task complete over a
// red suite, and a live run did exactly that. Attended you notice. Unattended it
// compounds for hours and poisons the context of every task after it.
//
// So the gates are not something the agent runs and interprets. The supervisor
// runs them, reads the exit code itself, and that is what closes a task. An
// agent's claim is not evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 20_000; // bounded: it goes back to a model as guidance
const launchSandboxMode = () => ['read-only', 'workspace-write', 'danger-full-access'].includes(process.env.FLYT_SANDBOX_MODE)
  ? process.env.FLYT_SANDBOX_MODE : 'workspace-write';

export const DEFAULT_GATES = ['npm test'];

/**
 * Run one command and report what happened — never throw.
 *
 * A gate that times out is reported as `timeout`, distinctly from `fail`: "the
 * suite is red" and "the suite hung" call for different responses, and a
 * supervisor that cannot tell them apart will retry a hang forever.
 */
export async function runGate(command, {
  cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = {}, shell = null, execution = null,
  sandboxMode = launchSandboxMode(),
} = {}) {
  const started = Date.now();
  const owned = shell ? null : await standaloneGateWorld(cwd, sandboxMode);
  try {
    const call = execution ?? {
      owner: { runId: 'gate', callId: `gate-${Date.now()}-${Math.random().toString(36).slice(2)}` },
      tool: 'project-gate', attended: true,
    };
    const result = await (shell ?? owned.shell).run(String(command), {
      execution: call, timeoutMs, env: nonSecretEnv(env),
    });
    const ms = Date.now() - started;
    const infrastructure = Boolean(result.errorCode);
    const status = infrastructure ? 'infrastructure' : result.timedOut ? 'timeout' : result.code === 0 ? 'pass' : 'fail';
    return {
      command, status, code: result.timedOut || infrastructure ? null : result.code, ms,
      output: clip(`${result.stdout ?? ''}${result.stderr ?? ''}`),
      ...(result.errorCode ? { errorCode: result.errorCode, sandbox: result.sandbox } : {}),
    };
  } finally { await owned?.dispose(); }
}

// A line that says something FAILED, in the runners this repo actually uses.
// TAP first, because `npm test` is `node --test`; the rest are the shapes a
// linter, a compiler and a bare assertion arrive in.
const FAILURE_LINE = /^(?:not ok\b|\s*(?:FAIL|FAILED|✖|×)\b|\s*(?:AssertionError|TypeError|ReferenceError|SyntaxError|Error):|.*\berror TS\d+:)/;

// How much of one failure to keep. A TAP failure is the `not ok` line plus an
// indented YAML block holding the assertion, the diff and the stack; forty
// lines reaches the useful part of that without carrying a whole stack twice.
const FAILURE_LINES = 40;

/**
 * Cut a gate's output down to what the next attempt needs to read.
 *
 * The old cut was head-and-tail, on the reasoning that a failing suite puts the
 * first failure at the top and the summary at the bottom. That is true of a
 * suite with twenty tests. This one has fifteen hundred, `node --test` prints
 * an `ok` line and a YAML block for every one of them, and a failure at test
 * 1300 lands squarely in the middle — the part a middle-out cut throws away.
 *
 * Watched exactly that: a task failed its gates, the guidance handed to the
 * retry was ten thousand characters of passing tests, then
 * `…[255386 characters omitted]…`, then ten thousand more passing tests and
 * `# fail 1`. The one line naming the assertion was in the omitted part. The
 * ladder then escalated a band to read the same thing on a dearer model.
 *
 * So the failures are found first and kept whole, and the head and tail get
 * what is left. A cut that loses the reason is not a bounded output; it is a
 * bounded absence of one.
 */
function clip(text) {
  const s = String(text ?? '');
  if (s.length <= OUTPUT_LIMIT) return s;

  const lines = s.split('\n');
  // Each failure: its own line, plus the indented block under it.
  const regions = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FAILURE_LINE.test(lines[i])) continue;
    if (regions.length && i <= regions[regions.length - 1].end) continue;
    let end = i;
    while (end + 1 < lines.length
      && end - i < FAILURE_LINES
      && (lines[end + 1] === '' || /^\s/.test(lines[end + 1]))) end += 1;
    regions.push({ start: i, end });
  }

  const HEAD = 2_000;
  const TAIL = 4_000; // the summary, and whatever ran last
  const budget = OUTPUT_LIMIT - HEAD - TAIL;
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (const r of regions) {
    const block = lines.slice(r.start, r.end + 1).join('\n');
    if (used + block.length > budget) { dropped += 1; continue; }
    kept.push(block);
    used += block.length + 1;
  }

  const parts = [s.slice(0, HEAD)];
  if (kept.length) {
    parts.push(`…\n\n${kept.length} failure(s), in full:\n\n${kept.join('\n\n')}`);
    if (dropped) parts.push(`…and ${dropped} more failure(s), not shown.`);
  }
  parts.push(`…[${s.length - OUTPUT_LIMIT} characters omitted]…`, s.slice(-TAIL));
  return parts.join('\n');
}

/**
 * Run every gate in order, stopping at the first that does not pass.
 *
 * Stopping early is deliberate: gates are ordered cheapest-first, and running a
 * ten-minute suite after the lint already failed buys nothing but a longer wait
 * and a bigger bill.
 */
export async function runGates(gates, {
  cwd, timeoutMs, env, onResult = null, shell = null, execution = null,
  sandboxMode = launchSandboxMode(),
} = {}) {
  const results = [];
  for (const command of gates) {
    const result = await runGate(command, {
      cwd, timeoutMs, env, shell, sandboxMode,
      execution: execution ? { ...execution, owner: { ...execution.owner, callId: `${execution.owner.callId}-${results.length + 1}` } } : null,
    });
    results.push(result);
    onResult?.(result);
    if (result.status !== 'pass') break;
  }
  return {
    ok: results.length === gates.length && results.every(r => r.status === 'pass'),
    results,
    // What goes back to the agent as guidance: the failure, not the transcript
    // of everything that passed before it.
    failure: results.find(r => r.status !== 'pass') ?? null
  };
}

async function standaloneGateWorld(cwd, mode) {
  const { createLocalExecutionWorld } = await import('#kernel');
  return createLocalExecutionWorld({ workspaceRoot: cwd, mode, minimumEnforcement: 'partial',
    allowAttendedEscalation: false, runsTempRoot: os.tmpdir() });
}

const nonSecretEnv = env => Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !/(KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL)/i.test(name) && !/^FLYT_/i.test(name)));

/**
 * The gates for a project: its own configured list, plus whatever the task
 * added. A task may ADD gates and may never remove them (§7.3) — an agent that
 * can delete the check that judges it is not being checked.
 */
/**
 * Can this gate command run here at all?
 *
 * A task may ADD gates and may never remove them, which is the right rule and
 * has a sharp edge: a task that declares a gate this project cannot run is
 * unlandable by construction, and nothing says so until the work is finished
 * and the gate fails. A backlog written against a different repository is full
 * of them — nine of this project's thirteen tasks arrived asking for `pytest`
 * in a repository with no Python, and three more declared the literal command
 * `none`, which is not a command.
 *
 * So the interpreter is checked before the work starts, not after. Only the
 * FIRST word, and only for existence: whether the suite passes is the gate's
 * business, and running it to find out is what the gate itself is for.
 *
 * `null` when it can run, a reason when it cannot.
 */
export function gateProblem(command, { cwd = process.cwd(), lookup = null } = {}) {
  const text = String(command ?? '').trim();
  if (!text) return 'an empty gate command';
  // Shell built-ins and operators are the caller's business, not ours: anything
  // with a pipe, a redirect or a chain is a shell line we do not try to parse.
  if (/[|&;<>()$`]/.test(text)) return null;
  const bin = text.split(/\s+/)[0];
  const found = (lookup ?? whichSync)(bin, cwd);
  return found ? null : `\`${bin}\` is not an executable command on this machine`;
}

// `bin` on PATH, or a file in the project. Deliberately dependency-free and
// deliberately cheap — this runs once per task, not once per call.
function whichSync(bin, cwd) {
  if (/[\\/]/.test(bin)) return fs.existsSync(path.resolve(cwd, bin));
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of ['', ...exts]) {
      try { if (fs.existsSync(path.join(dir, bin + ext))) return true; } catch { /* unreadable PATH entry */ }
    }
  }
  return false;
}

/** Every declared gate that could not run, with the reason. */
export function unrunnableGates(gates = [], opts = {}) {
  return gates
    .map(command => ({ command, problem: gateProblem(command, opts) }))
    .filter(g => g.problem);
}

export function gatesFor({ projectConfig = {}, task = {} } = {}) {
  const base = Array.isArray(projectConfig.gates) && projectConfig.gates.length
    ? projectConfig.gates
    : DEFAULT_GATES;
  const extra = Array.isArray(task.gates) ? task.gates : [];
  return [...new Set([...base, ...extra].map(String).filter(Boolean))];
}

// --- anti-gaming (§7.3) ----------------------------------------------------
//
// An agent optimizing for "gates green" has cheap exits, and they have to be
// closed mechanically rather than by asking it not to.

// Paths no task may touch unless it is explicitly ABOUT them: the gate
// definitions, the supervisor's pinned checkout, the queue itself — and the
// benchmark, which is the only outside opinion of whether any of this is
// getting better (§12.1). Otherwise a task can widen its own definition of
// done, re-prioritize itself, or edit the exam it is sitting, which is the
// reflexive-modification hole.
export const PROTECTED = [
  '.flyt/config.json',
  '.flyt/backlog/',
  '.flyt/feedback/',
  '.flyt/ledger/',
  '.flyt/scores/',
  '.flyt/archive/',
  'benchmark/'
];

export function protectedViolations(files, { allow = [] } = {}) {
  const allowed = allow.map(String);
  return files
    .map(String)
    .filter(f => PROTECTED.some(p => (p.endsWith('/') ? f.startsWith(p) : f === p)))
    .filter(f => !allowed.some(a => f === a || (a.endsWith('/') && f.startsWith(a))));
}

/**
 * A NEW file at the repository root that no task asked for.
 *
 * Eleven of these have been committed or left behind across six attempts:
 * `scratch_edit.py`, `scratch_edit2.py` and `scratch_edit3.py` on t-0093;
 * `fix.cjs`, `patch-parse.mjs` and `patch-parse2.mjs` on t-0097; `_dump.js`,
 * `_dump2.js`, `_extract_revive.py` and `_revive.txt` on t-0092; and the
 * zero-byte `3925`, `1035` and `516` — which are not scripts at all but shell
 * redirects that went somewhere unintended. A reviewer caught one set and parked
 * the task; nothing caught the others, so the pattern was one landing away from
 * main three times. On t-0092 it did worse than litter: the attempt spent its
 * tool-call budget writing programs to inspect the repository instead of editing
 * it, and parked having changed nothing.
 *
 * So the rule is not about extensions — a list of `.py` and `.mjs` would have
 * caught four of eleven. What the eleven share is that the task DECLARED what it
 * would touch, these are outside that, they are new, and they sit at the root
 * where nothing generated belongs. Every part is needed: modified root files are
 * ordinary (`package.json`), new files under a directory are ordinary
 * (`tests/backlogRevive.test.js`, written by the same attempt, is exactly the
 * deliverable), and a new root file a task DECLARED is a deliverable too —
 * `STACK_LANG.md` arrived that way.
 *
 * Deterministic, like every §7.3 closure: three set operations over paths git
 * already distinguishes. Whether a file is "really" scratch is an opinion, it
 * needs a model, and it is what this path keeps out.
 */
export function scratchArtefacts({ addedFiles = [], blastRadius = [] } = {}) {
  const declared = blastRadius.map(String).filter(Boolean);
  // A task that declared NOTHING has nothing for a file to be outside of, and
  // this rule is "outside what the task said it would touch". Every one of the
  // eleven came from a task that DID declare a radius, so this costs nothing
  // real; an undeclared task is judged by the reviewer, as it already was.
  if (!declared.length) return [];
  const inRadius = f => declared.some(a => f === a || f.startsWith(a.endsWith('/') ? a : `${a}/`));
  return addedFiles
    .map(f => String(f).replace(/\\/g, '/'))
    .filter(f => f && !f.includes('/'))       // the repository root, and only there
    .filter(f => !inRadius(f))
    .sort();
}

/** The refusal, in the same voice as the other landing refusals. */
export function scratchArtefactProblem(found = []) {
  if (!found.length) return null;
  return `Created ${found.length} new file(s) at the repository root that this task did not `
    + `declare: ${nameSome(found)}. Scratch and patch scripts, and redirects that landed on the `
    + 'wrong side of a shell command, are not deliverables. Edit the files directly; if one of '
    + 'these really is the deliverable, name it in the task\'s blastRadius.';
}

/**
 * The test count a gate reported, when it says so.
 *
 * `node --test` prints "# tests N", and most runners print something countable.
 * When nothing matches we return null and the caller SKIPS the check with a
 * reason rather than inventing a number — a silent "0 tests, so no decrease" is
 * exactly the hole this is meant to close.
 */
export function testCountFrom(output) {
  const patterns = [
    /^#\s*tests\s+(\d+)\s*$/m,           // node --test
    /(\d+)\s+(?:tests?|specs?)\s+passed/i, // jest/vitest-ish
    /Tests:\s+(?:\d+\s+failed,\s+)?(\d+)\s+passed/i
  ];
  for (const re of patterns) {
    const m = re.exec(String(output ?? ''));
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * What a task may say the suite will do. Closed, and three words long.
 *
 * Both count checks are right about the common case and wrong about three real
 * ones: a pure refactor changes source and needs no new test, a deletion should
 * take its tests with it, and four near-identical tests consolidated into one
 * table-driven test reads as vandalism. t-0040 — "flip the flag, delete the old
 * surfaces" — removes the v1 DSL and the files that cover it, so as things
 * stood it could not land and nothing said so until an attempt was spent
 * finding out.
 *
 * A closed vocabulary rather than free text, for the same reason predicates are
 * `source / operator / literal` and not expressions (D56): three values can be
 * enumerated by a test, and a fourth cannot appear without somebody deciding it
 * should. A value outside the set is a MISTAKE, reported by
 * {@link suiteExpectationProblem}, never quietly read as "no declaration" — a
 * typo that silently restores strict checking is the one failure mode a
 * declaration must not have.
 */
export const SUITE_EXPECTATIONS = ['grows', 'unchanged', 'shrinks'];

/** The declaration, or null when there is none. One field, read in one place. */
export function suiteExpectation(task = {}) {
  const raw = task?.suiteExpectation;
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  return SUITE_EXPECTATIONS.includes(v) ? v : null;
}

/** A declaration nobody can act on, said out loud rather than ignored. */
export function suiteExpectationProblem(task = {}) {
  const raw = task?.suiteExpectation;
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (SUITE_EXPECTATIONS.includes(v)) return null;
  return `The task declares suiteExpectation "${raw}", which is not one of `
    + `${SUITE_EXPECTATIONS.join(', ')}. Nothing can act on it, and a declaration `
    + 'that is silently ignored is worse than none.';
}

/** Test files this change DELETED, which is what accounts for a declared fall. */
const deletedTests = (deletedFiles = []) =>
  deletedFiles.map(f => String(f).replace(/\\/g, '/')).filter(f => /^tests?\//.test(f));

/**
 * Did the change delete tests to go green? Returns a problem string or null.
 *
 * Green-with-fewer-tests is the most convincing way to fail: everything the
 * harness checks says pass.
 */
export function testCountRegression({ task = {}, deletedFiles = [], baselineOutput, currentOutput } = {}) {
  const before = testCountFrom(baselineOutput);
  const after = testCountFrom(currentOutput);
  if (before == null || after == null) return null; // unknowable, not "fine"
  if (after >= before) return null;

  // A declared fall is not a blank cheque. It is earned by DELETING test files:
  // a feature that goes takes its tests with it, and git can say whether that
  // happened. Tests removed from inside a file that still exists are exactly
  // how this gate would be gamed, so they are still reported — the declaration
  // buys the count going down, not the assertions going away.
  if (suiteExpectation(task) === 'shrinks') {
    const gone = deletedTests(deletedFiles);
    if (gone.length) return null;
    return `Test count fell from ${before} to ${after}. The task declared the suite would shrink, `
      + 'but no file under tests/ was deleted, so the tests went out of files that are still there. '
      + 'A declared fall is accounted for by removing the tests with the feature, not by removing assertions.';
  }
  return `Test count fell from ${before} to ${after}: the suite is green because there is less of it.`;
}

/**
 * Directories whose data files ARE behaviour, whatever their extension.
 *
 * A tool definition carries a schema, its effects and its risk; a node template
 * carries a role and a tool ceiling; a flow or a stack is a program. Changing
 * one changes what the system does, so exempting every `.json` would have let
 * the most safety-relevant edits in the repository through unchecked.
 */
const DEFINITION_DIRS = ['tools/', 'nodes/', 'flows/', 'stacks/', 'plugins/'];

/** Prose. Never behaviour, whatever it says. */
const PROSE_EXTS = ['.md', '.txt'];
/** Data that is configuration UNLESS it sits in a definition directory. */
const DATA_EXTS = ['.json', '.yaml', '.yml', '.toml'];

/** Could this file have changed what the system does? */
function couldChangeBehaviour(file) {
  const f = String(file ?? '').replace(/\\/g, '/');
  const dot = f.lastIndexOf('.');
  const ext = dot > 0 ? f.slice(dot).toLowerCase() : '';
  if (PROSE_EXTS.includes(ext)) return false;
  if (DATA_EXTS.includes(ext)) return DEFINITION_DIRS.some(d => f.startsWith(d) || f.includes('/' + d));
  return true;
}

/** At most four names; a blockedReason is read on a board, not in a terminal. */
function nameSome(files) {
  const xs = [...files];
  return xs.length <= 4 ? xs.join(', ') : `${xs.slice(0, 4).join(', ')} and ${xs.length - 4} more`;
}

/**
 * Source changed and the suite did not grow.
 *
 * The sibling of {@link testCountRegression}: that one catches the count going
 * DOWN — green because there is less of it — and this catches it failing to go
 * UP while behaviour moved. t-0079 through t-0082 landed 271 lines across four
 * tasks with the count identical either side, gates green, and two defects
 * behind them. A gate structurally incapable of failing on the change is not
 * verification (GOALS principle 8).
 *
 * Deterministic, like every §7.3 closure: a set operation over the changed
 * paths and two integers. Whether a source change is "really" behavioural is an
 * opinion, it needs a model, and it is exactly what this path keeps out.
 *
 * A FALL is left to testCountRegression, which says it better; reporting both
 * would put two sentences about one number into the same blockedReason.
 */
export function testCountStagnation({ task = {}, changedFiles = [], baselineOutput, currentOutput }) {
  const before = testCountFrom(baselineOutput);
  const after = testCountFrom(currentOutput);
  if (before == null || after == null) return null;   // unknowable — see testCountUncheckable
  if (after !== before) return null;                  // grew, or fell and regression owns it

  // A refactor or a rename moves source and needs no new test, and saying so
  // in advance is what this exists for. The same declaration both checks
  // read — there is one place a task says this.
  if (suiteExpectation(task) === 'unchanged') return null;

  if (changedFiles.some(f => /^tests?\//.test(String(f).replace(/\\/g, '/')))) return null;

  const behavioural = changedFiles.filter(couldChangeBehaviour);
  if (!behavioural.length) return null;

  return `The test count did not move (${before}) while ${behavioural.length} source file(s) changed `
    + `and nothing under tests/ was touched: ${nameSome(behavioural)}. `
    + 'The suite is green because it is the same suite, not because this change is covered.';
}

/**
 * A declaration that turned out to be wrong, said out loud.
 *
 * A NOTE and not a problem, deliberately: predicting a fall and getting a rise
 * means the suite grew, and refusing a landing for that would punish the better
 * outcome. What it must not do is pass unremarked — a prediction nobody ever
 * checks is not a prediction, and the next task written from this one's example
 * should inherit an accurate habit.
 */
export function suiteExpectationMismatch({ task = {}, changedFiles = [], baselineOutput, currentOutput } = {}) {
  const want = suiteExpectation(task);
  if (!want) return null;
  const before = testCountFrom(baselineOutput);
  const after = testCountFrom(currentOutput);
  if (before == null || after == null) return null;

  const got = after > before ? 'grows' : after < before ? 'shrinks' : 'unchanged';
  if (got === want) return null;
  // 'grows' predicted and nothing moved, with nothing behavioural changed, is
  // not a wrong prediction about the suite — it is a change that was only prose.
  if (want === 'grows' && got === 'unchanged' && !changedFiles.some(couldChangeBehaviour)) return null;

  return `The task declared the suite would be "${want}" and it ${
    got === 'unchanged' ? 'did not move' : got === 'grows' ? 'grew' : 'shrank'
  } (${before} → ${after}). The declaration was a prediction and it was wrong; `
    + 'the landing stands, the habit is worth correcting.';
}

/**
 * An assertion that got LOOSER between base and head.
 *
 * t-0103's attempt ran the suite as a tool, saw one failing assertion, and
 * edited the TEST to accept both values — `/can only afford 14(10|11)/` where
 * it had been `/can only afford 1411/` — then declared itself done without
 * re-running the gate. The landing gate passed, because the assertion now
 * accepted the wrong answer, and the reviewer approved it. REVIEW_SYSTEM tells
 * the reviewer in as many words that "Deleted, skipped, or weakened assertions
 * are a REJECT"; this is exactly one, and it is one line in a diff.
 *
 * {@link testCountStagnation} cannot help: a test file WAS touched, which is
 * what exempts a change from it. So the diff itself has to be read.
 *
 * Deterministic, and narrow on purpose. Only the shapes where "looser" is not a
 * matter of opinion:
 *
 *   - a regex literal gained an alternation, a wildcard or a quantifier that
 *     was not there before, on the same line
 *   - `assert.equal` / `assert.deepEqual` / `assert.strictEqual` became
 *     `assert.match` or `assert.ok`
 *   - `assert.match` became `assert.ok`
 *
 * An expected value that merely CHANGED is not weaker, and does not fire: the
 * common, legitimate edit is a test updated because the behaviour it pins moved,
 * and treating that as vandalism would make this unusable. Nor does adding a
 * whole new assertion, or removing one — that is the reviewer's business and
 * {@link testCountRegression}'s.
 *
 * Reads a unified diff, because the diff is what the landing already has.
 */
const LOOSENED = [
  // The order matters: the first match wins, and the specific reasons should be
  // preferred over "the pattern got looser".
  [/\bassert\.(?:deep)?(?:strict)?[Ee]qual\b/, /\bassert\.(?:ok|match)\b/,
    'an equality check became a looser one'],
  [/\bassert\.match\b/, /\bassert\.ok\b/,
    'a pattern check became a truthiness check'],
  [/\bassert\.throws\b/, /\bassert\.ok\b/,
    'a throws check became a truthiness check']
];

/** Did this regex literal gain something that matches strictly more? */
function patternLoosened(before, after) {
  const rx = /\/((?:[^/\\\n]|\\.)+)\/[gimsuy]*/g;
  const pats = text => [...String(text).matchAll(rx)].map(m => m[1]);
  const b = pats(before);
  const a = pats(after);
  if (!b.length || !a.length) return false;
  // Count the constructs that widen what a pattern accepts. A literal that
  // gains one has been loosened; one that merely changed has not.
  const width = pat => (pat.match(/\((?:\?:)?[^)]*\|/g) ?? []).length   // an alternation
    + (pat.match(/(?<!\\)\.(?![*+?])/g) ?? []).length                  // a bare dot
    + (pat.match(/(?<!\\)[.\w\]\)][*+?]/g) ?? []).length                // a quantifier
    + (pat.match(/\\[dws]/gi) ?? []).length;                            // a character class
  return Math.max(...a.map(width)) > Math.max(...b.map(width));
}

export function weakenedAssertions(diff) {
  const found = [];
  let file = null;
  const removed = [];
  const added = [];
  const flush = () => {
    // Pair them up by position within the hunk, which is what a one-line edit
    // looks like and is the only pairing that is not a guess.
    for (let i = 0; i < Math.min(removed.length, added.length); i++) {
      const before = removed[i];
      const after = added[i];
      if (!/\bassert\b/.test(before) && !/\bassert\b/.test(after)) continue;
      const rule = LOOSENED.find(([from, to]) => from.test(before) && to.test(after));
      if (rule) { found.push({ file, before: before.trim(), after: after.trim(), why: rule[2] }); continue; }
      if (patternLoosened(before, after)) {
        found.push({
          file, before: before.trim(), after: after.trim(),
          why: 'the expected pattern was widened to accept more than it did'
        });
      }
    }
    removed.length = 0;
    added.length = 0;
  };

  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('+++ ')) { flush(); file = line.slice(4).replace(/^b\//, '').trim(); continue; }
    if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('index ')) continue;
    if (line.startsWith('@@')) { flush(); continue; }
    if (line.startsWith('-')) { removed.push(line.slice(1)); continue; }
    if (line.startsWith('+')) { added.push(line.slice(1)); continue; }
    flush();   // a context line ends the run of changes
  }
  flush();
  // Only ever about test files. A widened regex in application code is not this.
  return found.filter(f => /(^|\/)tests?\//.test(String(f.file).replace(/\\/g, '/')));
}

/** The refusal, in the same voice as the other landing refusals. */
export function weakenedAssertionProblem(found = []) {
  if (!found.length) return null;
  const one = found[0];
  return `${found.length} assertion(s) were made weaker rather than made to pass. In ${one.file}: `
    + `${one.why} — "${one.before.slice(0, 70)}" became "${one.after.slice(0, 70)}". `
    + 'A gate that goes green because the assertion stopped asking is not a gate. '
    + 'Fix the behaviour, or say in the task why the expectation itself was wrong.';
}

/**
 * Why the count checks could not run, when they could not.
 *
 * Both of them return null for "I cannot tell", which is indistinguishable from
 * "I looked and it was fine" — and the first task of a loop session has no
 * baseline at all, because it comes from the previous task's canary output. An
 * unknowable reported as nothing is a check that quietly does not exist, which
 * is the failure this whole task is about.
 */
export function testCountUncheckable(baselineOutput, currentOutput) {
  if (baselineOutput == null) {
    return 'The test-count checks could not run: no baseline to compare against '
      + '(the first task of a session has none). Nothing here says the change is covered.';
  }
  if (testCountFrom(baselineOutput) == null || testCountFrom(currentOutput) == null) {
    return 'The test-count checks could not run: no test count could be read from the gate output.';
  }
  return null;
}

// The project's gate configuration, read from .flyt/config.json when present.
export function readProjectGateConfig(workspaceRoot) {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, '.flyt', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return { gates: cfg.gates, gateTimeoutMs: cfg.gateTimeoutMs };
  } catch { return {}; }
}
