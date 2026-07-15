// bash: run a shell command with the run's bound workspace as the working
// directory (the real target project), or the run sandbox when unbound. Output
// (stdout/stderr/exit code) is captured into the tool result — which executeTool
// records to log.jsonl — so every command the agent runs is auditable.
//
// Confinement here is cwd-based: the command starts in the workspace root. A
// shell can still `cd ..`, so the stronger guard is the per-node approval gate
// (V1 task 4). Output is capped and the command is time-bounded so a runaway
// process can't hang the run or blow the model's context.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileHost } from './fileHost.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 100_000; // per stream, characters

export default {
  name: 'bash',
  description: 'Run a shell command in the workspace (the bound target project) as the working directory — e.g. run tests, a build, or git. Returns { exitCode, stdout, stderr }. Non-zero exit codes are returned (not thrown) so you can read the error and react. Output is truncated if very long.',
  parameters: {
    type: 'object',
    required: ['command'],
    additionalProperties: false,
    properties: {
      command: { type: 'string', description: 'The shell command line to run, e.g. "npm test" or "git status".' },
      timeoutMs: { type: 'number', description: `Optional wall-clock timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` }
    }
  },
  async run(args, ctx) {
    const host = fileHost(ctx);
    const cwd = host.resolve('.'); // workspace root (or the run's workspace sandbox)
    fs.mkdirSync(cwd, { recursive: true }); // the sandbox dir may not exist yet
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS));
    return await execShell(args.command, cwd, timeoutMs, host.target);
  }
};

function execShell(command, cwd, timeoutMs, target) {
  return new Promise((resolve, reject) => {
    // shell:true runs through the platform shell (cmd.exe on Windows, /bin/sh
    // elsewhere); the command inherits the app's environment (PATH etc.).
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let stdout = '', stderr = '';
    let outTrunc = false, errTrunc = false;
    let timedOut = false;
    const cap = (chunk, cur, setTrunc) => {
      if (cur.length >= MAX_OUTPUT) { setTrunc(); return cur; }
      const next = cur + chunk.toString('utf8');
      if (next.length > MAX_OUTPUT) { setTrunc(); return next.slice(0, MAX_OUTPUT); }
      return next;
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => { stdout = cap(d, stdout, () => { outTrunc = true; }); });
    child.stderr.on('data', d => { stderr = cap(d, stderr, () => { errTrunc = true; }); });
    child.on('error', err => { clearTimeout(timer); reject(new Error(`Failed to start command: ${err.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        command, target,
        exitCode: code,
        ...(signal ? { signal } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        stdout: outTrunc ? stdout + '\n…[truncated]' : stdout,
        stderr: errTrunc ? stderr + '\n…[truncated]' : stderr
      });
    });
  });
}
