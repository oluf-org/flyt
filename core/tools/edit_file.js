// edit_file: change part of a file by replacing an exact string, instead of
// reproducing the whole file (TOOLS-PLAN §14.1).
//
// This is the single biggest gap in the pre-P4 catalog. A node changing one
// line of a 2,000-line file had to emit all 2,000 through write_file — slow,
// expensive, and the dominant way a coding agent silently destroys unrelated
// code, because anything it forgets to reproduce is simply gone.
//
// The contract is deliberately strict: `oldString` must match EXACTLY ONCE
// unless `replaceAll` is set. Zero matches and several matches are both errors
// the model can correct from (add surrounding lines to disambiguate), and both
// are far better than a guess. Returns a unified diff so the change is
// reviewable in the tool record without re-reading the file.
import { fileHost, readText, writeText, noteWorkspaceWrite } from './fileHost.js';

const MAX_DIFF_LINES = 400;

export default {
  name: 'edit_file',
  title: 'Edit part of a file',
  description: 'Replace an exact snippet inside an existing file, leaving the rest untouched. `oldString` must appear EXACTLY ONCE (include surrounding lines to make it unique) unless replaceAll is true. Prefer this over write_file for any change to an existing file. Returns a unified diff of what changed.',
  effects: ['write'],
  risk: 'caution',
  keywords: ['edit', 'replace', 'change', 'patch', 'modify', 'fix', 'diff'],
  examples: ['change the timeout in src/config.js', 'rename the helper in one file'],
  parameters: {
    type: 'object',
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Relative path inside the workspace, e.g. "src/app.js".' },
      oldString: { type: 'string', description: 'The exact text to replace, copied from the file including indentation.' },
      newString: { type: 'string', description: 'The replacement text. Use an empty string to delete the snippet.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one. Default false.' }
    }
  },
  run(args, ctx) {
    const host = fileHost(ctx);
    const before = readText(host, args.path);
    if (before == null) throw new Error(`File "${args.path}" not found in the workspace. Use create_file to make a new one.`);

    const { oldString, newString } = args;
    if (oldString === newString) throw new Error('oldString and newString are identical — nothing to change.');
    if (!oldString) throw new Error('oldString is empty. Use create_file or write_file to write a whole file.');

    const count = occurrences(before, oldString);
    if (count === 0) {
      throw new Error(`oldString was not found in "${args.path}". It must match the file exactly, including indentation and line endings.`);
    }
    if (count > 1 && !args.replaceAll) {
      throw new Error(`oldString appears ${count} times in "${args.path}". Include more surrounding context to make it unique, or set replaceAll: true.`);
    }

    const after = args.replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
    const conflict = noteWorkspaceWrite(ctx, args.path);
    const written = writeText(host, args.path, after);
    return {
      written,
      replacements: args.replaceAll ? count : 1,
      bytes: Buffer.byteLength(after, 'utf8'),
      target: host.target,
      diff: unifiedDiff(args.path, before, after),
      ...(conflict ? { conflictWith: conflict } : {})
    };
  }
};

function occurrences(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

// A unified diff over the changed region only. Hand-rolled (D24) and
// deliberately simple: common prefix, common suffix, everything between is the
// hunk. That is exactly right for a single replacement and honest for several
// — it reports one wide hunk rather than pretending to be a real diff engine.
export function unifiedDiff(path, before, after, context = 3) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1; }

  const from = Math.max(0, start - context);
  const toA = Math.min(a.length - 1, endA + context);
  const toB = Math.min(b.length - 1, endB + context);
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@`
  ];
  for (let i = from; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+${b[i]}`);
  for (let i = endA + 1; i <= toA; i++) lines.push(` ${a[i]}`);
  if (lines.length > MAX_DIFF_LINES) {
    return lines.slice(0, MAX_DIFF_LINES).join('\n') + `\n… [diff truncated at ${MAX_DIFF_LINES} lines]`;
  }
  return lines.join('\n');
}
