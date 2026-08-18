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
  resolveCli, spawnCliCall, cliEnv, neutralCwd, codexCredentialStatus
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

// Reduce `codex exec --json` JSONL to { text, usage }. Pure — exported for the
// unit tests. Handles the current event shapes and the older msg envelope:
//   item.updated / item.completed with item.type 'agent_message' — text
//   turn.completed — usage { input_tokens, cached_input_tokens, output_tokens }
//   turn.failed / error — failure text
//   { msg: { type: 'agent_message', message } } — legacy envelope
export function codexStreamReducer() {
  const state = { text: '', usage: null, errorText: '' };
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
        state.errorText = String(evt.error?.message ?? 'turn failed');
        return false;
      }
      if (evt.type === 'error') {
        state.errorText = String(evt.message ?? 'error');
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
    throw new Error('Codex CLI not found. Install it (`npm i -g @openai/codex`), or set its path in Settings → Providers → ChatGPT subscription.');
  }
  const home = cliHome || null;
  if (!codexCredentialStatus(home).signedIn) {
    throw new Error('Codex is not signed in. Run `codex login` in a terminal with your ChatGPT account, then try again.');
  }

  // The most robust "final answer" channel exec offers: it writes the last
  // agent message to a file. The JSONL stream feeds onText along the way.
  const lastMsgFile = path.join(os.tmpdir(), 'flyt-cli', `codex-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  const env = cliEnv({
    // Same reasoning as the Claude adapter: an exported platform key or
    // base-URL override must not displace the subscription sign-in.
    stripVars: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
    home,
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
      const detail = (st.errorText || stderr || `exit code ${code}`).trim().slice(0, 500);
      throw new Error(`Codex CLI failed: ${detail}`);
    }
    if (!text) throw new Error(`Codex CLI produced no output${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
    onText?.(text, { final: true });
    return { text, usage: st.usage ?? null };
  } finally {
    try { fs.unlinkSync(lastMsgFile); } catch { /* never written */ }
  }
}

// ChatGPT-side ids: gpt-* chat models, o-series, and the codex-tuned models.
codexAdapter.canServe = modelId => /^(gpt-|o\d|codex)/.test(String(modelId));

// Self-bounded like the Claude CLI adapter — see the note there (DESIGN-SPEC.md §8).
codexAdapter.selfTimed = true;
