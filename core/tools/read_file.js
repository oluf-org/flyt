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
    'truncated). A path beginning "reference:" reads from the READ-ONLY reference library instead,',
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
      }
    }
  },
  run(args, ctx) {
    // The reference library (LOOP-PLAN §16.1): a second, read-only root beside
    // the workspace. It is a separate path rather than a mounted directory
    // precisely so no write tool can reach it — none of them know the prefix,
    // and there is no write path in ReferenceLibrary to reach if they did.
    if (String(args.path ?? '').startsWith('reference:')) {
      if (!ctx?.references) throw new Error('No reference library is available in this run.');
      const content = ctx.references.read(args.path);
      if (content == null) throw new Error(`Reference "${args.path}" not found. Use search_references to find a path.`);
      return {
        path: args.path,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        target: 'reference',
        readOnly: true
      };
    }
    const host = fileHost(ctx);
    const content = readText(host, args.path);
    if (content == null) throw new Error(`File "${args.path}" not found in the workspace.`);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (content.length > MAX_CHARS) {
      return { path: args.path, content: content.slice(0, MAX_CHARS), truncated: true, bytes, target: host.target };
    }
    return { path: args.path, content, bytes, target: host.target };
  }
};
