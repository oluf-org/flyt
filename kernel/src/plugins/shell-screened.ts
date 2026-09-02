import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionWorldDescriptor } from '../seams/execution-world.js';
import type { ShellResult, ShellSeam } from '../seams/shell.js';
import type { SandboxBackend, SandboxEnforcement, SandboxMode, SandboxSeam } from '../seams/sandbox.js';
import { SandboxUnavailableError } from '../seams/sandbox.js';
import type { SubprocessSeam } from '../seams/subprocess.js';
import { layeredEnv, scrubbedParentEnv } from '../sandbox/environment.js';
import { capabilityRequest, type SandboxPolicySeam } from './sandbox-policy.js';
import type { SandboxEventSink } from './fs-sandbox.js';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 5_000_000;

const DENY: readonly [RegExp, string][] = [
  [/\brm\s+(-\w*\s+)*-\w*[rf].*\s\/(?:\s|$)/i, 'recursive deletion of the filesystem root'],
  [/\b(mkfs|fdisk|parted|diskpart)\b/i, 'disk partitioning or formatting'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|;]*\|\s*(sudo\s+)?(ba|z|k)?sh/i, 'piping a download into a shell'],
  [/\bsudo\b|\brunas\b|Start-Process[^|]*-Verb\s+RunAs/i, 'privilege escalation'],
  [/\bgit\s+push\b[^|]*(--force(?!-with-lease)|\s-f(?:\s|$))/i, 'force push'],
];

export function createScreenedShell(
  world: ExecutionWorldDescriptor,
  policy: SandboxPolicySeam,
  sandbox: SandboxSeam,
  subprocess: SubprocessSeam,
  forwardedEnv: readonly string[] = [],
  event?: SandboxEventSink,
): ShellSeam {
  const screen = (command: string) => {
    const text = String(command ?? '').trim();
    if (!text) return { allowed: false, reason: 'The command is empty.' };
    if (text.length > 100_000) return { allowed: false, reason: 'The command is too long.' };
    const hit = DENY.find(([pattern]) => pattern.test(text));
    return hit ? { allowed: false, reason: `Command screen refused ${hit[1]}.` } : { allowed: true };
  };

  return {
    world,
    screen,
    async run(command, options): Promise<ShellResult> {
      const screened = screen(command);
      const standing = policy.describe().mode;
      if (!screened.allowed) return {
        code: null, stdout: '', stderr: '', refused: screened.reason,
        sandbox: factsFor(world, standing, false),
      };
      let cwd: string;
      try { cwd = resolveCwd(world.processRoot, options.cwd); }
      catch (error) {
        return { code: null, stdout: '', stderr: String((error as Error)?.message ?? error), refused: 'sandbox path refused',
          errorCode: 'SANDBOX_DENIED', sandbox: factsFor(world, standing, false) };
      }
      let resolved;
      try { resolved = await policy.resolve(capabilityRequest(options.execution)); }
      catch (error) {
        return { code: null, stdout: '', stderr: String((error as Error)?.message ?? error), refused: 'sandbox escalation refused',
          errorCode: 'SANDBOX_DENIED', sandbox: factsFor(world, standing, false) };
      }
      const shellArgv = await platformShell(subprocess, command);
      let argv: readonly string[] = shellArgv;
      let backend: SandboxBackend = 'unconfined';
      let enforcement: SandboxEnforcement = 'none';
      let runnerFailure;
      try {
        if (resolved.mode !== 'danger-full-access') {
          const confined = await sandbox.confine(shellArgv, { ...resolved, mode: resolved.mode });
          argv = confined.argv; backend = confined.backend; enforcement = confined.enforcement;
          runnerFailure = confined.runnerFailure;
        }
      } catch (error) {
        const unavailable = error instanceof SandboxUnavailableError || (error as any)?.code === 'SANDBOX_UNAVAILABLE';
        const code = unavailable ? 'SANDBOX_UNAVAILABLE' : 'SANDBOX_DENIED';
        await event?.(resolved.owner.runId, { type: 'sandbox.failure', data: {
          callId: resolved.owner.callId, tool: options.execution.tool, code, mode: resolved.mode,
          ...(world.sandbox.backend !== 'unconfined' ? { backend: world.sandbox.backend } : {}),
          remedy: String((error as Error)?.message ?? error).slice(0, 500),
        } });
        return { code: null, stdout: '', stderr: String((error as Error)?.message ?? error), errorCode: code,
          sandbox: { mode: resolved.mode, backend: world.sandbox.backend, enforcement: world.sandbox.enforcement, escalated: resolved.escalated } };
      }

      await event?.(resolved.owner.runId, { type: 'sandbox.decision', data: {
        callId: resolved.owner.callId, tool: options.execution.tool, standingMode: resolved.standingMode,
        ...(options.execution.requestedMode ? { requestedMode: options.execution.requestedMode } : {}),
        effectiveMode: resolved.mode, backend, enforcement, escalated: resolved.escalated,
      } });
      const temp = resolved.mode === 'workspace-write'
        ? { TMPDIR: resolved.privateTemp, TEMP: resolved.privateTemp, TMP: resolved.privateTemp }
        : {};
      const env = layeredEnv(scrubbedParentEnv(process.env, forwardedEnv), temp, safeCallerEnv(options.env ?? {}, forwardedEnv));
      try {
        const executable = await subprocess.resolveExecutable(argv[0], env);
        const handle = subprocess.spawn({
          owner: resolved.owner, argv: [executable, ...argv.slice(1)], cwd, env,
          stdout: { maxBytes: MAX_OUTPUT, spillMaxBytes: 50_000_000 },
          stderr: { maxBytes: MAX_OUTPUT, spillMaxBytes: 50_000_000 },
          timeoutMs: Math.min(MAX_TIMEOUT, Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT)), graceMs: 1_000,
          ...(options.execution.signal ? { signal: options.execution.signal } : {}),
          ...(runnerFailure ? { runnerFailure } : {}),
        });
        const outcome = await handle.done;
        if (outcome.runnerFailed) {
          await event?.(resolved.owner.runId, { type: 'sandbox.failure', data: {
            callId: resolved.owner.callId, tool: options.execution.tool, code: 'SANDBOX_RUNNER_FAILED',
            mode: resolved.mode, backend, remedy: outcome.runnerFailed.detail.slice(0, 500),
          } });
        }
        return {
          code: outcome.exitCode, stdout: streamText(handle.stdout), stderr: streamText(handle.stderr),
          ...(outcome.signal ? { signal: outcome.signal } : {}), ...(outcome.timedOut ? { timedOut: true } : {}),
          ...(outcome.runnerFailed ? { errorCode: 'SANDBOX_RUNNER_FAILED' as const } : {}),
          sandbox: { mode: resolved.mode, backend, enforcement, escalated: resolved.escalated },
        };
      } catch (error) {
        return { code: null, stdout: '', stderr: String((error as Error)?.message ?? error), errorCode: 'SPAWN_FAILED',
          sandbox: { mode: resolved.mode, backend, enforcement, escalated: resolved.escalated } };
      }
    },
  };
}

function resolveCwd(root: string, requested?: string): string {
  const rel = requested ?? '.';
  if (path.isAbsolute(rel)) throw new Error('Shell cwd must be relative to the execution world.');
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Shell cwd escapes the execution world.');
  return resolved;
}

async function platformShell(subprocess: SubprocessSeam, command: string): Promise<readonly [string, ...string[]]> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const configured = process.env.ComSpec;
    const candidate = configured && path.isAbsolute(configured) ? configured : path.join(systemRoot, 'System32', 'cmd.exe');
    return [await subprocess.resolveExecutable(candidate), '/d', '/s', '/c', `"${command}"`];
  }
  return [await subprocess.resolveExecutable('/bin/sh'), '-c', command];
}

function factsFor(world: ExecutionWorldDescriptor, mode: SandboxMode, escalated: boolean) {
  return mode === 'danger-full-access'
    ? { mode, backend: 'unconfined' as const, enforcement: 'none' as const, escalated }
    : { mode, backend: world.sandbox.backend, enforcement: world.sandbox.enforcement, escalated };
}

/**
 * The collector keeps only a bounded tail resident while a process runs.  If
 * it had to truncate that tail, recover the bounded spill here so the normal
 * tool-result persistence path can archive the complete stream before world
 * teardown removes the provider-private file.  Spill overflow is deliberately
 * explicit instead of pretending the retained tail is complete.
 */
const streamText = (stream: { text: string; truncated: boolean; spillPath?: string }): string => {
  if (!stream.truncated) return stream.text;
  if (stream.spillPath) {
    try { return fs.readFileSync(stream.spillPath, 'utf8'); }
    catch { /* teardown/race: fall through to an honest retained-tail result */ }
  }
  return `…[truncated; retained tail]\n${stream.text}`;
};

function safeCallerEnv(env: Readonly<Record<string, string | undefined>>, forwarded: readonly string[]) {
  const allowed = new Set(forwarded.map(name => process.platform === 'win32' ? name.toUpperCase() : name));
  return Object.fromEntries(Object.entries(env).filter(([name]) => {
    if (/^FLYT_/i.test(name)) return false;
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    return !/(KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL)/i.test(name) || allowed.has(key);
  }));
}
