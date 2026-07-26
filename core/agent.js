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
import { executeTool, isDestructive } from './tools/index.js';

const MAX_ITERATIONS = 8;

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
export const toolProtocol = worker =>
  (NATIVE_TOOL_PROVIDERS.has(worker?.provider) && worker?.supportsTools) ? 'native' : 'text';

export async function runAgent({ worker, apiKey, system, prompt, tools = [], ctx, onText, onRetry, retry, signal = null }) {
  const started = Date.now();
  if (!tools.length) {
    const r = await callModel({ ...worker, apiKey, system, prompt, onText, onRetry, retry, signal });
    return { text: r.text, toolCalls: [], usage: r.usage, durationMs: r.durationMs };
  }
  const native = toolProtocol(worker) === 'native';
  const out = native
    ? await nativeLoop({ worker, apiKey, system, prompt, tools, ctx, onText, onRetry, retry, signal })
    : await textLoop({ worker, apiKey, system, prompt, tools, ctx, onText, onRetry, retry, signal });
  return { ...out, durationMs: Date.now() - started };
}

// What the model is told a call returned. The result may be a bounded preview
// of an artifact on disk (TOOLS-PLAN §13); when it is, the handle note rides
// along so the model knows the rest exists and how to redeem it — a preview
// with no way back to the full result would just make it re-run the call.
function toolMessage(record) {
  const body = JSON.stringify(record.ok ? record.result : { error: record.error });
  return record.note ? `${body}\n${record.note}` : body;
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
async function nativeLoop({ worker, apiKey, system, prompt, tools, ctx, onText, onRetry, retry, signal }) {
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

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // onText rides along, but today's adapters decline to stream a tool-enabled
    // call (the loop needs the raw tool_calls message back, which only the
    // non-streaming response carries) — so this path stays silent until an
    // adapter can reassemble tool_calls from deltas. Honoring the contract here
    // means that becomes an adapter change alone.
    const res = await callModel({ ...worker, apiKey, messages, tools: oaTools, onText, onRetry, retry, signal });
    usage = addUsage(usage, res.usage);
    lastText = res.text || lastText;
    const calls = res.message?.tool_calls;
    if (!calls?.length) return { text: res.text, toolCalls, usage };

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
      toolCalls.push(record);
      messages.push({ role: 'tool', tool_call_id: call.id, content: toolMessage(record) });
    }
  }
  return { text: lastText || '(agent stopped: tool-call iteration cap reached)', toolCalls, usage, capped: true };
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

async function textLoop({ worker, apiKey, system, prompt, tools, ctx, onText, onRetry, retry, signal }) {
  const fullSystem = system + '\n\n' + textProtocolInstructions(tools);
  const toolCalls = [];
  let usage = null;
  let transcript = prompt;
  let lastText = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await callModel({ ...worker, apiKey, system: fullSystem, prompt: transcript, onText, onRetry, retry, signal });
    usage = addUsage(usage, res.usage);
    lastText = res.text;
    const match = res.text.match(TOOL_BLOCK);
    if (!match) return { text: res.text.trim(), toolCalls, usage };

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
    toolCalls.push(record);
    transcript += [
      '',
      '--- your previous reply ---',
      res.text.trim(),
      '',
      `TOOL RESULT (${record.tool}): ${toolMessage(record)}`,
      '',
      'Continue. Emit another ```tool block if needed, otherwise produce the final deliverable with no tool block.'
    ].join('\n');
  }
  // Cap reached: strip any dangling tool block from the last reply.
  return { text: (lastText.replace(TOOL_BLOCK, '').trim() || '(agent stopped: tool-call iteration cap reached)'), toolCalls, usage, capped: true };
}
