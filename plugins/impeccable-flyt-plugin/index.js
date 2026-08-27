/** Impeccable's bundled detector exposed through Flyt's external plugin seam. */
import { spawn } from 'node:child_process';
import path from 'node:path';

export const name = 'impeccable';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  const cwd = path.resolve(config.cwd ?? process.cwd());
  // The CLI travels with the provider payload. Do not silently substitute a
  // separately trusted package: the skill and tool must be the same install.
  const cli = path.resolve(config.cli ?? path.join(cwd, '.flyt/skills/impeccable/scripts/detect.mjs'));
  ctx.tools.register({
    name: 'impeccable_detect',
    description: 'Runs the third-party Impeccable detector CLI against UI files and returns its findings.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative UI files or directories.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    // A claim can only raise inference's floor. Spawning the packaged CLI is a
    // shell effect even though this plugin only needs the registry service.
    classification: { effect: 'shell', destructive: false, untrustedInput: false, source: 'declared' },
    async execute(args) {
      const requested = Array.isArray(args?.paths) ? args.paths.map(String) : [];
      if (!requested.length) return { content: 'Error: paths must contain at least one path', error: 'paths is required' };
      const paths = requested.map(value => {
        const resolved = path.resolve(cwd, value);
        if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) throw new Error(`path escapes workspace: ${value}`);
        return resolved;
      });
      const result = await run(process.execPath, [cli, 'detect', '--json', ...paths], cwd);
      // Impeccable uses 2 for findings. That is successful detection, not a tool failure.
      if (result.code !== 0 && result.code !== 2) {
        return { content: result.stderr || result.stdout, error: `Impeccable exited ${result.code}` };
      }
      return { content: result.stdout || '[]' };
    },
  });
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
