// Agent loop: the unified entry the executor calls instead of a single-shot
// callModel. Picks the execution path per worker:
//   NATIVE — the model supports OpenAI-style function tools (OpenRouter
//            models with worker.supportsTools): send the tool schemas, loop
//            on finish_reason 'tool_calls'.
//   TEXT   — everything else (mock included): inject the tool list into the
//            system prompt and parse one fenced ```tool block per reply.
// Both paths share the same registry, the same validation, the same
// executeTool wrapper, and the same iteration cap.
import { callModel } from './adapters/index.js';
import { classifyAdapterError, mayFallThrough, unparsedToolDialect } from './adapters/failures.js';
import { executeTool, isDestructive } from './tools/index.js';
import { writesWorkspace } from './effect.js';

// How many tool-calling rounds a node gets before it must answer. Eight is
// plenty for "check the time, then write"; it is not enough for "search a
// repository, read four files, then write", which is exactly what a fan-out
// lane over a reference does — observed capping out with nothing but its own
// preamble as the node's output. Raisable per host via config.maxToolIterations.
const MAX_ITERATIONS = 8;

// What the model is told when its last round is up. Without this a capped run
// returns whatever partial text happened to exist — usually "Let me read the
// files in sections", which is not an answer. With it, the model spends its
// final turn writing the best answer it can from what it already read.
/**
 * Where the agent is in its tool budget, said out loud before it runs out.
 *
 * The cap was invisible until the round it bit. A worker would spend forty
 * rounds reading — the whole budget, one narrowing `sed -n` range at a time —
 * and meet LAST_ROUND_NOTICE with the tools already withdrawn, at which point
 * the only thing left to do is write a confident summary of the change it never
 * made. Watched that three times in one evening, on three different models, on
 * tasks all three were capable of.
 *
 * A bounded agent that cannot see its bound will spend it. Two notices, at two
 * thirds and at six sevenths, are enough to change the strategy while there is
 * still budget to act on the change — and few enough not to become noise the
 * model learns to skip.
 */
export const BUDGET_MARKS = [2 / 3, 6 / 7];

/**
 * @param used — rounds spent.
 * @param total — rounds granted.
 * @param wrote — has anything been WRITTEN yet? `null` when the question does
 *   not apply, because the task was granted no tool that can write the
 *   workspace; a read-only task owes an artifact, not a diff, and telling it
 *   to write a file it cannot write is worse than saying nothing.
 */
export function budgetNotice(used, total, { wrote = null } = {}) {
  const left = total - used;
  return [
    `BUDGET: ${used} of ${total} tool rounds used, ${left} left.`,
    'On the last one the tools are withdrawn and only text is accepted, so anything you have not',
    'done by then will not get done.',
    // A fact beats advice. "Stop exploring" is a suggestion the model can agree
    // with while carrying on reading; "you have used two thirds of your budget
    // and changed no file" is the thing it agreed with, measured. Watched an
    // attempt reach 74 tool calls — 38 read_file, 17 glob, 9 bash, 9
    // search_files, and not one write.
    wrote === false
      ? 'YOU HAVE NOT CHANGED A FILE YET. Nothing you have read is work that can be accepted;'
        + ' a run that changes no file produces an empty diff. Write the change now, then verify it.'
      : left <= 2
        ? 'Make the change now, with what you already know.'
        : 'Stop exploring and start producing: make the smallest complete version of the change, then'
          + ' verify it. Re-reading something you have already opened is the most expensive way left'
          + ' to spend this.'
  ].join(' ');
}

/**
 * The names among these tools that can change the project's files.
 *
 * Read off each record's declared effects rather than remembered here, so a
 * tool a plugin contributed is classified by what it says it does. `shell` is
 * deliberately not one: granting bash is how a task is told to run a suite,
 * and treating that as a promise to produce a diff fails honest work.
 */
function writerNames(tools = []) {
  return new Set(tools.filter(t => writesWorkspace(t) === true).map(t => t.name));
}

/** Has this attempt written anything yet? `null` when it was granted no way to. */
function hasWritten(writers, toolCalls) {
  if (!writers.size) return null;
  return toolCalls.some(c => c?.ok !== false && writers.has(c?.tool));
}

const LAST_ROUND_NOTICE = [
  'You have no tool calls left. Do not request another one — any further tool',
  'call will be discarded.',
  'Write your complete final answer now, in full, using only what you have',
  'already read. Where you did not get far enough to be sure, say so plainly',
  'rather than guessing or promising further work.'
].join(' ');

// What a model is told when a turn came back with nothing in it.
//
// A reasoning model can spend an entire turn — and an entire token budget — in
// `reasoning` and emit no `content` at all. Observed against
// deepseek-v4-pro-0813: 6198 of 7628 completion tokens were reasoning. The turn
// costs real money, arrives with finish_reason 'stop' or 'length', and used to
// be reported as `openrouter/<model> returned an empty response` — a hard node
// failure that discarded every tool call the node had already made, which on a
// fan-out lane is several minutes of reading a repository.
//
// One retry, with the budget doubled and the omission named. That covers both
// ways a turn ends up empty: cut off mid-thought (needs room) and thought
// through without writing anything down (needs telling).
const EMPTY_TURN_NUDGE = [
  'Your previous turn returned no content at all — only internal reasoning.',
  'Whatever you worked out did not reach me. Write the answer itself now, as',
  'ordinary text, starting immediately. Do not think further before writing:',
  'lead with your conclusion and add detail after it, so that a truncated reply',
  'is still a useful one.'
].join(' ');

// What a model is told when its whole turn was an attempt to call a tool in a
// syntax this harness does not parse (see toolCallShaped). It does not need
// room or encouragement — it needs to know which shape reaches us, and that the
// last thing it emitted reached nobody.
// What a model is told when it spends its ANSWER-ONLY round asking for tools.
//
// Seen live, and it costs the whole node: an interrogation read 24 files over
// seven rounds, reached its last one with the tools withdrawn and the notice
// delivered, and still came back with four tool calls and zero characters of
// content — reasoning_tokens 0, so it did not think about it either. The loop
// counted the tool calls as a turn, returned empty text, and the node failed as
// "the provider returned no content". The provider was fine. The model simply
// kept doing what the last seven rounds had rewarded.
const WITHDRAWN_TOOLS_NUDGE = [
  'You just requested tool calls, but you have none left — they were DISCARDED and',
  'nothing ran. No further tool call will reach anything, in any format.',
  'Everything you already read is above, in this conversation. Write the complete',
  'final answer now from that, as ordinary text, starting immediately. Where you',
  'did not read far enough to be sure, say so plainly instead of asking again.'
].join(' ');

const UNPARSED_TOOL_NUDGE = [
  'Your previous turn was only a tool call written in a format I cannot read, so no tool ran',
  'and nothing was returned to you. Do not repeat it.',
  'If you need a tool, call it through the tool-calling interface you were given — and only',
  'tools from the list you were given; anything else does not exist here.',
  'Otherwise write your answer now as ordinary text.'
].join(' ');

// The ceiling a recovery attempt may raise a budget to. Generous, because the
// failure it exists to prevent is losing a whole node's work; bounded, because
// an unbounded retry on a model that answers with silence is just a bigger bill.
const RECOVERY_MAX_TOKENS = 32000;

// Did this turn produce anything the loop can use?
/**
 * Is this whole answer just an attempt to call a tool that we did not parse?
 *
 * Models reach for tool syntax we do not speak. Observed from three different
 * models in one run: `<tool>{"tool":"read_file",…}</tool>`,
 * `<tool_calls><invoke name="read_file">…`, and `<tool_call>` wrapping an
 * `<invoke>` of a tool that does not exist here. The native path did not see a
 * tool call (there was none in the response's `tool_calls`), the text path did
 * not match its fenced ```tool block, so the text fell through as CONTENT — and
 * a node whose deliverable is `<tool_call>…</tool_call>` was recorded as having
 * produced one. Four of six task outputs in that run were this.
 *
 * It is the same situation as an empty turn: the model tried to act and nothing
 * came of it. Treating it as an answer is what turns a recoverable turn into a
 * garbage deliverable that flows downstream into the result and the reviewer.
 *
 * Deliberately narrow, in two ways. The WHOLE answer must be the attempt —
 * prose that quotes a tool call while explaining something is a real answer,
 * and a file whose contents include this syntax must survive being written
 * about. And ONLY syntax this harness cannot read: the fenced ```tool block is
 * the text protocol's own contract, parsed a few lines later by textLoop, so
 * treating it as unanswered retries a turn whose tool call was about to run.
 * (Written that way first; three tests said so immediately.)
 */
/**
 * Which unparsed tool-call dialect this turn carried, if any.
 *
 * Distinct from `toolCallShaped`, which asks whether the WHOLE turn was one:
 * that drives a nudge back to the model and only matches when there is nothing
 * else in the reply. This asks whether markup appears ALONGSIDE prose, which is
 * what actually happened — `I believe.<｜DSML｜tool_calls>…` — and drives a
 * problem on the node rather than a retry.
 */
function dialectOf(res) {
  return res?.unparsedToolCall ?? unparsedToolDialect(res?.text);
}

export function toolCallShaped(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  return /^<(tool|tool_call|tool_calls|function_calls|invoke)\b[\s\S]*>$/.test(s);
}

// A tool call IS a usable turn on any round that still has tools — that is the
// loop continuing. On the final round it is not: the tools were withdrawn
// precisely so the model would write, so a turn that asks for more of them has
// produced nothing and the loop must say so rather than returning empty text.
export const answered = (res, { requireText = false } = {}) =>
  (Boolean(String(res?.text ?? '').trim()) && !toolCallShaped(res.text))
  || (!requireText && Boolean(res?.message?.tool_calls?.length));

/**
 * callModel, with one recovery attempt when a turn comes back empty.
 *
 * Returns the recovered turn when the retry worked, and otherwise the ORIGINAL
 * empty turn — with `emptyTurn` describing both attempts, so the caller can
 * fail with evidence instead of the bare word "empty".
 */
export async function callForAnswer(params, onEmpty, { requireText = false } = {}) {
  const first = await callModel(params);
  if (answered(first, { requireText })) return first;

  const budget = Math.min(RECOVERY_MAX_TOKENS, Math.max(2 * (params.maxTokens ?? 4096), 8192));
  // Three different silences, and telling the model the wrong one wastes the one
  // retry it gets: a turn that thought and never wrote needs room and a push to
  // write; a turn that tried to call a tool in a syntax we do not speak needs to
  // be told which syntax we DO speak; and a turn that asked for tools it no
  // longer has needs to be told the calls were thrown away.
  const unparsedToolCall = toolCallShaped(first.text);
  const discardedToolCalls = requireText ? (first.message?.tool_calls?.length ?? 0) : 0;
  const diagnosis = {
    finishReason: first.finishReason ?? null,
    reasoningChars: String(first.reasoning ?? '').length,
    usage: first.usage ?? null,
    maxTokens: params.maxTokens ?? 4096,
    retriedWith: budget,
    ...(unparsedToolCall ? { unparsedToolCall: String(first.text).trim().slice(0, 200) } : {}),
    ...(discardedToolCalls ? { discardedToolCalls } : {})
  };
  onEmpty?.(diagnosis);

  // The nudge goes in as the model's own next instruction, in whichever calling
  // shape this call used.
  const nudge = discardedToolCalls ? WITHDRAWN_TOOLS_NUDGE
    : unparsedToolCall ? UNPARSED_TOOL_NUDGE : EMPTY_TURN_NUDGE;
  const retry = params.messages
    ? { ...params, maxTokens: budget, messages: [...params.messages, { role: 'user', content: nudge }] }
    : { ...params, maxTokens: budget, prompt: `${params.prompt}\n\n${nudge}` };

  const second = await callModel(retry);
  if (answered(second, { requireText })) return { ...second, recoveredFromEmptyTurn: diagnosis };
  return {
    ...first,
    emptyTurn: {
      ...diagnosis,
      retryFinishReason: second.finishReason ?? null,
      retryReasoningChars: String(second.reasoning ?? '').length
    }
  };
}

/**
 * Why a call produced nothing, in one line a human or an agent can act on.
 *
 * The old message named the model and stopped there, which left the only
 * available next step "run it again and see". Every clause here points at a
 * different fix: 'length' means raise the effort/budget, a large reasoning
 * count on 'stop' means the model thought instead of answering, and a large
 * request means the context is the problem.
 */
export function describeEmptyTurn(worker, result) {
  const d = result?.emptyTurn ?? {};
  const bits = [`${worker?.provider}/${worker?.model} returned no content`];
  if (d.finishReason) {
    bits.push(d.finishReason === 'length'
      ? `— the response was cut off at the token budget (finish_reason "length", max_tokens ${d.maxTokens})`
      : `— finish_reason "${d.finishReason}"`);
  }
  if (d.reasoningChars) {
    bits.push(`after spending ${d.reasoningChars} characters on internal reasoning`
      + `${d.usage?.completion_tokens_details?.reasoning_tokens
        ? ` (${d.usage.completion_tokens_details.reasoning_tokens} reasoning tokens)` : ''}`);
  }
  if (d.retriedWith) bits.push(`a retry at max_tokens ${d.retriedWith} also came back empty`);
  // A turn that was a tool call we could not read is a different diagnosis from
  // a turn that produced nothing, and points at a different fix: the model's
  // tool syntax, not its budget or the provider.
  if (d.unparsedToolCall) {
    bits.push(`the turn was a tool call in a format this harness does not parse (${d.unparsedToolCall})`);
    bits.push('The model is not using the tool interface it was given — check that this model supports '
      + 'native tool calling, or that the text protocol\'s fenced `tool` block reached its prompt.');
    return bits.join('; ').replace('; —', ' —');
  }
  // Ran out of tool rounds and spent the last one asking for more. Nothing is
  // wrong with the provider or the model id, and saying so sends the reader to
  // check two things that are both fine.
  if (d.discardedToolCalls) {
    bits.push(`it spent its final answer-only round requesting ${d.discardedToolCalls} more tool call(s), which were discarded`);
    bits.push('The node ran out of tool rounds before it wrote anything. Raise its '
      + '`maxToolIterations`, narrow what it has to read, or give it a model that stops reading when told to.');
    return bits.join('; ').replace('; —', ' —');
  }
  bits.push(d.finishReason === 'length' || d.reasoningChars
    ? 'Raise this node\'s effort, or point it at a model that answers within its budget.'
    : 'Check the provider status and the model id.');
  return bits.join('; ').replace('; —', ' —');
}

// Per-tool-call approval gate (V1 task 4). When the run supplies ctx.approveToolCall
// (an agentTask node flagged approveToolCalls), pause before every DESTRUCTIVE
// tool call and wait for a human decision. Rejection throws a marked error that
// aborts the task — the caller reports it as an abort, not a model failure.
// Which calls are destructive is derived from the tool record's effects/scope
// (core/tools/index.js), and an unknown tool gates: fail-closed.
async function gateToolCall(ctx, name, args) {
  if (!ctx?.approveToolCall || !isDestructive(name)) return;
  const approved = await ctx.approveToolCall({ tool: name, args });
  if (!approved) {
    throw Object.assign(
      new Error(`Tool call "${name}" was rejected at the approval gate — task aborted.`),
      { toolRejected: true }
    );
  }
}

// onText is the adapter streaming contract (adapters/index.js) forwarded to
// every turn of the loop, so a tool-using task is watchable instead of silent
// for minutes (D10). It streams the text of the turn IN PROGRESS: each turn is
// a fresh call, so the accumulated text restarts from empty rather than growing
// across the whole loop. A consumer mirroring it into a file therefore shows
// the current turn — including the ```tool block the agent is about to run —
// and must treat its own write after runAgent returns as the authoritative one.
// Which of the two protocols a worker will use for tools. Exported so callers
// can record it: the audit log said THAT an agent called tools but never HOW,
// so the two paths were indistinguishable after the fact and "did the native
// path actually run?" could only be inferred from the model catalogue.
// Native is available on every OpenAI-compatible provider (openrouter, openai,
// kimi — all backed by the shared factory in http.js); anthropic and mock stay
// on the text protocol.
const NATIVE_TOOL_PROVIDERS = new Set(['openrouter', 'openai', 'kimi']);

/**
 * 'auto' is not a provider, it is a DEFERRAL — the priority walk names the real
 * one at call time. Both checks below compared against the resolved name, so a
 * worker still carrying 'auto' answered "no native tools" and "not tool
 * capable", and every task the LOOP runs carries 'auto', because that is how an
 * effort band is expressed.
 *
 * The cost was the whole point of the system. Watched a task plan seven
 * sub-tasks on `moonshotai/kimi-k3`, run all seven on the text protocol, make
 * ZERO tool calls, mark all seven `done`, and produce no diff — twice, across
 * two nights, with the reviewer correctly rejecting an empty change each time.
 * Nothing in the run said the tools had been switched off.
 *
 * `auto` resolves through providers that are OpenAI-compatible (the shared
 * factory in http.js), so it belongs with them; anthropic and mock are named
 * explicitly by anything that wants them and never arrive as 'auto'.
 */
const nativeCapable = provider => NATIVE_TOOL_PROVIDERS.has(provider) || provider === 'auto';

export const toolProtocol = worker =>
  (nativeCapable(worker?.provider) && worker?.supportsTools) ? 'native' : 'text';

/**
 * Does this model call tools natively?
 *
 * Learned from a provider catalogue when one has been fetched, and that is the
 * whole problem: nothing outside the desktop app's Settings page ever fetches
 * one, so `flyt run` and the loop treated EVERY model as text-protocol.
 * Observed for real: kimi-k2.6 emitted its own `<|tool_calls_section_begin|>`
 * syntax as prose, the text loop did not recognise it, and the node's output
 * was that leaked syntax instead of an analysis.
 *
 * OpenRouter normalises OpenAI-style tool calling across the models it serves,
 * so UNKNOWN there means "probably yes" rather than "no". A catalogue that
 * explicitly says false is still believed.
 */
export function supportsToolsFor(worker, config = {}) {
  const model = worker?.model;
  const known = config.modelCapabilities?.[model] ?? config.modelFacts?.[model]?.supportsTools;
  if (typeof known === 'boolean') return known;
  // 'auto' is an unresolved OpenRouter-backed pick, not a different answer.
  return worker?.provider === 'openrouter' || worker?.provider === 'auto';
}

/**
 * Run one agent turn, falling through to another provider when the RUNTIME —
 * not the request — is what failed (WR-05).
 *
 * `fallback` is `{ source, candidates: [target, ...], onFallback }`. `source` is
 * the REQUESTED source ('auto', or a pinned provider id) — not the resolved
 * one: by the time a worker reaches here an auto route has already been
 * resolved to a concrete provider, so reading the provider off the worker would
 * make every call look pinned and no fallback would ever fire. An
 * infrastructure failure — the vendor CLI missing, or refusing to launch —
 * says nothing about the prompt or the model, so trying the next connected
 * provider is reasonable. Anything else fails where it stands: a bad model id,
 * an expired key or a rate limit will fail identically elsewhere, and quietly
 * spending on a second provider to prove it is the opposite of helpful.
 *
 * Bounded by the candidate list and unable to revisit a provider, so this can
 * never become a loop over the whole priority list.
 */
export async function runAgent(opts) {
  const { fallback = null } = opts;
  const candidates = fallback?.candidates ?? [];
  if (!candidates.length) return runAgentOnce(opts);

  let lastErr;
  const attempts = [{ worker: opts.worker, apiKey: opts.apiKey }, ...candidates.map(t => ({
    worker: { ...opts.worker, provider: t.provider, model: t.model, ...(t.keyKind ? { keyKind: t.keyKind } : {}) },
    apiKey: t.apiKey ?? null
  }))];
  for (let i = 0; i < attempts.length; i++) {
    const { worker, apiKey } = attempts[i];
    try {
      return await runAgentOnce({ ...opts, worker, apiKey, fallback: null });
    } catch (err) {
      lastErr = err;
      const failure = classifyAdapterError(err, { provider: worker.provider, model: worker.model, executable: err?.executable });
      const next = attempts[i + 1];
      // A stop is never a provider failure and is never retried anywhere.
      if (!next || err?.aborted || err?.name === 'AbortError') throw err;
      if (!mayFallThrough(failure.code, fallback.source ?? 'auto')) throw err;
      fallback.onFallback?.({
        from: { provider: worker.provider, model: worker.model },
        to: { provider: next.worker.provider, model: next.worker.model },
        code: failure.code, detail: failure.detail, remedy: failure.remedy
      });
    }
  }
  throw lastErr;
}

async function runAgentOnce({ worker, apiKey, system, prompt, tools = [], ctx, onText, onRetry, onCall, onEmptyTurn, retry, timeout, signal = null, maxIterations = null, maxTokens = null }) {
  const started = Date.now();
  if (!tools.length) {
    const r = await callForAnswer(
      { ...worker, apiKey, system, prompt, onText, onRetry, onCall, retry, timeout, signal, ...(maxTokens ? { maxTokens } : {}) },
      onEmptyTurn
    );
    return {
      text: r.text, toolCalls: [], usage: r.usage, durationMs: r.durationMs,
      finishReason: r.finishReason ?? null,
      // A node holding no tools can still be handed markup by a model that
      // thinks it has some — and this is the path such a node takes, bypassing
      // both loops. Missing it meant the detection worked everywhere except the
      // node kind that produced the original failure.
      ...(dialectOf(r) ? { unparsedToolCall: dialectOf(r) } : {}),
      ...(r.emptyTurn ? { emptyTurn: r.emptyTurn } : {}),
      ...(r.recoveredFromEmptyTurn ? { recoveredFromEmptyTurn: r.recoveredFromEmptyTurn } : {})
    };
  }
  const native = toolProtocol(worker) === 'native';
  // maxTokens travels into the tool loops too. It did not, and the loops fall
  // back to a bare 4096 — so the reasoning headroom D40 added (`effortBudget`,
  // 4096 + 8192) reached every node EXCEPT the ones holding tools, which is
  // every node that does the actual work. On a reasoning model that is fatal
  // rather than tight: `deepseek/deepseek-v4-pro` spent all 4096 on internal
  // reasoning and returned no content, the empty-turn retry doubled to 8192 and
  // came back empty as well, and the task failed with "returned no content" —
  // the exact failure D40 was written to end. The budget was computed correctly
  // by the caller and dropped one function short of the call.
  const args = { worker, apiKey, system, prompt, tools, ctx, onText, onRetry, onCall, onEmptyTurn, retry, timeout, signal, maxIterations, maxTokens };
  const out = native ? await nativeLoop(args) : await textLoop(args);
  return { ...out, durationMs: Date.now() - started };
}

// What the model is told a call returned. The result may be a bounded preview
// of an artifact on disk (DESIGN-SPEC.md §5); when it is, the handle note rides
// along so the model knows the rest exists and how to redeem it — a preview
// with no way back to the full result would just make it re-run the call.
function toolMessage(record, repeat = null) {
  const body = JSON.stringify(record.ok ? record.result : { error: record.error });
  return [whichRoot(record), body, record.note, repeat].filter(Boolean).join('\n');
}

/**
 * How many identical failures before the loop stops letting it happen quietly.
 *
 * Two. The first failure is information and the model deserves a chance to act
 * on it; the second is the model not acting on it, and by the third the round
 * budget is being spent proving that nothing changed.
 */
const REPEAT_NUDGE_AT = 2;

/**
 * The same call, failing the same way, again.
 *
 * A tool error is written to be actionable — `edit_file` says which anchor
 * missed and names the closest line it did find. A model that cannot use that
 * sends the identical call back, gets the identical error, and does it again;
 * nothing in the loop notices, and the round budget goes on it. Watched
 * t-0087 make byte-identical `edit_file` calls three times against the same
 * file and run out of rounds before writing anything, and the CRLF disaster
 * before it had exactly this shape — the difference being that there the tool
 * was wrong, and here the tool was right and unheard.
 *
 * So the repetition is named in the reply, where the model cannot read past it,
 * and it escalates: the second time says the retry will not work and what to do
 * instead, and the third says stop and declare the blockage. That is cheaper
 * than a rung and very much cheaper than a round budget.
 */
export function repeatedToolFailure(priorCalls, record) {
  if (record?.ok !== false) return null;
  const before = priorCalls.filter(c =>
    c?.ok === false && c.tool === record.tool && c.error === record.error).length;
  if (before < REPEAT_NUDGE_AT - 1) return null;
  const nth = before + 1;
  if (nth >= 3) {
    return `STOP. That is the same \`${record.tool}\` call failing the same way ${nth} times. `
      + 'It will not start working. Do something materially different, or say plainly that you are '
      + 'blocked and why — continuing to retry spends the rounds you need for the actual work.';
  }
  return `You have now made this exact \`${record.tool}\` call twice and had the same error twice. `
    + 'Sending it again will fail again. Read the error above — it says precisely what did not match — '
    + 'and either re-read the file to copy the text exactly as it is on disk, or work from a different '
    + 'anchor. Do not repeat the call unchanged.';
}

// WHERE a file result came from, as a visible first line (DECISIONS.md D38).
// The tools have always returned `target`; it was buried in the JSON body among
// the file's contents, which is exactly where nobody reads it. A node holding
// both a subject repository and its own workspace can address the wrong one in
// a single plausible tool call, get a confident answer, and never find out —
// so the answer says which root it came from before it says anything else.
function whichRoot(record) {
  const r = record.ok ? record.result : null;
  if (!r || typeof r !== 'object') return '';
  if (r.target === 'reference') {
    const name = String(r.path ?? '').replace(/^reference:/, '').split('/')[0];
    return `[from reference:${name} — a read-only clone, NOT this project]`;
  }
  if (r.target === 'workspace' || r.target === 'run-workspace') {
    return '[from THIS PROJECT\'s own workspace — not a reference repository]';
  }
  return '';
}

// Merge token usage across loop iterations so retrospectives stay honest.
function addUsage(total, usage) {
  if (!usage) return total;
  const t = total ?? {};
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v === 'number') t[k] = (t[k] ?? 0) + v;
  }
  return t;
}

// --- NATIVE path: OpenAI function-tool format over the messages API ---
async function nativeLoop({ worker, apiKey, system, prompt, tools, ctx, onText, onRetry, onCall, onEmptyTurn, retry, timeout, signal, maxIterations = null, maxTokens = null }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];
  const oaTools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
  const toolCalls = [];
  let usage = null;
  let lastText = '';

  const rounds = Math.max(1, Number(maxIterations ?? MAX_ITERATIONS));
  // Rounds at which the agent is told how much of its budget is gone. Computed
  // once so the marks cannot drift, and shifted off as they are used.
  const warnAt = BUDGET_MARKS.map(f => Math.floor(rounds * f)).filter(n => n > 0 && n < rounds - 1);
  const writers = writerNames(tools);
  for (let i = 0; i < rounds; i++) {
    // The final round is answer-only: the tools are withdrawn AND the model is
    // told why, so it writes instead of asking for another search it cannot get.
    const last = i === rounds - 1;
    if (last) messages.push({ role: 'user', content: LAST_ROUND_NOTICE });
    else if (warnAt.length && i + 1 >= warnAt[0]) {
      messages.push({ role: 'user', content: budgetNotice(i, rounds, { wrote: hasWritten(writers, toolCalls) }) });
      warnAt.shift();
    }
    // onText rides along, but today's adapters decline to stream a tool-enabled
    // call (the loop needs the raw tool_calls message back, which only the
    // non-streaming response carries) — so this path stays silent until an
    // adapter can reassemble tool_calls from deltas. Honoring the contract here
    // means that becomes an adapter change alone.
    const res = await callForAnswer(
      { ...worker, apiKey, messages, ...(last ? {} : { tools: oaTools }), onText, onRetry, onCall, retry, timeout, signal, ...(maxTokens ? { maxTokens } : {}) },
      d => onEmptyTurn?.({ ...d, round: i + 1, of: rounds }),
      // The final round has no tools, so only text can end it.
      { requireText: last }
    );
    usage = addUsage(usage, res.usage);
    lastText = res.text || lastText;
    const calls = res.message?.tool_calls;
    if (!calls?.length || last) {
      return {
        text: res.text || lastText, toolCalls, usage,
        finishReason: res.finishReason ?? null,
        rounds: i + 1,
        // The dialect the ADAPTER could not parse, carried up so the node can
        // report it. Set on the model-call result and nothing propagated it, so
        // the runner read undefined and the problem was never recorded — the
        // detection worked and its only consumer never saw it.
        // The dialect nothing could parse, carried up so the node can report
        // it. Computed HERE rather than taken from the adapter: only the HTTP
        // one sets it, so a registered provider, the mock and the CLI delegates
        // produced none of it. This is the single place every provider's turn
        // passes through, which is where a fact about every provider belongs.
        ...(!toolCalls.length && dialectOf(res) ? { unparsedToolCall: dialectOf(res) } : {}),
        ...(res.emptyTurn ? { emptyTurn: res.emptyTurn } : {}),
        ...(res.recoveredFromEmptyTurn ? { recoveredFromEmptyTurn: res.recoveredFromEmptyTurn } : {}),
        ...(last ? { capped: true } : {})
      };
    }

    // Echo the assistant turn back verbatim, then answer each call with a
    // role:'tool' message (result on success, the error on failure so the
    // model can self-correct).
    messages.push({ role: 'assistant', content: res.message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name;
      let args, record;
      try { args = JSON.parse(call.function?.arguments || '{}'); }
      catch (err) { record = { tool: name, ok: false, error: `Arguments were not valid JSON: ${err.message}`, ms: 0 }; }
      if (!record) {
        await gateToolCall(ctx, name, args); // may throw toolRejected to abort the task
        record = await executeTool(name, args, ctx);
      }
      const repeat = repeatedToolFailure(toolCalls, record);
      if (repeat) {
        ctx?.store?.appendLog?.(ctx.runId, {
          event: 'tool_repeat', node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
          tool: record.tool, error: String(record.error ?? '').slice(0, 200)
        });
      }
      toolCalls.push(record);
      messages.push({ role: 'tool', tool_call_id: call.id, content: toolMessage(record, repeat) });
    }
  }
  return { text: lastText || '(agent stopped: tool-call iteration cap reached)', toolCalls, usage, rounds, capped: true };
}

// --- TEXT path: fenced ```tool blocks parsed out of plain completions ---
const TOOL_BLOCK = /```tool\s*\n([\s\S]*?)```/;

export function textProtocolInstructions(tools) {
  return [
    'TOOL PROTOCOL: you can use tools by emitting a fenced block.',
    'Available tools (arguments must match the JSON Schema exactly):',
    ...tools.map(t => `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.parameters)}`),
    'To call a tool, reply with EXACTLY ONE block of this form and nothing after it:',
    '```tool',
    '{"tool":"<name>","args":{...}}',
    '```',
    'You will receive the result in the next message and can then call another tool.',
    'When no more tool calls are needed, reply with the final deliverable and NO tool block.'
  ].join('\n');
}

async function textLoop({ worker, apiKey, system, prompt, tools, ctx, onText, onRetry, onCall, onEmptyTurn, retry, timeout, signal, maxIterations = null, maxTokens = null }) {
  const fullSystem = system + '\n\n' + textProtocolInstructions(tools);
  const toolCalls = [];
  let usage = null;
  let transcript = prompt;
  let lastText = '';

  // Honours a caller's own cap the way nativeLoop does. It did not, which made
  // `maxIterations` mean "8" on every text-protocol provider — silently, since
  // the loop still terminated. A caller that budgets itself (the fan-out peek,
  // DECISIONS.md D37) needs the bound to hold on both protocols.
  const rounds = Math.max(1, Number(maxIterations ?? MAX_ITERATIONS));
  // Same budget notices as the native path. A text-protocol model runs out of
  // rounds the same way and had the same blind spot.
  const warnAt = BUDGET_MARKS.map(f => Math.floor(rounds * f)).filter(n => n > 0 && n < rounds - 1);
  const writers = writerNames(tools);
  for (let i = 0; i < rounds; i++) {
    // The last round is answer-only here too. The native path has said so since
    // it was written; this one never did, so a text-protocol model reaching its
    // cap emitted one more tool block into the void and the loop returned
    // whatever prose happened to surround it — "Let me read the next file", or
    // the placeholder below. Same notice, and the protocol instructions come
    // off with it: telling a model it may call tools and then discarding the
    // call is how you get the call.
    const last = i === rounds - 1;
    const res = await callForAnswer(
      {
        ...worker, apiKey,
        system: last ? system : fullSystem,
        prompt: last
          ? `${transcript}\n\n${LAST_ROUND_NOTICE}`
          : (warnAt.length && i + 1 >= warnAt[0]
            ? `${transcript}\n\n${budgetNotice(i, rounds, { wrote: hasWritten(writers, toolCalls) })}`
            : transcript),
        onText, onRetry, onCall, retry, timeout, signal, ...(maxTokens ? { maxTokens } : {})
      },
      d => onEmptyTurn?.({ ...d, round: i + 1, of: rounds })
    );
    if (warnAt.length && i + 1 >= warnAt[0] && !last) warnAt.shift();
    usage = addUsage(usage, res.usage);
    lastText = res.text;
    const match = last ? null : res.text.match(TOOL_BLOCK);
    if (!match) {
      // A dangling tool block on the answer-only round is a call nobody will
      // run, so it never belongs in the deliverable.
      const text = last ? res.text.replace(TOOL_BLOCK, '').trim() : res.text.trim();
      return {
        text, toolCalls, usage,
        finishReason: res.finishReason ?? null,
        rounds: i + 1,
        ...(last ? { capped: true } : {}),
        // The dialect the ADAPTER could not parse, carried up so the node can
        // report it. Set on the model-call result and nothing propagated it, so
        // the runner read undefined and the problem was never recorded — the
        // detection worked and its only consumer never saw it.
        // The dialect nothing could parse, carried up so the node can report
        // it. Computed HERE rather than taken from the adapter: only the HTTP
        // one sets it, so a registered provider, the mock and the CLI delegates
        // produced none of it. This is the single place every provider's turn
        // passes through, which is where a fact about every provider belongs.
        ...(!toolCalls.length && dialectOf(res) ? { unparsedToolCall: dialectOf(res) } : {}),
        ...(res.emptyTurn ? { emptyTurn: res.emptyTurn } : {}),
        ...(res.recoveredFromEmptyTurn ? { recoveredFromEmptyTurn: res.recoveredFromEmptyTurn } : {})
      };
    }

    let record;
    try {
      const parsed = JSON.parse(match[1]);
      await gateToolCall(ctx, parsed.tool, parsed.args ?? {}); // may throw toolRejected to abort the task
      record = await executeTool(parsed.tool, parsed.args ?? {}, ctx);
    } catch (err) {
      if (err.toolRejected) throw err; // the abort must propagate, not be logged as a bad tool block
      record = { tool: '(unparsed)', ok: false, error: `Tool block was not valid JSON: ${err.message}`, ms: 0 };
      ctx.store?.appendLog(ctx.runId, { event: 'tool_call', node: ctx.taskId ? `executor:${ctx.taskId}` : undefined, ...record });
    }
    const repeat = repeatedToolFailure(toolCalls, record);
    if (repeat) {
      ctx.store?.appendLog?.(ctx.runId, {
        event: 'tool_repeat', node: ctx.taskId ? `executor:${ctx.taskId}` : undefined,
        tool: record.tool, error: String(record.error ?? '').slice(0, 200)
      });
    }
    toolCalls.push(record);
    transcript += [
      '',
      '--- your previous reply ---',
      res.text.trim(),
      '',
      `TOOL RESULT (${record.tool}): ${toolMessage(record, repeat)}`,
      '',
      'Continue. Emit another ```tool block if needed, otherwise produce the final deliverable with no tool block.'
    ].join('\n');
  }
  // Cap reached: strip any dangling tool block from the last reply.
  return { text: (lastText.replace(TOOL_BLOCK, '').trim() || '(agent stopped: tool-call iteration cap reached)'), toolCalls, usage, rounds, capped: true };
}
