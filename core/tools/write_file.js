// write_file: create or OVERWRITE a text file. Acts on the run's bound
// workspace (the real target project) when one is set, else the run's own
// workspace sandbox. Path confinement is enforced by the file backend.
import { fileHost, readShaped, writeText, noteWorkspaceWrite } from './fileHost.js';
import { toEol } from './textFile.js';

export default {
  name: 'write_file',
  title: 'Write a file',
  description: 'Create or OVERWRITE a text file in the workspace (the bound target project). Use write_file when the file may already exist; use create_file when it must be new. Forward-slash relative paths like "src/app.js"; the path is confined to the workspace root.',
  effects: ['write'],
  risk: 'caution',
  keywords: ['write', 'file', 'save', 'overwrite', 'edit'],
  examples: ['save the report to report.md', 'overwrite src/app.js with the new version'],
  parameters: {
    type: 'object',
    required: ['path', 'content'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Relative path inside the workspace, e.g. "report.md" or "src/app.js".' },
      content: { type: 'string', description: 'Full text content of the file.' },
      sandbox_permissions: { enum: ['workspace-write', 'danger-full-access'], description: 'Optional strictly wider sandbox mode for this call.' },
      justification: { type: 'string', description: 'Why this exact call needs the wider sandbox mode.' }
    }
  },
  async run(args, ctx) {
    const host = fileHost(ctx);
    const conflict = noteWorkspaceWrite(ctx, args.path);
    // Replacing a file does not change its encoding, its byte-order mark or its
    // line endings. A model answers in plain newlines whatever the file used, so
    // without this a one-line correction to a CRLF file rewrites every line in
    // it — and a file with a BOM quietly loses it.
    const existing = await readShaped(host, args.path);
    const shape = existing && !existing.shape.binary ? existing.shape : null;
    const content = shape ? toEol(args.content, shape.eol) : args.content;
    const written = await writeText(host, args.path, content, shape);
    return {
      written, bytes: Buffer.byteLength(content, 'utf8'), target: host.target,
      ...(conflict ? { conflictWith: conflict } : {})
    };
  }
};
