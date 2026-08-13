// Gates: the definition of done, run by the harness (LOOP-PLAN §7.1).
//
// `DESIGN-SPEC.md` §11.1 names the weakest joint in the whole system: `bash`
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

// Head and tail: a failing suite puts the summary at the bottom and the first
// failure at the top, and a middle-out cut loses both.
function clip(text) {
  const s = String(text ?? '');
  if (s.length <= OUTPUT_LIMIT) return s;
  const half = Math.floor(OUTPUT_LIMIT / 2);
  return `${s.slice(0, half)}\n…[${s.length - OUTPUT_LIMIT} characters omitted]…\n${s.slice(-half)}`;
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
// definitions, the supervisor's pinned checkout, and the queue itself.
// Otherwise a task can widen its own definition of done, or re-prioritize
// itself, which is the reflexive-modification hole.
export const PROTECTED = [
  '.flyt/config.json',
  '.flyt/backlog/',
  '.flyt/feedback/',
  '.flyt/ledger/'
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
