// run_gate: run one of the project's DECLARED gate commands and report what
// it did.
//
// Why this exists next to `bash`, which could obviously run `npm test`:
//
//   1. `bash` runs whatever a model wrote. This runs only a command the
//      PROJECT declared in .flyt/config.json, plus whatever the task added —
//      and a task may only ADD gates, never remove them (core/gates.js §7.3).
//      It still declares `effects: ['shell']`, because it does execute: an
//      allowlist narrows what can run, it does not turn execution into a read,
//      and scoping this to dodge the approval gate is exactly the move
//      DESIGN-SPEC.md §8 names. What the allowlist buys is a gate that cannot be
//      turned into an arbitrary shell by a well-phrased argument.
//   2. More important: it makes "did I actually verify this" a first-class,
//      loggable event instead of a shell string buried among forty others. The
//      supervisor still runs the gates itself at landing time and still refuses
//      to take the agent's word for it (that is the whole point of §7.1) — this
//      is the agent's chance to find out BEFORE it says it is done, which is
//      the difference between one attempt and three.
//
// The result is truncated to the TAIL, because a failing suite puts its summary
// at the bottom and that is where the next thing to fix lives.
import { runGate, gatesFor, readProjectGateConfig, gateProblem } from '../gates.js';

// The last N lines. A failure's diagnosis is at the end of the output; the
// beginning is the runner announcing itself.
const TAIL_LINES = 120;

export default {
  name: 'run_gate',
  title: 'Run a gate',
  description: [
    "Run one of the project's declared gate commands (its tests, its linter) and get back the",
    'exit code and output. Call this BEFORE you say a task is done: the gates are what decide',
    'whether the work lands, and the supervisor runs them itself afterwards regardless — finding',
    'out now costs one call, finding out later costs the whole attempt.',
    'Omit `command` to run every declared gate in order, stopping at the first failure.',
    'Only declared gates can be run; anything else is refused with the list of what is available.'
  ].join(' '),
  effects: ['shell'],
  scope: 'workspace',
  // Allowlisted to commands the project itself declared, so it is not the open
  // shell `bash` is — but it still executes, so it is not `safe` either.
  risk: 'caution',
  keywords: ['gate', 'test', 'verify', 'check', 'suite', 'lint', 'npm test'],
  examples: ['run the tests before finishing', 'check whether npm test passes now'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      command: {
        type: 'string',
        description: 'Which declared gate to run, e.g. "npm test". Omit to run them all in order.'
      }
    }
  },
  async run(args, ctx) {
    const cwd = ctx?.workspace?.root ?? null;
    if (!cwd) throw new Error('This run is not bound to a project folder, so there are no gates to run.');

    const declared = declaredGates(ctx, cwd);
    if (!declared.length) throw new Error('This project declares no gates, so there is nothing to run.');

    const wanted = String(args?.command ?? '').trim();
    if (wanted && !declared.includes(wanted)) {
      throw new Error(
        `"${wanted}" is not a declared gate for this project. Declared: ${declared.map(g => `"${g}"`).join(', ')}. `
        + 'A task may ADD a gate to its own file, but it cannot run an arbitrary command here — use bash for that.'
      );
    }
    const list = wanted ? [wanted] : declared;

    // An interpreter this machine does not have is reported as such rather than
    // run into a confusing shell error: `pytest` in a repository with no Python
    // is the single most common bad gate, and "not an executable command" is a
    // fixable answer where "exit 127" is not.
    const unrunnable = list.map(c => ({ command: c, problem: gateProblem(c, { cwd }) })).filter(g => g.problem);
    if (unrunnable.length === list.length) {
      throw new Error(`No declared gate can run here: ${unrunnable.map(g => `${g.command} — ${g.problem}`).join('; ')}`);
    }

    const results = [];
    for (const command of list) {
      const r = await runGate(command, {
        cwd, timeoutMs: ctx?.gateTimeoutMs ?? undefined,
        shell: ctx?.shell ?? null,
        execution: ctx?.execution ? { ...ctx.execution, tool: 'project-gate' } : null,
      });
      results.push({
        command: r.command,
        ok: r.status === 'pass',
        status: r.status,
        exitCode: r.code,
        durationMs: r.ms,
        output: tail(r.output)
      });
      if (!ctx?.canonicalSession) ctx?.store?.appendLog?.(ctx.runId, {
        event: 'gate_run',
        node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
        command: r.command, status: r.status, code: r.code, ms: r.ms
      });
      // Cheapest first, stop at the first failure: running a ten-minute suite
      // after the lint already failed buys a longer wait and a bigger bill.
      if (r.status !== 'pass') break;
    }

    const failure = results.find(r => !r.ok) ?? null;
    return {
      ok: results.length === list.length && results.every(r => r.ok),
      ran: results.length,
      declared,
      results,
      // Named separately so a model reading only the top of the result still
      // sees whether it has work left to do.
      failure: failure ? { command: failure.command, status: failure.status, exitCode: failure.exitCode } : null
    };
  }
};

/**
 * The gates this run is allowed to execute: the project's own, plus whatever
 * the backlog task it belongs to added.
 *
 * Deliberately read fresh from the workspace on each call rather than captured
 * at run start — a task whose whole job is to fix the gate configuration should
 * be able to run the gate it just declared.
 */
function declaredGates(ctx, cwd) {
  const projectConfig = readProjectGateConfig(cwd);
  let task = {};
  try {
    const loopTaskId = ctx?.store?.readMeta?.(ctx.runId)?.loopTaskId ?? null;
    if (loopTaskId && ctx?.backlog?.get) task = ctx.backlog.get(loopTaskId) ?? {};
  } catch { /* a run with no backlog bound simply has no task gates */ }
  return gatesFor({ projectConfig, task });
}

function tail(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length <= TAIL_LINES) return lines.join('\n');
  const cut = lines.length - TAIL_LINES;
  return `…[${cut} earlier line(s) omitted]…\n${lines.slice(-TAIL_LINES).join('\n')}`;
}
