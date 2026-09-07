// read_tool_result: pull more of an earlier tool result back into context —
// all of it, or one narrowed slice — without re-running the call
// (DESIGN-SPEC.md §5).
//
// Canonical calls retain results in session.jsonl (@call:<block>/<call>).
// Legacy runs use tools/<seq>-<tool>.json (@tool:14). This is how a handle is
// redeemed. Idempotent, free, read-effect: re-reading an artifact costs a disk
// read, where re-running the call might cost a request, a rate limit, or a
// side effect.
import { previewResult, DEFAULT_MAX_PREVIEW_CHARS } from './preview.js';
import path from 'node:path';
import { readSessionLogFile } from '#kernel';

const MAX_CHARS = 100_000;

export default {
  name: 'read_tool_result',
  title: 'Read an earlier tool result',
  description: 'Read the full result of an earlier tool call by its handle (e.g. "@call:review/read-1" or legacy "@tool:14"), optionally narrowed to one part with a jsonPath like "$.stdout" or "$.items[0].name". Use this instead of repeating a call whose result was truncated.',
  effects: ['read'],
  // The one tool that must not be previewed again on its way out.
  //
  // It already bounds itself: `maxChars` (default 10,000, ceiling 100,000) is a
  // deliberate, caller-chosen limit. The registry then applied the DEFAULT
  // 2,000-char preview on top, so the tool invented to read more than a preview
  // could never return more than a preview. Watched a run ask for 20,000
  // characters twice, get about a thousand each time, and give up on the whole
  // mechanism in favour of a dozen `bash sed` calls over the same file.
  //
  // Still archived (`artifact: true`, the default): reading a result stays as
  // auditable as producing one, which is a deliberate choice and not an
  // oversight — the log should record what the model actually pulled into its
  // context, not only what the original call returned.
  result: { preview: 'json', maxPreviewChars: 100_000, artifact: true },
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
      handle: { type: 'string', description: 'The exact @call: or @tool: handle from a previous tool result.' },
      jsonPath: { type: 'string', description: 'Optional path into the result, e.g. "$.stdout" or "$.items[0].name". Omit for the whole result.' },
      maxChars: { type: 'integer', minimum: 200, maximum: MAX_CHARS, description: `Optional cap on how much comes back (default ${MAX_CHARS / 10}).` }
    }
  },
  run(args, ctx) {
    if (!ctx?.store?.readToolResult || !ctx.runId) {
      throw new Error('read_tool_result is only available inside a run');
    }
    const canonical = String(args.handle ?? '').match(/^@call:([^/]+)\/([^/]+)$/);
    let artifact;
    if (canonical) {
      const blockId = decodeURIComponent(canonical[1]), callId = decodeURIComponent(canonical[2]);
      const events = readSessionLogFile(path.join(ctx.store.runDir(ctx.runId), 'session.jsonl')).events;
      const result = events.findLast(event => event.type === 'tool.result' && event.data.blockId === blockId && event.data.callId === callId)?.data;
      if (result) artifact = { tool: result.name, ok: !result.error, error: result.error, result: result.result ?? result.content };
    } else {
      const seq = parseHandle(args.handle);
      if (seq == null) throw new Error(`"${args.handle}" is not a tool handle — use the @call: or @tool: handle from an earlier result.`);
      artifact = ctx.store.readToolResult(ctx.runId, seq);
    }
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
