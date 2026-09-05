// Claude subscription adapter — delegation via the official Claude Code CLI.
//
// No OAuth, no tokens, no Anthropic endpoint: `claude -p` is spawned as a
// child process and authenticates itself from the user's own `/login`
// credential store (~/.claude), exactly the T3-Code pattern the guide
// recommends (DESIGN-SPEC.md §6). We ask it to behave as a
// plain model call: our system prompt REPLACES Claude Code's agentic preamble
// (--system-prompt), every built-in tool is disabled (--tools ""), and no
// session is persisted. The prompt travels over stdin so no user content ever
// passes through argv.
//
// Usage caution: calls made here consume the user's Claude Pro/Max plan
// limits. The main process gates this provider behind an explicit opt-in with
// a warning (Models → Model providers → Claude subscription).
import {
  resolveCli, spawnCliCall, cliEnv, neutralCwd, claudeCredentialStatus, preflightCli
} from './cliDelegate.js';
import { abortError } from './http.js';

export { claudeCredentialStatus };

export function resolveClaudeCli(override = null) {
  return resolveCli({
    override,
    names: ['claude'],
    npmPkg: '@anthropic-ai/claude-code',
    npmEntry: 'cli.js'
  });
}

// Can the Claude CLI launch at all? Filesystem-only, so Settings and `doctor`
// can ask without paying for a model call (WR-05).
export function preflightClaudeCli(override = null) {
  return preflightCli({ override, names: ['claude'], npmPkg: '@anthropic-ai/claude-code', npmEntry: 'cli.js' });
}

// Fixed argv: only the model id and the system prompt vary, and stdin carries
// the user prompt. `--tools ""` (the CLI's documented disable-all form) plus a
// replaced system prompt turns the agent into a single-shot model call.
export function buildClaudeArgs({ model, system }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',                    // required by stream-json in print mode
    '--include-partial-messages',   // real streaming deltas for onText
    '--no-session-persistence',
    '--model', String(model)
  ];
  if (system) args.push('--system-prompt', String(system));
  args.push('--tools', ''); // last: --tools is variadic and would swallow following args
  return args;
}

// stream-json is JSONL; reduce it to { text, usage, result }. Pure — exported
// for the unit tests. Event shapes handled:
//   stream_event + content_block_delta/text_delta — incremental text
//   assistant — a complete assistant message (authoritative for its turn)
//   result — the final envelope: result text, usage, is_error
export function claudeStreamReducer() {
  const state = { text: '', resultText: null, usage: null, isError: false, errorText: '' };
  return {
    state,
    push(line) {
      let evt;
      try { evt = JSON.parse(line); } catch { return false; }
      if (evt.type === 'stream_event') {
        const d = evt.event?.delta;
        if (evt.event?.type === 'content_block_delta' && d?.type === 'text_delta' && d.text) {
          state.text += d.text;
          return true;
        }
        return false;
      }
      if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        const text = evt.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
        if (text) state.text = text;
        if (evt.message.usage) state.usage = { ...(state.usage ?? {}), ...evt.message.usage };
        return Boolean(text);
      }
      if (evt.type === 'result') {
        state.isError = Boolean(evt.is_error) || (evt.subtype && evt.subtype !== 'success');
        if (typeof evt.result === 'string' && evt.result) {
          if (state.isError) state.errorText = evt.result;
          else state.resultText = evt.result;
        }
        if (evt.usage) state.usage = { ...(state.usage ?? {}), ...evt.usage };
        return false;
      }
      return false;
    }
  };
}

// callModel contract (adapters/index.js). apiKey is ignored by design — the
// CLI owns authentication. maxTokens is ignored too: the CLI exposes no cap,
// and the subscription's own limits govern. Extra call fields stamped by the
// main process: cliHome (account selection), cliPath (explicit binary).
export async function claudeCodeAdapter({ model, system, prompt, onText, signal, cliHome = null, cliPath = null, timeoutMs }) {
  const cli = resolveClaudeCli(cliPath);
  if (!cli) {
    throw new Error('Claude Code CLI not found. Install it (e.g. `winget install Anthropic.ClaudeCode` or `npm i -g @anthropic-ai/claude-code`), or set its path in Models → Model providers → Claude subscription.');
  }
  const home = cliHome || null;
  if (!claudeCredentialStatus(home).signedIn) {
    throw new Error('Claude Code is not signed in. Run `claude` in a terminal and use /login with your Claude subscription, then try again.');
  }

  // Scrub every ANTHROPIC_*/CLAUDE_CODE_* variable so the CLI authenticates
  // from the credential store alone: an exported API key must not silently
  // take over billing, and inherited session context (ANTHROPIC_BASE_URL,
  // OAuth scopes — present whenever Flyt itself was launched from a
  // Claude Code session) makes the child 401. CLAUDE_CONFIG_DIR survives. The
  // node-dispatch path (npm shim) needs ELECTRON_RUN_AS_NODE inside Electron.
  const env = cliEnv({
    stripVars: ['CLAUDECODE'],
    stripPrefixes: ['ANTHROPIC_', 'CLAUDE_CODE_'],
    home,
    homeVars: ['HOME', 'USERPROFILE']
  });
  if (cli.viaNode) env.ELECTRON_RUN_AS_NODE = '1';

  const reducer = claudeStreamReducer();
  let stderr = '';
  const { code } = await spawnCliCall({
    ...cli,
    args: [...cli.args, ...buildClaudeArgs({ model, system })],
    stdinText: String(prompt ?? ''),
    cwd: neutralCwd(),
    env,
    signal,
    ...(timeoutMs ? { timeoutMs } : {}),
    onLine: line => { if (reducer.push(line) && onText) onText(reducer.state.text); },
    onStderr: s => { stderr += s; }
  });

  if (signal?.aborted) throw abortError();
  const st = reducer.state;
  if (code !== 0 || st.isError) {
    const detail = (st.errorText || stderr || `exit code ${code}`).trim().slice(0, 500);
    throw new Error(`Claude Code CLI failed: ${detail}`);
  }
  const text = st.resultText ?? st.text;
  if (!text) throw new Error(`Claude Code CLI produced no output${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
  onText?.(text, { final: true });
  return { text, usage: st.usage ?? null };
}

// Same rule as the API adapter: this provider serves claude-* ids. Which of
// the two actually takes a call is the priority walk's decision.
claudeCodeAdapter.canServe = modelId => String(modelId).startsWith('claude-');

// This adapter bounds itself (spawnCliCall's timeoutMs), and the CLI it spawns
// can legitimately go quiet for minutes while a child process works — an idle
// deadline over the top of that would kill healthy runs (DESIGN-SPEC.md §8). A
// stop, and any configured hard ceiling, still reach it through the signal.
claudeCodeAdapter.selfTimed = true;
