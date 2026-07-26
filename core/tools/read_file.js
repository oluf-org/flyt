// read_file: read a text file from the workspace (the bound target project, or
// the run sandbox when unbound). Confined to the workspace root. Large files
// are truncated so a single read can't blow the model's context window.
import { fileHost, readText } from './fileHost.js';

const MAX_CHARS = 200_000;

export default {
  name: 'read_file',
  title: 'Read a file',
  description: 'Read a text file from the workspace (the bound target project). Forward-slash relative path like "src/app.js"; confined to the workspace root. Returns the file contents (large files are truncated).',
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
      path: { type: 'string', description: 'Relative path inside the workspace, e.g. "src/app.js".' }
    }
  },
  run(args, ctx) {
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
