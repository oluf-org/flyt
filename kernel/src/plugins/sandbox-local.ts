import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionWorldDescriptor } from '../seams/execution-world.js';
import {
  SandboxUnavailableError,
  type ConfinedArgv, type SandboxBackend, type SandboxEnforcement,
  type SandboxPolicy, type SandboxProbe, type SandboxSeam,
} from '../seams/sandbox.js';
import type { SubprocessSeam } from '../seams/subprocess.js';
import { layeredEnv, scrubbedParentEnv } from '../sandbox/environment.js';

export interface LocalSandboxOptions {
  windowsRunnerPath?: string;
  /** CI-only: exercise the restricted token when the hosted runner is elevated. */
  allowElevatedWindowsRunnerForTest?: boolean;
}

const strength = (value: SandboxEnforcement | null): number => value === 'full' ? 2 : value === 'partial' ? 1 : 0;
const successfulProbeCache = new Map<string, Promise<SandboxProbe>>();

export function createLocalSandbox(
  world: ExecutionWorldDescriptor,
  subprocess: SubprocessSeam,
  probeRoot: string,
  options: LocalSandboxOptions = {},
): SandboxSeam {
  let disposed = false;

  const backend = (): { name: Exclude<SandboxBackend, 'unconfined'>; enforcement: Exclude<SandboxEnforcement, 'none'> } => {
    if (process.platform === 'linux') return { name: 'bubblewrap', enforcement: 'full' };
    if (process.platform === 'darwin') return { name: 'seatbelt', enforcement: 'full' };
    return { name: 'windows-restricted-token', enforcement: 'partial' };
  };

  const runner = async (): Promise<string> => {
    if (process.platform === 'darwin') return '/usr/bin/sandbox-exec';
    if (process.platform === 'linux') return subprocess.resolveExecutable('bwrap', scrubbedParentEnv());
    const explicit = options.windowsRunnerPath;
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const packaged = typeof resourcesPath === 'string' ? path.join(resourcesPath, 'flyt-sandbox-win.exe') : '';
    const dev = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'native', 'windows', 'Flyt.Sandbox.Runner', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'flyt-sandbox-win.exe');
    const found = [explicit, packaged, dev].find(candidate => candidate && fs.existsSync(candidate));
    if (!found) throw new Error('The Windows restricted-token runner is not installed. Reinstall Flyt or run flyt doctor --refresh.');
    return path.resolve(found);
  };

  const wrap = async (argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> => {
    const selected = backend();
    const executable = await runner();
    if (strength(selected.enforcement) < strength(policy.minimumEnforcement)) {
      throw new SandboxUnavailableError(`${selected.name} provides ${selected.enforcement} enforcement, but this run requires ${policy.minimumEnforcement}.`);
    }
    if (process.platform === 'linux') {
      const args = [
        executable, '--die-with-parent', '--new-session', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
        ...(policy.mode === 'workspace-write' ? ['--bind', policy.workspaceRoot, policy.workspaceRoot, '--bind', policy.privateTemp, policy.privateTemp] : []),
        '--chdir', policy.workspaceRoot, '--', ...argv,
      ];
      return { argv: args, backend: selected.name, enforcement: selected.enforcement,
        runnerFailure: { exitCodes: [1, 2, 125], stderrSignature: 'bwrap:' } };
    }
    if (process.platform === 'darwin') {
      return { argv: [executable, '-p', macSeatbeltProfile(policy), ...argv], backend: selected.name, enforcement: selected.enforcement,
        runnerFailure: { exitCodes: [1, 64, 65, 69, 70], stderrSignature: 'sandbox-exec:' } };
    }
    return {
      argv: [executable,
        ...(options.allowElevatedWindowsRunnerForTest ? ['--allow-elevated-parent-for-test'] : []),
        '--mode', policy.mode, '--workspace', policy.workspaceRoot, '--temp', policy.privateTemp, '--', ...argv],
      backend: selected.name, enforcement: selected.enforcement,
      runnerFailure: { exitCodes: [120, 121, 122], stderrSignature: 'FLYT_SANDBOX_RUNNER:' },
    };
  };

  const functionalProbe = async (): Promise<SandboxProbe> => {
    const selected = backend();
    const checkedAt = new Date().toISOString();
    const dir = fs.mkdtempSync(path.join(probeRoot, 'probe-'));
    const workspace = path.join(dir, 'workspace');
    const temp = path.join(dir, 'private-temp');
    const outside = path.join(dir, 'outside-sentinel');
    fs.mkdirSync(workspace); fs.mkdirSync(temp);
    try {
      const node = process.execPath;
      const policy: SandboxPolicy = {
        mode: 'workspace-write', workspaceRoot: workspace, owner: { runId: 'probe', callId: 'probe' },
        privateTemp: temp, minimumEnforcement: selected.enforcement,
      };
      const confined = await wrap([node, '-e', `const f=require('fs');f.writeFileSync(${JSON.stringify(path.join(workspace, 'allowed'))},'ok');try{f.writeFileSync(${JSON.stringify(outside)},'bad')}catch{};if(f.existsSync(${JSON.stringify(outside)}))process.exit(41)`], policy);
      const env = layeredEnv(scrubbedParentEnv(), { TMPDIR: temp, TEMP: temp, TMP: temp }, confined.env ?? {});
      const handle = subprocess.spawn({
        owner: policy.owner, argv: confined.argv as [string, ...string[]], cwd: workspace, env,
        stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 16_384 }, timeoutMs: 15_000, graceMs: 500,
        runnerFailure: confined.runnerFailure,
      });
      const outcome = await handle.done;
      const ok = outcome.exitCode === 0 && !outcome.runnerFailed
        && fs.existsSync(path.join(workspace, 'allowed')) && !fs.existsSync(outside);
      return ok
        ? { platform: process.platform, backend: selected.name, available: true, enforcement: selected.enforcement, checkedAt }
        : { platform: process.platform, backend: selected.name, available: false, enforcement: null, checkedAt,
            reason: outcome.runnerFailed?.detail || handle.stderr.text || `functional probe exited ${outcome.exitCode}` };
    } catch (error) {
      return { platform: process.platform, backend: selected.name, available: false, enforcement: null, checkedAt,
        reason: String((error as Error)?.message ?? error) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  };

  return {
    world,
    async probe(force = false) {
      if (disposed) return Promise.resolve({ platform: process.platform, backend: null, available: false, enforcement: null, checkedAt: new Date().toISOString(), reason: 'provider disposed' });
      let identity: string;
      try {
        const file = await runner();
        const stat = fs.statSync(file);
        identity = `${process.versions.electron ?? process.version}:${process.platform}:${file}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return functionalProbe();
      }
      if (force) successfulProbeCache.delete(identity);
      const existing = successfulProbeCache.get(identity);
      if (existing) return existing;
      const pending = functionalProbe();
      successfulProbeCache.set(identity, pending);
      const result = await pending;
      if (!result.available) successfulProbeCache.delete(identity);
      return result;
    },
    async confine(argv, policy) {
      const probe = await this.probe();
      if (!probe.available) throw new SandboxUnavailableError(probe.reason ?? 'No usable local sandbox backend.', probe);
      if (strength(probe.enforcement) < strength(policy.minimumEnforcement)) {
        throw new SandboxUnavailableError(`Sandbox enforcement ${probe.enforcement} is weaker than required ${policy.minimumEnforcement}.`, probe);
      }
      return wrap(argv, policy);
    },
    async disposeOwner() {},
  };
}

function sbpl(value: string): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function macSeatbeltProfile(policy: Pick<SandboxPolicy, 'mode' | 'workspaceRoot' | 'privateTemp'>): string {
  const writable = policy.mode === 'workspace-write'
    ? `(require-any (subpath ${sbpl(policy.workspaceRoot)}) (subpath ${sbpl(policy.privateTemp)}) (literal "/dev/null"))`
    : `(literal "/dev/null")`;
  // Seatbelt denies take precedence over allows. Express the boundary as one
  // deny whose filter matches only paths outside the writable roots.
  return `(version 1)\n(allow default)\n(deny file-write* (require-not ${writable}))\n`;
}

export const defaultSandboxFacts = (): { backend: SandboxBackend; enforcement: SandboxEnforcement } => {
  if (process.platform === 'linux') return { backend: 'bubblewrap', enforcement: 'full' };
  if (process.platform === 'darwin') return { backend: 'seatbelt', enforcement: 'full' };
  if (process.platform === 'win32') return { backend: 'windows-restricted-token', enforcement: 'partial' };
  return { backend: 'unconfined', enforcement: 'none' };
};
