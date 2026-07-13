// write_file: the agent's basic deliverable channel. Writes are confined to
// runs/<runId>/workspace/ — path traversal is rejected by the store.
export default {
  name: 'write_file',
  description: 'Write a text file into this run\'s workspace. Overwrites if the file exists. Use forward-slash relative paths like "notes/outline.md".',
  parameters: {
    type: 'object',
    required: ['path', 'content'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Relative path inside the run workspace, e.g. "report.md" or "src/app.js".' },
      content: { type: 'string', description: 'Full text content of the file.' }
    }
  },
  run(args, ctx) {
    const written = ctx.store.writeWorkspaceFile(ctx.runId, args.path, args.content);
    return { written, bytes: Buffer.byteLength(args.content, 'utf8') };
  }
};
