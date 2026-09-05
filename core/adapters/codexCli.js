// ChatGPT subscription adapter — delegation via the official Codex CLI.
//
// Same delegation model as claudeCode.js (DESIGN-SPEC.md §6
// 4): `codex exec` runs as a child process and authenticates itself from the
// auth.json its own `codex login` wrote (CODEX_HOME selects the account); we
// never see a token. The call is fenced in: read-only sandbox, an empty
// neutral working directory, --ephemeral so no session files pile up. Codex
// has no system-prompt flag, so the system text rides ahead of the task in
// the stdin prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveCli, spawnCliCall, cliEnv, neutralCwd, codexCredentialStatus, preflightCli
} from './cliDelegate.js';
import { abortError } from './http.js';

export { codexCredentialStatus };

export function resolveCodexCli(override = null) {
  const found = resolveCli({
    override,
    names: ['codex'],
    npmPkg: '@openai/codex',
    npmEntry: 'bin/codex.js'
  });
  if (found || override) return found;
  return null;
}

// Can the Codex CLI launch at all? This is the check that would have caught
// the real `spawn EPERM` in Settings instead of mid-run (WR-05).
export function preflightCodexCli(override = null) {
  return preflightCli({ override, names: ['codex'], npmPkg: '@openai/codex', npmEntry: 'bin/codex.js' });
}

export function buildCodexArgs({ model, cwd, lastMessageFile }) {
  const args = [
    'exec',
    '--json',
    '--ephemeral',            // don't persist session files for these calls
    '--skip-git-repo-check',  // the neutral cwd is not a repo, by design
    '--color', 'never',
    '-s', 'read-only',        // the model must not execute writes; Flyt owns tools
    '-C', String(cwd),
    '-o', String(lastMessageFile)
  ];
  if (model) args.push('-m', String(model));
  args.push('-'); // prompt from stdin
  return args;
}

// Codex has no system-prompt flag in exec mode; compose one prompt.
export function composeCodexPrompt(system, prompt) {
  const p = String(prompt ?? '');
  const s = String(system ?? '').trim();
  if (!s) return p;
  return `SYSTEM INSTRUCTIONS (follow these strictly for the task below):\n${s}\n\n---\n\nTASK:\n${p}`;
}

const CODEX_HARNESS_HOME_PREFIX = 'flyt-codex-home-';

/**
 * Give delegated calls a deliberately small Codex home: the official CLI's
 * sign-in, and no user config. Flyt selects the model and safety boundary for
 * these calls itself; inheriting config.toml can both change that contract and
 * make an older installed CLI fail on a newer desktop-only setting.
 *
 * A hard link keeps credential refreshes owned by the CLI and avoids reading
 * auth.json into this process. Cross-volume custom homes fall back to an
 * opaque filesystem copy; the contents are never parsed or logged.
 */
export function createCodexHarnessHome(home = null) {
  const credential = codexCredentialStatus(home);
  if (!credential.signedIn) throw new Error('Codex is not signed in.');
  const harnessHome = fs.mkdtempSync(path.join(os.tmpdir(), CODEX_HARNESS_HOME_PREFIX));
  const harnessAuth = path.join(harnessHome, 'auth.json');
  try {
    try {
      fs.linkSync(credential.detail, harnessAuth);
    } catch {
      fs.copyFileSync(credential.detail, harnessAuth);
      try { fs.chmodSync(harnessAuth, 0o600); } catch { /* best effort on Windows */ }
    }
    return harnessHome;
  } catch (error) {
    removeCodexHarnessHome(harnessHome);
    throw error;
  }
}

export function removeCodexHarnessHome(harnessHome) {
  const resolved = path.resolve(String(harnessHome ?? ''));
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(CODEX_HARNESS_HOME_PREFIX)) return false;
  fs.rmSync(resolved, { recursive: true, force: true });
  return true;
}

// Reduce `codex exec --json` JSONL to { text, usage }. Pure — exported for the
// unit tests. Handles the current event shapes and the older msg envelope:
//   item.updated / item.completed with item.type 'agent_message' — text
//   turn.completed — usage { input_tokens, cached_input_tokens, output_tokens }
//   turn.failed / error — failure text
//   { msg: { type: 'agent_message', message } } — legacy envelope
function codexErrorDetail(value) {
  const raw = String(value ?? 'error');
  try {
    const payload = JSON.parse(raw);
    return {
      message: String(payload?.error?.message ?? payload?.message ?? raw),
      status: Number(payload?.status) || null
    };
  } catch {
    return { message: raw, status: null };
  }
}

export function codexFailureError(state, stderr = '', code = null) {
  const detail = (state?.errorText || stderr || `exit code ${code}`).trim().slice(0, 500);
  const error = new Error(`Codex CLI failed: ${detail}`);
  if (state?.errorStatus) error.status = state.errorStatus;
  return error;
}

export function codexStreamReducer() {
  const state = { text: '', usage: null, errorText: '', errorStatus: null };
  return {
    state,
    push(line) {
      let evt;
      try { evt = JSON.parse(line); } catch { return false; }
      const item = evt.item;
      if ((evt.type === 'item.completed' || evt.type === 'item.updated') && item?.type === 'agent_message') {
        const text = item.text ?? item.message ?? '';
        if (text) { state.text = text; return true; }
        return false;
      }
      if (evt.type === 'turn.completed' && evt.usage) {
        const u = evt.usage;
        state.usage = {
          input_tokens: (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0),
          output_tokens: u.output_tokens ?? 0
        };
        return false;
      }
      if (evt.type === 'turn.failed') {
        const detail = codexErrorDetail(evt.error?.message ?? 'turn failed');
        state.errorText = detail.message;
        state.errorStatus = detail.status;
        return false;
      }
      if (evt.type === 'error') {
        const detail = codexErrorDetail(evt.message ?? 'error');
        state.errorText = detail.message;
        state.errorStatus = detail.status;
        return false;
      }
      if (evt.msg?.type === 'agent_message' && evt.msg.message) {
        state.text = String(evt.msg.message);
        return true;
      }
      return false;
    }
  };
}

// callModel contract. apiKey/maxTokens ignored by design (the CLI owns auth;
// the plan owns limits). Extras stamped by the main process: cliHome
// (CODEX_HOME account selection), cliPath (explicit binary).
export async function codexAdapter({ model, system, prompt, onText, signal, cliHome = null, cliPath = null, timeoutMs }) {
  const cli = resolveCodexCli(cliPath);
  if (!cli) {
    throw new Error('Codex CLI not found. Install it (`npm i -g @openai/codex`), or set its path in Models → Model providers → ChatGPT subscription.');
  }
  const home = cliHome || null;
  if (!codexCredentialStatus(home).signedIn) {
    throw new Error('Codex is not signed in. Run `codex login` in a terminal with your ChatGPT account, then try again.');
  }

  const harnessHome = createCodexHarnessHome(home);

  // The most robust "final answer" channel exec offers: it writes the last
  // agent message to a file. The JSONL stream feeds onText along the way.
  const lastMsgFile = path.join(os.tmpdir(), 'flyt-cli', `codex-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  const env = cliEnv({
    // Same reasoning as the Claude adapter: an exported platform key or
    // base-URL override must not displace the subscription sign-in.
    stripVars: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
    home: harnessHome,
    homeVars: ['CODEX_HOME']
  });
  if (cli.viaNode) env.ELECTRON_RUN_AS_NODE = '1';

  const reducer = codexStreamReducer();
  let stderr = '';
  let code;
  try {
    ({ code } = await spawnCliCall({
      ...cli,
      args: [...cli.args, ...buildCodexArgs({ model, cwd: neutralCwd(), lastMessageFile: lastMsgFile })],
      stdinText: composeCodexPrompt(system, prompt),
      cwd: neutralCwd(),
      env,
      signal,
      ...(timeoutMs ? { timeoutMs } : {}),
      onLine: line => { if (reducer.push(line) && onText) onText(reducer.state.text); },
      onStderr: s => { stderr += s; }
    }));

    if (signal?.aborted) throw abortError();
    const st = reducer.state;
    let text = st.text;
    try {
      const fromFile = fs.readFileSync(lastMsgFile, 'utf8').trim();
      if (fromFile) text = fromFile;
    } catch { /* no file — fall back to the streamed text */ }

    if (code !== 0 || st.errorText) {
      throw codexFailureError(st, stderr, code);
    }
    if (!text) throw new Error(`Codex CLI produced no output${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
    onText?.(text, { final: true });
    return { text, usage: st.usage ?? null };
  } finally {
    try { fs.unlinkSync(lastMsgFile); } catch { /* never written */ }
    removeCodexHarnessHome(harnessHome);
  }
}

// ChatGPT-side ids: gpt-* chat models, o-series, and the codex-tuned models.
codexAdapter.canServe = modelId => /^(gpt-|o\d|codex)/.test(String(modelId));

// Codex exec is itself an agent. We fence it into a neutral read-only
// directory so it cannot bypass Flyt's tool ceiling, which also means it
// cannot be used as a Flyt tool-loop worker: it will inspect that neutral
// directory with its own tools instead of emitting Flyt's text-tool protocol.
// It remains valid for plain model calls and diff review.
codexAdapter.flytTools = false;

// Self-bounded like the Claude CLI adapter — see the note there (DESIGN-SPEC.md §8).
codexAdapter.selfTimed = true;
