// Model-facing shell execution delegates to the run's coherent execution
// world. This module deliberately has no child_process escape hatch.
import os from 'node:os';
import { fileHost } from './fileHost.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export default {
  name: 'bash',
  title: 'Run a shell command',
  effects: ['shell'],
  risk: 'caution',
  keywords: ['shell', 'command', 'terminal', 'run', 'test', 'build', 'git', 'npm'],
  examples: ['run the test suite', 'check git status', 'build the project'],
  result: { preview: 'json', maxPreviewChars: 4000, artifact: true },
  description: 'Run a shell command in the bound workspace. The run execution world owns its sandbox policy, environment, output bounds, descendants, and teardown.',
  parameters: {
    type: 'object',
    required: ['command'],
    additionalProperties: false,
    properties: {
      command: { type: 'string', description: 'The shell command line to run, e.g. "npm test" or "git status".' },
      timeoutMs: { type: 'number', description: `Optional wall-clock timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
      sandbox_permissions: {
        enum: ['workspace-write', 'danger-full-access'],
        description: 'Optional one-call request for the narrowest strictly wider sandbox mode required.'
      },
      justification: { type: 'string', description: 'Why this exact call cannot complete under the current sandbox mode.' }
    }
  },
  async run(args, ctx) {
    validateEscalationPair(args);
    const host = fileHost(ctx);
    host.ensure?.();
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const fallback = !ctx?.shell;
    const world = fallback ? await standaloneWorld(host.resolve('.'), ctx) : null;
    try {
      const execution = ctx?.execution ?? {
        owner: { runId: String(ctx?.runId ?? 'standalone'), callId: `bash-${Date.now()}-${Math.random().toString(36).slice(2)}` },
        tool: 'bash', attended: true,
        ...(args.sandbox_permissions ? { requestedMode: args.sandbox_permissions } : {}),
        ...(args.justification ? { justification: args.justification } : {}),
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      };
      const result = await (ctx?.shell ?? world.shell).run(String(args.command), { execution, timeoutMs });
      return {
        command: args.command, target: host.target, exitCode: result.code,
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.refused ? { refused: result.refused } : {}),
        stdout: result.stdout, stderr: result.stderr, sandbox: result.sandbox,
      };
    } finally {
      await world?.dispose();
    }
  }
};

function validateEscalationPair(args) {
  const permission = args?.sandbox_permissions != null;
  const justification = typeof args?.justification === 'string' && args.justification.trim().length > 0;
  if (permission !== justification) throw new Error('sandbox_permissions and a non-empty justification must be supplied together.');
}

async function standaloneWorld(workspaceRoot, ctx) {
  const { createLocalExecutionWorld } = await import('#kernel');
  return createLocalExecutionWorld({
    workspaceRoot,
    mode: 'danger-full-access',
    minimumEnforcement: 'partial',
    allowAttendedEscalation: false,
    runsTempRoot: ctx?.store?.rootDir ?? os.tmpdir(),
  });
}
