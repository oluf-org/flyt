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
import { executeTool } from './tools/index.js';

const MAX_ITERATIONS = 8;

export async function runAgent({ worker, apiKey, system, prompt, tools = [], ctx }) {
  const started = Date.now();
  if (!tools.length) {
    const r = await callModel({ ...worker, apiKey, system, prompt });
    return { text: r.text, toolCalls: [], usage: r.usage, durationMs: r.durationMs };
  }
  const native = worker.provider === 'openrouter' && worker.supportsTools;
  const out = native
    ? await nativeLoop({ worker, apiKey, system, prompt, tools, ctx })
    : await textLoop({ worker, apiKey, system, prompt, tools, ctx });
  return { ...out, durationMs: Date.now() - started };
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
async function nativeLoop({ worker, apiKey, system, prompt, tools, ctx }) {
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
    const res = await callModel({ ...worker, apiKey, messages, tools: oaTools });
    usage = addUsage(usage, res.usage);
    lastText = res.text || lastText;
    const calls = res.message?.tool_calls;
    if (!calls?.length) return { text: res.text, toolCalls, usage };

    // Echo the assistant turn back verbatim, then answer each call with a
    // role:'tool' message (result on success, the error on failure so the
    // model can self-correct).
    messages.push({ role: 'assistant', content: res.message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let args, record;
      try { args = JSON.parse(call.function?.arguments || '{}'); }
      catch (err) { record = { tool: call.function?.name, ok: false, error: `Arguments were not valid JSON: ${err.message}`, ms: 0 }; }
      record = record ?? await executeTool(call.function?.name, args, ctx);
      toolCalls.push(record);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(record.ok ? record.result : { error: record.error })
      });
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

async function textLoop({ worker, apiKey, system, prompt, tools, ctx }) {
  const fullSystem = system + '\n\n' + textProtocolInstructions(tools);
  const toolCalls = [];
  let usage = null;
  let transcript = prompt;
  let lastText = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await callModel({ ...worker, apiKey, system: fullSystem, prompt: transcript });
    usage = addUsage(usage, res.usage);
    lastText = res.text;
    const match = res.text.match(TOOL_BLOCK);
    if (!match) return { text: res.text.trim(), toolCalls, usage };

    let record;
    try {
      const parsed = JSON.parse(match[1]);
      record = await executeTool(parsed.tool, parsed.args ?? {}, ctx);
    } catch (err) {
      record = { tool: '(unparsed)', ok: false, error: `Tool block was not valid JSON: ${err.message}`, ms: 0 };
      ctx.store?.appendLog(ctx.runId, { event: 'tool_call', node: ctx.taskId ? `executor:${ctx.taskId}` : undefined, ...record });
    }
    toolCalls.push(record);
    transcript += [
      '',
      '--- your previous reply ---',
      res.text.trim(),
      '',
      `TOOL RESULT (${record.tool}): ${JSON.stringify(record.ok ? record.result : { error: record.error })}`,
      '',
      'Continue. Emit another ```tool block if needed, otherwise produce the final deliverable with no tool block.'
    ].join('\n');
  }
  // Cap reached: strip any dangling tool block from the last reply.
  return { text: (lastText.replace(TOOL_BLOCK, '').trim() || '(agent stopped: tool-call iteration cap reached)'), toolCalls, usage, capped: true };
}
