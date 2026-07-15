// create_file: create a NEW text file in the workspace. Fails if the file
// already exists (use write_file to overwrite) so an agent can't silently
// clobber existing repo files. Acts on the bound target project when set.
import { fileHost, writeText, fileExists } from './fileHost.js';

export default {
  name: 'create_file',
  description: 'Create a NEW text file in the workspace (the bound target project). Fails if the file already exists — use write_file to overwrite. Forward-slash relative paths like "src/new.js"; the path is confined to the workspace root.',
  parameters: {
    type: 'object',
    required: ['path', 'content'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Relative path inside the workspace for the new file, e.g. "src/new.js".' },
      content: { type: 'string', description: 'Full text content of the new file.' }
    }
  },
  run(args, ctx) {
    const host = fileHost(ctx);
    if (fileExists(host, args.path)) {
      throw new Error(`File "${args.path}" already exists; use write_file to overwrite it.`);
    }
    const created = writeText(host, args.path, args.content);
    return { created, bytes: Buffer.byteLength(args.content, 'utf8'), target: host.target };
  }
};
