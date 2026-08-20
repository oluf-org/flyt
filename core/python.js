// The Python sidecar: how a Flyt tool borrows a library that is not JavaScript.
//
// Flyt is deliberately dependency-light (D24), and that rule is about the flow
// parser and the core protocol — not about refusing to talk to the rest of the
// world. Some capabilities only exist in Python: adaptive scraping, boilerplate
// stripping, browser impersonation. Reimplementing one of those in-house would
// be a worse trade than shelling out to the library that already does it.
//
// So: one bounded bridge, not a per-tool improvisation. A tool hands this
// module a script and a JSON payload; it spawns an interpreter, writes the
// payload on stdin, reads JSON off stdout, and bounds the whole thing with a
// timeout and an output cap. Nothing else in the app learns to spawn Python.
//
// Two things about it are not incidental:
//
//   THE INTERPRETER IS RESOLVED, NEVER ASSUMED. `python` on PATH is whatever
//   the machine happens to have — a 3.9, a Windows Store stub that opens the
//   app installer, or nothing at all. A tool that fails with
//   "ModuleNotFoundError" has told the model nothing it can act on. So
//   resolution is explicit and reportable (`flyt python status`), and a missing
//   environment is a RESULT with a remedy rather than a stack trace.
//
//   THE ENVIRONMENT LIVES OUTSIDE EVERY REPOSITORY. Same rule as worktrees and
//   the reference library: the managed virtualenv sits under the app's user
//   data directory, so a Loop worker in a throwaway worktree uses the same
//   interpreter as the desktop app, and no checkout ever contains one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Where the managed environment lives. Beside settings.json, i.e. outside every
// checkout and every worktree.
export const managedVenvDir = userDataDir => path.join(String(userDataDir ?? ''), 'python');

// The interpreter inside a virtualenv, per platform layout.
export const venvPython = dir => (process.platform === 'win32'
  ? path.join(dir, 'Scripts', 'python.exe')
  : path.join(dir, 'bin', 'python3'));

const exists = p => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };

// `bin` on PATH — the same dependency-free lookup core/gates.js uses, kept
// separate because that one answers "can this gate run" and this one has to
// return the resolved path so the answer can be reported.
function onPath(bin) {
  if (/[\\/]/.test(bin)) return exists(bin) ? bin : null;
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of ['', ...exts]) {
      const full = path.join(dir, bin + ext);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * Which interpreter a sidecar tool should use, and why that one.
 *
 * The order is "most deliberate first": an env var is someone saying it out
 * loud for this process, a setting is someone saying it once for this install,
 * the managed venv is what `flyt python setup` built, and PATH is the guess.
 * The guess is last because it is the one most likely to be a different Python
 * from the one the packages were installed into.
 *
 * Always returns a record — `{ bin: null }` when there is nothing — so callers
 * report a remedy instead of throwing ENOENT from deep inside a spawn.
 */
export function resolvePython({ userDataDir = null, settings = null, env = process.env } = {}) {
  const fromEnv = String(env?.FLYT_PYTHON ?? '').trim();
  if (fromEnv) {
    return { bin: exists(fromEnv) ? fromEnv : null, source: 'FLYT_PYTHON', declared: fromEnv, managed: false };
  }
  const fromSettings = String(settings?.python?.bin ?? '').trim();
  if (fromSettings) {
    return { bin: exists(fromSettings) ? fromSettings : null, source: 'settings', declared: fromSettings, managed: false };
  }
  if (userDataDir) {
    const managed = venvPython(managedVenvDir(userDataDir));
    if (exists(managed)) return { bin: managed, source: 'managed', declared: managed, managed: true };
  }
  for (const name of ['python3', 'python']) {
    const found = onPath(name);
    if (found) return { bin: found, source: 'path', declared: name, managed: false };
  }
  return { bin: null, source: 'none', declared: null, managed: false };
}

/**
 * Resolution from inside a tool, where the only handle on the installation is
 * `ctx.config` (core/engine.js puts `userDataDir` and `python` there).
 *
 * A one-liner rather than a comment telling every tool author to write the same
 * two lines: the seam is easy to get subtly wrong — pass the settings object
 * instead of `{ python }` and resolution silently skips the pinned interpreter.
 */
export const pythonFor = ctx => resolvePython({
  userDataDir: ctx?.config?.userDataDir ?? null,
  settings: { python: ctx?.config?.python ?? null }
});

// The one sentence a tool should say when there is no interpreter. Kept here so
// every sidecar tool says the same thing and names the same fix.
export const NO_PYTHON_REMEDY =
  'Run `flyt python setup` to build Flyt managed Python environment, or set FLYT_PYTHON to an interpreter that already has the packages installed.';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8_000_000;

/**
 * Run a Python script with a JSON payload on stdin and JSON on stdout.
 *
 * The contract is deliberately narrow, because a wide one becomes a second
 * shell: the caller supplies the SCRIPT TEXT (so what runs is in this
 * repository and reviewable), not a command line. Arguments travel as JSON on
 * stdin rather than as argv, which sidesteps every quoting difference between
 * cmd.exe and sh and keeps a hostile URL out of the command line entirely.
 *
 * Never throws for the script's own failure: a non-zero exit, unparseable
 * output or a timeout comes back as `{ ok: false, ... }` with stderr attached,
 * because the caller is usually a tool whose job is to hand a model something
 * it can read and correct.
 */
export function runPythonScript(script, payload = {}, {
  bin,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd = undefined,
  env = process.env,
  signal = null
} = {}) {
  return new Promise(resolve => {
    if (!bin) {
      resolve({ ok: false, code: null, error: 'no Python interpreter is configured', remedy: NO_PYTHON_REMEDY });
      return;
    }
    let child;
    try {
      // `-I` is isolated mode: no user site-packages, no PYTHON* env
      // influence, no cwd on sys.path. What runs is the interpreter that was
      // resolved and the packages installed beside it — not whatever the
      // working directory happens to contain, which for a Loop worker is a
      // worktree full of a model's files.
      child = spawn(bin, ['-I', '-c', script], {
        cwd,
        // PYTHONIOENCODING so a page in any script comes back as UTF-8 rather
        // than as whatever the console codepage is; unbuffered so a timeout
        // kill does not lose what the script already wrote. Both survive `-I`
        // because they are set on the child rather than inherited.
        env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        windowsHide: true
      });
    } catch (err) {
      resolve({ ok: false, code: null, error: `could not start ${bin}: ${String(err?.message ?? err)}`, remedy: NO_PYTHON_REMEDY });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflowed = false;

    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const onAbort = () => kill();
    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1000, timeoutMs));
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout.on('data', d => {
      outBytes += d.length;
      // Cap what we keep, and stop the script rather than letting a runaway
      // page fill this process's heap. The cap is generous: it exists to bound
      // a pathological case, not to truncate a normal document.
      if (outBytes > MAX_OUTPUT_BYTES) { overflowed = true; kill(); return; }
      outChunks.push(d);
    });
    child.stderr.on('data', d => { if (errChunks.length < 200) errChunks.push(d); });

    child.on('error', err => done({
      ok: false, code: null, error: `could not start ${bin}: ${String(err?.message ?? err)}`, remedy: NO_PYTHON_REMEDY
    }));

    child.on('close', code => {
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      if (timedOut) {
        done({ ok: false, code, error: `the Python step timed out after ${Math.round(timeoutMs / 1000)}s`, stderr });
        return;
      }
      if (overflowed) {
        done({ ok: false, code, error: `the Python step produced more than ${MAX_OUTPUT_BYTES} bytes`, stderr });
        return;
      }
      let value;
      try { value = JSON.parse(stdout); }
      catch {
        done({
          ok: false, code,
          error: code === 0
            ? 'the Python step did not return JSON'
            : `the Python step exited ${code}`,
          // stderr is the actual explanation for a traceback; stdout is the
          // explanation when the script printed prose instead of JSON.
          stderr: stderr || stdout.slice(0, 2000)
        });
        return;
      }
      // The script owns the verdict: it reports `{ ok: false, error }` for a
      // failure it understood (a 403, a bad selector) and this layer only
      // reports the ones it did not survive.
      done({ code, ...(stderr ? { stderr } : {}), ...value, ok: value?.ok !== false && code === 0 });
    });

    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch (err) {
      done({ ok: false, code: null, error: `could not write to ${bin}: ${String(err?.message ?? err)}` });
    }
  });
}

// --- the managed environment ------------------------------------------------

// A `python -c` script that reports the interpreter and which of the named
// packages import, as JSON. Used by status and by the sidecar tools' preflight.
const PROBE = [
  'import json, sys',
  'import importlib.metadata as md',
  'names = json.load(sys.stdin).get("packages") or []',
  'out = {"ok": True, "version": sys.version.split()[0], "executable": sys.executable, "packages": {}}',
  'for n in names:',
  '    try: out["packages"][n] = md.version(n)',
  '    except Exception: out["packages"][n] = None',
  'print(json.dumps(out))'
].join('\n');

/** What interpreter is resolved, and whether the packages a caller needs are there. */
export async function pythonStatus({ userDataDir = null, settings = null, packages = [], env = process.env } = {}) {
  const resolved = resolvePython({ userDataDir, settings, env });
  const base = {
    ...resolved,
    managedDir: userDataDir ? managedVenvDir(userDataDir) : null,
    version: null,
    packages: Object.fromEntries(packages.map(p => [p, null])),
    missing: [...packages],
    remedy: null
  };
  if (!resolved.bin) {
    return {
      ...base,
      ok: false,
      error: resolved.declared
        ? `${resolved.declared} (from ${resolved.source}) is not an executable on this machine`
        : 'no Python interpreter was found',
      remedy: NO_PYTHON_REMEDY
    };
  }
  const probe = await runPythonScript(PROBE, { packages }, { bin: resolved.bin, timeoutMs: 20_000 });
  if (!probe.ok) return { ...base, ok: false, error: probe.error, remedy: NO_PYTHON_REMEDY };
  const missing = packages.filter(p => !probe.packages?.[p]);
  return {
    ...base,
    ok: missing.length === 0,
    version: probe.version ?? null,
    executable: probe.executable ?? resolved.bin,
    packages: probe.packages ?? base.packages,
    missing,
    ...(missing.length
      ? { remedy: `Run \`flyt python setup\` to install: ${missing.join(', ')}.` }
      : {})
  };
}

// Spawn a command and stream its output to `log`, resolving to the exit code.
// Used only by setup, which is a user-invoked install and therefore allowed to
// take minutes and print as it goes.
function spawnLogged(bin, args, { log, cwd, env }) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { cwd, env, windowsHide: true });
    const line = buf => String(buf).split(/\r?\n/).filter(Boolean).forEach(l => log(l));
    child.stdout.on('data', line);
    child.stderr.on('data', line);
    child.on('error', err => { log(String(err?.message ?? err)); resolve(-1); });
    child.on('close', code => resolve(code));
  });
}

/**
 * Build (or top up) the managed environment.
 *
 * Idempotent by construction: creating a venv over an existing one is a no-op
 * for pip's purposes, and `pip install` on a satisfied requirement returns
 * immediately. So "setup" is also "repair" and also "add a package", which is
 * the behaviour anyone actually wants from a command with this name.
 */
export async function setupPython({
  userDataDir,
  packages = [],
  baseBin = null,
  log = () => {},
  env = process.env
} = {}) {
  if (!userDataDir) throw new Error('setupPython needs a user data directory to put the environment in.');
  const dir = managedVenvDir(userDataDir);
  const py = venvPython(dir);

  if (!exists(py)) {
    // The interpreter that BUILDS the venv is not the one resolution returns:
    // resolution prefers the managed venv, which does not exist yet. So a
    // caller may name one, and otherwise we take the best thing on PATH.
    const base = baseBin ?? onPath('python3') ?? onPath('python');
    if (!base) {
      throw new Error('No Python interpreter was found to build the environment from. Install Python 3.10 or newer, or pass --python <path>.');
    }
    log(`creating ${dir} from ${base}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const code = await spawnLogged(base, ['-m', 'venv', dir], { log, env });
    if (code !== 0 || !exists(py)) throw new Error(`Could not create the environment at ${dir} (exit ${code}).`);
  } else {
    log(`using ${dir}`);
  }

  if (packages.length) {
    log(`installing ${packages.join(', ')}`);
    const code = await spawnLogged(py, ['-m', 'pip', 'install', '--disable-pip-version-check', ...packages], { log, env });
    if (code !== 0) throw new Error(`pip install failed (exit ${code}). See the output above.`);
  }
  return { dir, bin: py };
}
