// write_file: create or OVERWRITE a text file. Acts on the run's bound
// workspace (the real target project) when one is set, else the run's own
// workspace sandbox. Path confinement is enforced by the file backend.
import { fileHost, writeText, noteWorkspaceWrite } from './fileHost.js';

export default {
  name: 'write_file',
  description: 'Create or OVERWRITE a text file in the workspace (the bound target project). Use write_file when the file may already exist; use create_file when it must be new. Forward-slash relative paths like "src/app.js"; the path is confined to the workspace root.',
  parameters: {
    type: 'object',
    required: ['path', 'content'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Relative path inside the workspace, e.g. "report.md" or "src/app.js".' },
      content: { type: 'string', description: 'Full text content of the file.' }
    }
  },
  run(args, ctx) {
    const host = fileHost(ctx);
    const conflict = noteWorkspaceWrite(ctx, args.path);
    const written = writeText(host, args.path, args.content);
    return {
      written, bytes: Buffer.byteLength(args.content, 'utf8'), target: host.target,
      ...(conflict ? { conflictWith: conflict } : {})
    };
  }
};
