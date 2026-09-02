// create_file: create a NEW text file in the workspace. Fails if the file
// already exists (use write_file to overwrite) so an agent can't silently
// clobber existing repo files. Acts on the bound target project when set.
import { fileHost, writeText, fileExists, noteWorkspaceWrite } from './fileHost.js';

export default {
  name: 'create_file',
  title: 'Create a file',
  description: 'Create a NEW text file in the workspace (the bound target project). Fails if the file already exists — use write_file to overwrite. Forward-slash relative paths like "src/new.js"; the path is confined to the workspace root.',
  effects: ['write'],
  risk: 'caution',
  keywords: ['create', 'new', 'file', 'add'],
  examples: ['create src/new-module.js', 'add a README to the project'],
  parameters: {
    type: 'object',
    required: ['path', 'content'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Relative path inside the workspace for the new file, e.g. "src/new.js".' },
      content: { type: 'string', description: 'Full text content of the new file.' },
      sandbox_permissions: { enum: ['workspace-write', 'danger-full-access'], description: 'Optional strictly wider sandbox mode for this call.' },
      justification: { type: 'string', description: 'Why this exact call needs the wider sandbox mode.' }
    }
  },
  async run(args, ctx) {
    const host = fileHost(ctx);
    if (await fileExists(host, args.path)) {
      throw new Error(`File "${args.path}" already exists; use write_file to overwrite it.`);
    }
    const conflict = noteWorkspaceWrite(ctx, args.path);
    const created = await writeText(host, args.path, args.content);
    return {
      created, bytes: Buffer.byteLength(args.content, 'utf8'), target: host.target,
      ...(conflict ? { conflictWith: conflict } : {})
    };
  }
};
