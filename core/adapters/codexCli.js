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

export function buildCodexArgs({ model, cwd, lastMessageFile, imagePaths = [] }) {
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
  for (const image of imagePaths) args.push('--image', image);
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

// Native transport: stage only validated inline image bytes in this call's
// isolated read-only workspace. Never substitute a filename for an image flag.
export function stageCodexImages(messages = []) {
  const images = messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
  if (!images.length) return null;
  if (images.length > 10) throw new Error('Codex supports at most 10 attached images per call');
  const root = fs.mkdtempSync(path.join(neutralCwd(), 'images-'));
  const cleanup = () => {
    if (path.dirname(root) !== path.resolve(neutralCwd()) || !path.basename(root).startsWith('images-')) throw new Error('Invalid image staging directory');
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    let size = 0;
    const imagePaths = images.map((part, index) => {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url?.url ?? '');
      if (!match) throw new Error('Codex requires validated inline PNG images');
      size += match[1].length;
      if (size > 20 * 1024 ** 2) throw new Error('Codex image payload exceeds 20 MiB');
      const file = path.join(root, `image-${index + 1}.png`);
      fs.writeFileSync(file, Buffer.from(match[1], 'base64'), { flag: 'wx' });
      return file;
    });
    return { cwd: root, imagePaths, cleanup };
  } catch (error) { cleanup(); throw error; }
}

// callModel contract. apiKey/maxTokens ignored by design (the CLI owns auth;
// the plan owns limits). Extras stamped by the main process: cliHome
// (CODEX_HOME account selection), cliPath (explicit binary).
export async function codexAdapter({ model, system, prompt, messages, tools, onText, signal, cliHome = null, cliPath = null, timeoutMs }) {
  const cli = resolveCodexCli(cliPath);
  if (!cli) {
    throw new Error('Codex CLI not found. Install it (`npm i -g @openai/codex`), or set its path in Models → Model providers → ChatGPT subscription.');
  }
  const home = cliHome || null;
  if (!codexCredentialStatus(home).signedIn) {
    throw new Error('Codex is not signed in. Run `codex login` in a terminal with your ChatGPT account, then try again.');
  }

  const hasImages = messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
  if (hasImages && tools?.length) throw new Error('Codex image delegation cannot execute Flyt tools. Choose an API model for this worker.');
  if (messages?.length) {
    const text = message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : String(message.content ?? '');
    system = messages.filter(message => message.role === 'system').map(text).join('\n\n');
    prompt = messages.filter(message => message.role !== 'system').map(message => `${message.role.toUpperCase()}:\n${text(message)}`).join('\n\n');
  }
  const harnessHome = createCodexHarnessHome(home);
  let staged;

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
    staged = stageCodexImages(messages);
    ({ code } = await spawnCliCall({
      ...cli,
      args: [...cli.args, ...buildCodexArgs({ model, cwd: staged?.cwd ?? neutralCwd(), lastMessageFile: lastMsgFile, imagePaths: staged?.imagePaths })],
      stdinText: composeCodexPrompt(system, prompt),
      cwd: staged?.cwd ?? neutralCwd(),
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
    staged?.cleanup();
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
