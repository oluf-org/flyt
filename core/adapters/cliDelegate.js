// Shared machinery for the subscription (CLI-delegation) adapters.
//
// The delegation model (DESIGN-SPEC.md §6): Flyt never touches an
// OAuth token. Each provider's official CLI — `claude` (Claude Code) and
// `codex` — is the authentication authority; it finds, refreshes, and uses the
// credentials its own `login` flow stored on disk. We spawn it as a child
// process, hand it the prompt on stdin, and read its structured output. The
// only auth-relevant thing we control is WHICH credential store the child sees
// (an optional home-directory override, for multi-account setups).
//
// Everything here is Electron-free and network-free so the unit tests can
// exercise the pure parts (path resolution, credential detection) directly.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abortError } from './http.js';

const isWin = process.platform === 'win32';

// --- Executable resolution ---------------------------------------------------
// A CLI can arrive many ways (winget/native installer = real .exe, npm = a
// .cmd shim Windows Node refuses to spawn without a shell). Rather than run
// anything through cmd.exe — whose argument quoting is unsafe for arbitrary
// content — we resolve to something spawnable directly:
//   1. an explicit user-configured path (Settings → the provider card)
//   2. a real executable on PATH (claude.exe, codex, …)
//   3. the JS entry behind an npm shim, run via this process's own node
//      (ELECTRON_RUN_AS_NODE for a packaged app; plain node is already node).

// All PATH entries holding any of `names`, in PATH order.
export function findOnPath(names, envPath = process.env.PATH ?? '') {
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  const hits = [];
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try { if (fs.statSync(p).isFile()) hits.push(p); } catch { /* not here */ }
    }
  }
  return hits;
}

// The JS entry an npm .cmd shim dispatches to, if it exists next to the shim.
export function npmShimScript(shimPath, pkg, entry) {
  const p = path.join(path.dirname(shimPath), 'node_modules', ...pkg.split('/'), entry);
  return fs.existsSync(p) ? p : null;
}

// Resolve one CLI to { command, args } ready for spawn (no shell). `override`
// is the user's explicit path; it may point at an .exe or a .js entry.
// Returns null when nothing spawnable was found.
export function resolveCli({ override, names, npmPkg, npmEntry }) {
  const asSpawnable = p => {
    if (!p) return null;
    if (/\.(cmd|bat)$/i.test(p)) {
      // A shim we can't spawn safely — dispatch to the JS entry behind it.
      const js = npmPkg ? npmShimScript(p, npmPkg, npmEntry) : null;
      return js ? { command: process.execPath, args: [js], viaNode: true } : null;
    }
    if (/\.m?js$/i.test(p)) return { command: process.execPath, args: [p], viaNode: true };
    return { command: p, args: [] };
  };
  if (override) return asSpawnable(String(override).trim()) ?? null;
  // On Windows only .exe/.cmd are spawnable candidates — npm also drops an
  // extensionless bash shim next to the .cmd, which CreateProcess can't run.
  const hits = findOnPath(isWin ? names.flatMap(n => [`${n}.exe`, `${n}.cmd`]) : names);
  // Prefer a directly spawnable hit anywhere on PATH over an earlier shim.
  for (const hit of hits) {
    if (!/\.(cmd|bat)$/i.test(hit)) return asSpawnable(hit);
  }
  for (const hit of hits) {
    const s = asSpawnable(hit);
    if (s) return s;
  }
  return null;
}

// --- Credential detection ----------------------------------------------------
// "Signed in" means the vendor CLI's own login flow left its credential store
// behind. We only check for presence — never read, parse, or log the contents
// (DESIGN-SPEC.md §6).

// Claude Code: ~/.claude/.credentials.json (Windows/Linux). On macOS the token
// usually lives in the keychain, but ~/.claude.json still records the OAuth
// account — accept either sign.
export function claudeCredentialStatus(home = null) {
  const base = home || os.homedir();
  // CLAUDE_CONFIG_DIR relocates the whole config dir; an explicit home
  // override (account selection) still wins over it.
  const configDir = (!home && process.env.CLAUDE_CONFIG_DIR) || path.join(base, '.claude');
  const credFile = path.join(configDir, '.credentials.json');
  if (fs.existsSync(credFile)) return { signedIn: true, detail: credFile };
  const stateFile = path.join(base, '.claude.json');
  try {
    if (fs.readFileSync(stateFile, 'utf8').includes('"oauthAccount"')) {
      return { signedIn: true, detail: stateFile };
    }
  } catch { /* no state file — not signed in */ }
  return { signedIn: false, detail: credFile };
}

// Codex: $CODEX_HOME/auth.json (default ~/.codex), written by `codex login`.
export function codexCredentialStatus(home = null) {
  const base = home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const authFile = path.join(base, 'auth.json');
  return { signedIn: fs.existsSync(authFile), detail: authFile };
}

// --- Neutral working directory ----------------------------------------------
// The CLIs are agents; run them somewhere empty so they cannot wander into the
// user's project (Flyt supplies all context in the prompt) and leave no
// per-project state behind.
let neutralDir = null;
export function neutralCwd() {
  if (!neutralDir) {
    neutralDir = path.join(os.tmpdir(), 'flyt-cli');
    fs.mkdirSync(neutralDir, { recursive: true });
  }
  return neutralDir;
}

// --- Spawn + collect ---------------------------------------------------------
// Run the CLI once: prompt on stdin, JSONL on stdout (onLine per parsed-ish
// line), stderr collected for error messages. Honors the runner's AbortSignal
// (RUN-CONTROL stop()) and a hard timeout so a wedged CLI can't hang a node
// forever. Resolves { code }; rejects with abortError() on stop.
export function spawnCliCall({ command, args, stdinText = '', env = process.env, cwd, signal, timeoutMs = 600_000, onLine, onStderr }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(command, args, { cwd: cwd ?? neutralCwd(), env, windowsHide: true });

    let settled = false;
    const settle = fn => (...a) => { if (!settled) { settled = true; cleanup(); fn(...a); } };

    const killTree = () => {
      try {
        if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch { /* already gone */ }
    };
    const onAbort = () => { killTree(); fail(abortError()); };
    const timer = setTimeout(() => {
      killTree();
      fail(new Error(`CLI call timed out after ${Math.round(timeoutMs / 1000)}s (${path.basename(command)})`));
    }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const done = settle(resolve);
    const fail = settle(reject);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', err => {
      fail(err.code === 'ENOENT'
        ? new Error(`Could not launch "${command}" — is the CLI installed and on PATH?`)
        : err);
    });

    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine?.(line);
      }
    });
    child.stderr.on('data', chunk => onStderr?.(chunk.toString('utf8')));

    child.on('close', code => {
      if (buf.trim()) onLine?.(buf.trim()); // trailing line without newline
      done({ code });
    });

    child.stdin.on('error', () => { /* CLI exited before reading stdin — close reports it */ });
    child.stdin.end(stdinText);
  });
}

// A child environment for the vendor CLI. Two jobs:
//   - drop the provider's auth/session variables, so the CLI authenticates
//     with the user's stored SUBSCRIPTION credentials rather than an API key,
//     token, or base-URL override that happens to be exported in the shell
//     (Flyt itself launched from a Claude Code session exports exactly
//     such context, and the inherited values 401 the child);
//   - optionally repoint the home directory, which is how an account is
//     selected (a credential store IS an account — guide Part 4 §4).
export function cliEnv({ stripVars = [], stripPrefixes = [], home = null, homeVars = [] } = {}) {
  const env = { ...process.env };
  for (const v of Object.keys(env)) {
    if (stripVars.includes(v) || stripPrefixes.some(p => v.startsWith(p))) delete env[v];
  }
  if (home) for (const v of homeVars) env[v] = home;
  return env;
}
