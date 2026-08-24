// read_file: read a text file from the workspace (the bound target project, or
// the run sandbox when unbound). Confined to the workspace root. Large files
// are truncated so a single read can't blow the model's context window.
import { fileHost, readShaped } from './fileHost.js';

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
  // A file read is the one result where the model needs the WHOLE thing, and
  // this tool declared no budget — so it took the 2,000-char default, which
  // after the per-string share is about a thousand characters of file. Every
  // real source file came back as a stub plus a handle, and an agent that
  // cannot read a file with read_file reads it with `bash sed -n '40,194p'`
  // instead: a dozen calls, each resending the whole growing conversation, to
  // see one 194-line test. 24,000 leaves roughly 300 lines of code intact,
  // which covers most files whole; the tool's own 200,000-char cap and the
  // `nextOffset` marker still bound and continue the rest.
  //
  // The preview bound is also the injection bound (core/tools/preview.js), and
  // that is why this is raised rather than removed — but what it bounds here is
  // a file out of the user's own checkout, not a page off the internet.
  result: { preview: 'json', maxPreviewChars: 24_000, artifact: true },
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
    // The reference library (DESIGN-SPEC.md §8): a second, read-only root beside
    // the workspace. It is a separate path rather than a mounted directory
    // precisely so no write tool can reach it — none of them know the prefix,
    // and there is no write path in ReferenceLibrary to reach if they did.
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    if (String(args.path ?? '').startsWith('reference:')) {
      if (!ctx?.references) throw new Error('No reference library is available in this run.');
      const content = ctx.references.read(args.path, { offset });
      if (content == null) throw new Error(`Reference "${args.path}" not found. Use search_references to find a path.`);
      // Which reference this actually is. The workspace read below has been
      // audited against the run's subject since DECISIONS.md D38; reading a
      // DIFFERENT reference was not, and the library holds other people's
      // repositories. Watched a lane read one for its entire life and report
      // confident findings about it under a brief naming another.
      const repo = /^reference:([^/]+)/.exec(String(args.path))?.[1] ?? null;
      const elsewhere = ctx.subject?.repo && repo && repo !== ctx.subject.repo;
      if (elsewhere) {
        ctx.store?.appendLog?.(ctx.runId, {
          event: 'tool_target_unexpected',
          node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
          tool: 'read_file', path: args.path, read: repo, expected: `reference:${ctx.subject.repo}`
        });
      }
      return {
        path: args.path,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        target: 'reference',
        readOnly: true,
        ...(offset ? { offset } : {}),
        ...(elsewhere ? { note: `This file is in "${repo}", NOT the repository you were asked to read ("${ctx.subject.repo}").` } : {})
      };
    }
    const host = fileHost(ctx);
    // A node pointed at a subject repository just read a path out of THIS
    // project instead (DECISIONS.md D38). Not blocked — comparing the subject
    // against home is legitimate, and a lane may do it on purpose — but it is
    // one plausible tool call away from a confident finding about the wrong
    // repository, so it must not be invisible in the run log.
    if (ctx?.subject?.repo && ctx.subject.strict !== false) {
      ctx.store?.appendLog?.(ctx.runId, {
        event: 'tool_target_unexpected', node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
        tool: 'read_file', path: args.path, read: 'workspace', expected: `reference:${ctx.subject.repo}`
      });
    }
    const read = readShaped(host, args.path);
    if (read == null) throw new Error(`File "${args.path}" not found in the workspace.`);
    // A binary file is present and unreadable, which is not the same as absent.
    // Saying "not found" would send the caller looking for a path that is right
    // there, and handing back the UTF-8 decoding would hand back mojibake that
    // destroys the file the moment anybody writes it back.
    if (read.shape.binary) {
      return {
        path: args.path, binary: true, bytes: read.bytes, target: host.target,
        note: `"${args.path}" is not a text file, so there is nothing to read as text. `
          + 'Its bytes are intact; inspect it with a tool that understands its format.',
      };
    }
    const whole = read.text;
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
