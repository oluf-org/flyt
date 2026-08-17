// read_file: read a text file from the workspace (the bound target project, or
// the run sandbox when unbound). Confined to the workspace root. Large files
// are truncated so a single read can't blow the model's context window.
import { fileHost, readText } from './fileHost.js';

const MAX_CHARS = 200_000;

export default {
  name: 'read_file',
  title: 'Read a file',
  description: [
    'Read a text file from the workspace (the bound target project). Forward-slash relative path',
    'like "src/app.js"; confined to the workspace root. Returns the file contents (large files are',
    'truncated — the result says where it stopped, and `offset` reads on from there). A path',
    'beginning "reference:" reads from the READ-ONLY reference library instead,',
    'e.g. "reference:opencode/packages/opencode/src/server/server.ts" — use search_references to',
    'find one.'
  ].join(' '),
  effects: ['read'],
  risk: 'safe',
  autoExecute: true,
  keywords: ['read', 'file', 'open', 'source', 'contents'],
  examples: ['read src/app.js', 'show me what is in the config file'],
  parameters: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        description: 'Relative path inside the workspace, e.g. "src/app.js" — or "reference:<repo>/<path>" for the read-only reference library.'
      },
      // The tail of a long file used to be unreachable: the read stopped at the
      // cap and there was no second call that could start anywhere else. One
      // number fixes it, and the truncation marker names the number to pass.
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Character to start reading from. Use the offset named in a previous truncation marker to read the rest of a long file.'
      }
    }
  },
  run(args, ctx) {
    // The reference library (LOOP-PLAN §16.1): a second, read-only root beside
    // the workspace. It is a separate path rather than a mounted directory
    // precisely so no write tool can reach it — none of them know the prefix,
    // and there is no write path in ReferenceLibrary to reach if they did.
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    if (String(args.path ?? '').startsWith('reference:')) {
      if (!ctx?.references) throw new Error('No reference library is available in this run.');
      const content = ctx.references.read(args.path, { offset });
      if (content == null) throw new Error(`Reference "${args.path}" not found. Use search_references to find a path.`);
      return {
        path: args.path,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        target: 'reference',
        readOnly: true,
        ...(offset ? { offset } : {})
      };
    }
    const host = fileHost(ctx);
    // A node pointed at a subject repository just read a path out of THIS
    // project instead (HOME-CONTEXT §0.1). Not blocked — comparing the subject
    // against home is legitimate, and a lane may do it on purpose — but it is
    // one plausible tool call away from a confident finding about the wrong
    // repository, so it must not be invisible in the run log.
    if (ctx?.subject?.repo && ctx.subject.strict !== false) {
      ctx.store?.appendLog?.(ctx.runId, {
        event: 'tool_target_unexpected', node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
        tool: 'read_file', path: args.path, read: 'workspace', expected: `reference:${ctx.subject.repo}`
      });
    }
    const whole = readText(host, args.path);
    if (whole == null) throw new Error(`File "${args.path}" not found in the workspace.`);
    const bytes = Buffer.byteLength(whole, 'utf8');
    const content = offset ? whole.slice(Math.min(offset, whole.length)) : whole;
    if (content.length > MAX_CHARS) {
      const end = offset + MAX_CHARS;
      return {
        path: args.path, content: content.slice(0, MAX_CHARS), truncated: true, bytes, target: host.target,
        // Where it stopped, so reading on is a call rather than a guess.
        ...(offset ? { offset } : {}), nextOffset: end, chars: whole.length
      };
    }
    return { path: args.path, content, bytes, target: host.target, ...(offset ? { offset } : {}) };
  }
};
