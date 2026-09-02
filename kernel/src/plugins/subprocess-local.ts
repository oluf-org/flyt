import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionWorldDescriptor } from '../seams/execution-world.js';
import type {
  CollectedStream, ProcessHandle, ProcessOutcome, SpawnSpec, SubprocessSeam,
} from '../seams/subprocess.js';
import { scrubbedParentEnv } from '../sandbox/environment.js';

const executable = (file: string): boolean => {
  try { return fs.statSync(file).isFile(); } catch { return false; }
};

function pathEntries(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  return raw.split(path.delimiter).filter(Boolean);
}

function candidates(command: string, env: Readonly<Record<string, string | undefined>>): string[] {
  if (process.platform !== 'win32' || path.extname(command)) return [command];
  const exts = String(env.PATHEXT ?? env.PathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [command, ...exts.map(ext => command + ext.toLowerCase()), ...exts.map(ext => command + ext.toUpperCase())];
}

function collect(maxBytes: number, spillMaxBytes: number | undefined, tempRoot: string, label: string) {
  let tail = Buffer.alloc(0);
  let spillPath: string | undefined;
  let spillBytes = 0;
  let spillOverflow = false;
  const state: CollectedStream = { text: '', truncated: false, bytesSeen: 0 };
  return {
    state,
    push(chunk: Buffer) {
      state.bytesSeen += chunk.length;
      if (spillMaxBytes && !spillOverflow) {
        if (spillBytes + chunk.length <= spillMaxBytes) {
          spillPath ??= path.join(tempRoot, `${label}-${Math.random().toString(36).slice(2)}.log`);
          fs.appendFileSync(spillPath, chunk);
          spillBytes += chunk.length;
          state.spillPath = spillPath;
        } else {
          spillOverflow = true;
          if (spillPath) fs.rmSync(spillPath, { force: true });
          delete state.spillPath;
        }
      }
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > maxBytes) { tail = tail.subarray(tail.length - maxBytes); state.truncated = true; }
      state.text = tail.toString('utf8');
    },
  };
}

export function createLocalSubprocess(
  world: ExecutionWorldDescriptor,
  privateRoot: string,
): SubprocessSeam {
  fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const handles = new Set<ProcessHandle>();
  let disposed = false;

  const resolveExecutable = async (
    command: string,
    env: Readonly<Record<string, string>> = process.env as Record<string, string>,
  ): Promise<string> => {
    const value = String(command ?? '');
    if (!value) throw new Error('Executable name is empty');
    if (path.isAbsolute(value)) {
      if (!executable(value)) throw Object.assign(new Error(`Executable does not exist: ${value}`), { code: 'ENOENT' });
      return value;
    }
    if (value.includes('/') || value.includes('\\')) throw new Error(`Relative executable paths are refused: ${value}`);
    for (const dir of pathEntries(env)) {
      for (const name of candidates(value, env)) {
        const found = path.join(dir, name);
        if (executable(found)) return found;
      }
    }
    throw Object.assign(new Error(`Executable not found on the scrubbed PATH: ${value}`), { code: 'ENOENT' });
  };

  const spawn = (spec: SpawnSpec): ProcessHandle => {
    if (disposed) throw new Error('The subprocess provider is disposed');
    if (!Array.isArray(spec.argv) || !spec.argv.length) throw new Error('Subprocess argv is empty');
    if (!path.isAbsolute(spec.argv[0])) throw new Error('Subprocess argv[0] must be an absolute executable path');
    const env = Object.fromEntries(Object.entries(spec.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
    const ownerDir = path.join(privateRoot, safe(spec.owner.runId), safe(spec.owner.callId));
    fs.mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
    const out = collect(Math.max(1, spec.stdout.maxBytes), spec.stdout.spillMaxBytes, ownerDir, 'stdout');
    const err = collect(Math.max(1, spec.stderr.maxBytes), spec.stderr.spillMaxBytes, ownerDir, 'stderr');
    const child = nodeSpawn(spec.argv[0], [...spec.argv.slice(1)], {
      cwd: spec.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: process.platform === 'win32' && /(?:^|[\\/])cmd\.exe$/i.test(spec.argv[0]),
    });
    let timedOut = false;
    let stopping: Promise<void> | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let abort: (() => void) | null = null;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });

    const terminateTree = async (): Promise<void> => {
      if (settled) return;
      if (process.platform === 'win32' && child.pid) {
        await new Promise<void>(resolve => {
          const killer = nodeSpawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: scrubbedParentEnv() });
          killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} resolve(); });
          killer.once('close', () => resolve());
        });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, Math.max(0, spec.graceMs)))]);
        if (!settled) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
      }
      await closed;
    };

    const done = new Promise<ProcessOutcome>((resolve, reject) => {
      child.once('error', reject);
      child.stdout?.on('data', chunk => out.push(Buffer.from(chunk)));
      child.stderr?.on('data', chunk => err.push(Buffer.from(chunk)));
      child.once('close', (code, signal) => {
        settled = true;
        if (timer) clearTimeout(timer);
        if (abort && spec.signal) spec.signal.removeEventListener('abort', abort);
        resolveClosed();
        let runnerFailed: ProcessOutcome['runnerFailed'];
        const rule = spec.runnerFailure;
        if (rule && code !== null && rule.exitCodes.includes(code) && err.state.text.includes(rule.stderrSignature)) {
          runnerFailed = { code: 'SANDBOX_RUNNER_FAILED', detail: err.state.text.slice(-2000) };
        }
        resolve({ exitCode: code, signal, timedOut, ...(runnerFailed ? { runnerFailed } : {}) });
      });
    });

    const handle: ProcessHandle = {
      pid: child.pid ?? -1,
      owner: { ...spec.owner },
      stdout: out.state,
      stderr: err.state,
      done,
      terminate() { stopping ??= terminateTree(); return stopping; },
      async waitForExit() { await done.then(() => undefined, () => undefined); },
    };
    handles.add(handle);
    void done.finally(() => handles.delete(handle)).catch(() => {});
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin); else child.stdin?.end();
    timer = setTimeout(() => { timedOut = true; void handle.terminate('timeout'); }, Math.max(1, spec.timeoutMs));
    timer.unref?.();
    if (spec.signal) {
      abort = () => { void handle.terminate('aborted'); };
      if (spec.signal.aborted) abort(); else spec.signal.addEventListener('abort', abort, { once: true });
    }
    return handle;
  };

  return {
    world,
    resolveExecutable,
    spawn,
    async terminateOwner(runId: string) {
      await Promise.allSettled([...handles].filter(handle => handle.owner.runId === runId).map(handle => handle.terminate()));
      await Promise.allSettled([...handles].filter(handle => handle.owner.runId === runId).map(handle => handle.waitForExit()));
    },
    active(runId?: string) {
      return [...handles].filter(handle => runId === undefined || handle.owner.runId === runId)
        .map(handle => ({ owner: { ...handle.owner }, pid: handle.pid }));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([...handles].map(handle => handle.terminate('provider disposal')));
      await Promise.allSettled([...handles].map(handle => handle.waitForExit()));
      fs.rmSync(privateRoot, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

const safe = (value: string): string => String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || '_';
