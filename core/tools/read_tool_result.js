// read_tool_result: pull more of an earlier tool result back into context —
// all of it, or one narrowed slice — without re-running the call
// (TOOLS-PLAN §13).
//
// Every call writes runs/<id>/tools/<seq>-<tool>.json and the model gets a
// bounded preview plus a handle ("@tool:14"). This is how the handle is
// redeemed. Idempotent, free, read-effect: re-reading an artifact costs a disk
// read, where re-running the call might cost a request, a rate limit, or a
// side effect.
import { previewResult, DEFAULT_MAX_PREVIEW_CHARS } from './preview.js';

const MAX_CHARS = 100_000;

export default {
  name: 'read_tool_result',
  title: 'Read an earlier tool result',
  description: 'Read the full result of an earlier tool call by its handle (e.g. "@tool:14"), optionally narrowed to one part with a jsonPath like "$.stdout" or "$.items[0].name". Use this instead of repeating a call whose result was truncated.',
  effects: ['read'],
  scope: 'run',
  risk: 'safe',
  autoExecute: true,
  keywords: ['result', 'handle', 'truncated', 'full', 'again', 'more'],
  examples: ['read the rest of the command output', 'get the full response body from @tool:14'],
  parameters: {
    type: 'object',
    required: ['handle'],
    additionalProperties: false,
    properties: {
      handle: { type: 'string', description: 'The handle from a previous tool result, e.g. "@tool:14".' },
      jsonPath: { type: 'string', description: 'Optional path into the result, e.g. "$.stdout" or "$.items[0].name". Omit for the whole result.' },
      maxChars: { type: 'integer', minimum: 200, maximum: MAX_CHARS, description: `Optional cap on how much comes back (default ${MAX_CHARS / 10}).` }
    }
  },
  run(args, ctx) {
    if (!ctx?.store?.readToolResult || !ctx.runId) {
      throw new Error('read_tool_result is only available inside a run');
    }
    const seq = parseHandle(args.handle);
    if (seq == null) throw new Error(`"${args.handle}" is not a tool handle — expected something like "@tool:14".`);
    const artifact = ctx.store.readToolResult(ctx.runId, seq);
    if (!artifact) throw new Error(`No tool result ${args.handle} in this run.`);
    if (artifact.ok === false) return { handle: args.handle, tool: artifact.tool, ok: false, error: artifact.error };

    let value = artifact.result;
    if (args.jsonPath) {
      const found = selectPath(value, args.jsonPath);
      if (found.missing) throw new Error(`jsonPath "${args.jsonPath}" does not exist in ${args.handle} (stopped at "${found.at}").`);
      value = found.value;
    }
    // Still bounded: a handle is a way to read more, not a way to bypass the
    // context bound entirely. A caller that needs everything narrows the path.
    const max = args.maxChars ?? MAX_CHARS / 10;
    const { value: bounded, truncated } = previewResult(value, {
      preview: typeof value === 'string' ? 'text' : 'json',
      maxPreviewChars: Math.max(DEFAULT_MAX_PREVIEW_CHARS, max)
    });
    return {
      handle: args.handle, tool: artifact.tool,
      ...(args.jsonPath ? { jsonPath: args.jsonPath } : {}),
      value: bounded,
      ...(truncated ? { truncated: true } : {})
    };
  }
};

// "@tool:14" — and a bare "14", because a model that read the number will
// eventually send just the number.
function parseHandle(handle) {
  const m = String(handle ?? '').trim().match(/^(?:@tool:)?(\d+)$/);
  return m ? Number(m[1]) : null;
}

// A deliberately small JSONPath: "$", dot steps and numeric indices. Anything
// more (filters, wildcards, recursive descent) is a query language, and the
// model can narrow twice instead.
function selectPath(root, path) {
  const steps = String(path).replace(/^\$\.?/, '').match(/[^.[\]]+/g) ?? [];
  let value = root;
  for (const step of steps) {
    if (value == null || typeof value !== 'object') return { missing: true, at: step };
    const key = /^\d+$/.test(step) ? Number(step) : step;
    if (!(key in value)) return { missing: true, at: step };
    value = value[key];
  }
  return { value };
}
