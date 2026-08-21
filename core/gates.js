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
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 20_000; // bounded: it goes back to a model as guidance

export const DEFAULT_GATES = ['npm test'];

/**
 * Run one command and report what happened — never throw.
 *
 * A gate that times out is reported as `timeout`, distinctly from `fail`: "the
 * suite is red" and "the suite hung" call for different responses, and a
 * supervisor that cannot tell them apart will retry a hang forever.
 */
export function runGate(command, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    // Through the shell on purpose: a gate is a command line a human wrote in
    // config ("npm test -- --reporter dot"), not an argv the app assembles.
    // Nothing model-authored reaches here — gates come from the project's own
    // .flyt/config.json and a task may only ADD to them (§7.3).
    const child = execFile(command, {
      cwd, env, shell: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      killSignal: 'SIGKILL'
    }, (err, stdout, stderr) => {
      const ms = Date.now() - started;
      const output = clip(`${stdout ?? ''}${stderr ?? ''}`);
      // execFile reports a timeout as a killed child, not as a distinct error.
      const timedOut = Boolean(err && (err.killed || err.signal === 'SIGKILL') && ms >= timeoutMs - 50);
      const code = typeof err?.code === 'number' ? err.code : (err ? 1 : 0);
      resolve({
        command,
        status: timedOut ? 'timeout' : (code === 0 ? 'pass' : 'fail'),
        code: timedOut ? null : code,
        ms,
        output
      });
    });
    child.on('error', () => { /* reported through the callback */ });
  });
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
export async function runGates(gates, { cwd, timeoutMs, env, onResult = null } = {}) {
  const results = [];
  for (const command of gates) {
    const result = await runGate(command, { cwd, timeoutMs, env });
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
 * Did the change delete tests to go green? Returns a problem string or null.
 *
 * Green-with-fewer-tests is the most convincing way to fail: everything the
 * harness checks says pass.
 */
export function testCountRegression(baselineOutput, currentOutput) {
  const before = testCountFrom(baselineOutput);
  const after = testCountFrom(currentOutput);
  if (before == null || after == null) return null; // unknowable, not "fine"
  if (after >= before) return null;
  return `Test count fell from ${before} to ${after}: the suite is green because there is less of it.`;
}

// The project's gate configuration, read from .flyt/config.json when present.
export function readProjectGateConfig(workspaceRoot) {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, '.flyt', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return { gates: cfg.gates, gateTimeoutMs: cfg.gateTimeoutMs };
  } catch { return {}; }
}
