// edit_file: anchored replacement — change a named piece of a file, not the
// whole file.
//
// The tool this replaces in practice is `write_file` on a large source file,
// and that is how a model destroys work it cannot see: it holds 400 lines of a
// 2600-line component in context, writes the file, and the other 2200 lines are
// gone with a green result. An anchored edit cannot do that. What it CAN do is
// hit the wrong place, so the two failure modes are closed deliberately:
//
//   - a non-unique anchor is an ERROR naming the count and every match's line
//     number. Never "the first one" — a guess that is right most of the time is
//     a guess that silently corrupts the rest of the time.
//   - a zero-match anchor is an error carrying the CLOSEST line in the file, so
//     the next turn can correct itself instead of re-rolling the same string.
//
// And it reports `before`/`after` with context, because an agent that cannot
// see what it did has to re-read the file to find out — a call it usually skips.
import { fileHost, readShaped, writeText } from './fileHost.js';
import { toEol } from './textFile.js';

const CONTEXT_LINES = 3;
// A non-unique anchor with two hundred matches is a bad anchor, not a report to
// read. Name enough of them to see the pattern and say how many were left.
const MAX_REPORTED_MATCHES = 10;

export default {
  name: 'edit_file',
  title: 'Edit part of a file',
  description: [
    'Replace an exact piece of text in an existing file, leaving the rest untouched.',
    'PREFER THIS over write_file for any file you have not written yourself in this run:',
    'write_file replaces the WHOLE file, so anything you did not include is deleted.',
    '`old` must appear EXACTLY ONCE — include surrounding lines to make it unique.',
    'If it appears several times the call fails and names each line, so widen the anchor',
    'or pass replaceAll when you really do mean every occurrence.',
    'The result shows the changed region with a few lines of context on each side.'
  ].join(' '),
  effects: ['write'],
  scope: 'workspace',
  // Anchored, reversible, and confined to one named file: real, but a rung
  // below write_file's whole-file overwrite.
  risk: 'caution',
  keywords: ['edit', 'replace', 'patch', 'change', 'modify', 'fix', 'file'],
  examples: [
    'change the timeout constant in core/gates.js from 10 to 20 minutes',
    'rename the handler in src/App.jsx without rewriting the file'
  ],
  parameters: {
    type: 'object',
    required: ['path', 'old', 'new'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Relative path inside the workspace, e.g. "src/app.js".' },
      old: {
        type: 'string',
        description: 'The exact text to find, whitespace included. Must match exactly once unless replaceAll is true.'
      },
      new: { type: 'string', description: 'What to put there instead. Pass an empty string to delete the text.' },
      replaceAll: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring exactly one. Default false.'
      },
      sandbox_permissions: { enum: ['workspace-write', 'danger-full-access'], description: 'Optional strictly wider sandbox mode for this call.' },
      justification: { type: 'string', description: 'Why this exact call needs the wider sandbox mode.' }
    }
  },
  async run(args, ctx) {
    const host = fileHost(ctx);
    const relPath = String(args.path ?? '');
    const read = await readShaped(host, relPath);
    if (read == null) throw new Error(`File "${relPath}" not found in the workspace. Use create_file to make a new one.`);
    // Not text, so there is nothing to anchor into and nothing that could be
    // written back. Reading a binary file as UTF-8 and writing the result is
    // not a bad edit, it is the file destroyed: every byte no encoding claims
    // comes back as a replacement character and never goes back.
    if (read.shape.binary) {
      throw new Error(`"${relPath}" is not a text file, so it cannot be edited as one. `
        + 'Editing it would rewrite every byte that is not valid text.');
    }
    const before = read.text;

    const needle = String(args.old ?? '');
    if (!needle) throw new Error('`old` is empty — there is nothing to find. Use write_file or create_file to write a whole file.');
    const replacement = String(args.new ?? '');

    // Match on a view with line endings normalised, never on the raw bytes.
    //
    // Over half the source files in a Windows checkout are CRLF, and a model
    // writes `old` with plain newlines. Matched literally, every multi-line
    // anchor into such a file misses — and the miss is invisible, because the
    // "closest line" hint then degenerates to line 1 and the message blames the
    // model for retyping instead of copying. Two Phase 3 tasks died on exactly
    // this, both on kernel/src/stack/types.ts, both reporting `"/**\r"` as the
    // nearest line. What a worker does next is not read more carefully: it
    // writes a Python or Node script that does its own normalisation and edits
    // the file that way, and then commits the script. Seven such scripts
    // reached two task branches before anyone looked.
    //
    // So: search the normalised view, splice the ORIGINAL string at indices
    // mapped back through it, and write `new` in whatever ending the file
    // already uses. Untouched lines keep their bytes either way.
    // What the FILE uses, from the one place that decides what a file is.
    const eol = read.shape.eol;
    const { norm, breaks } = normalized(before);
    const needleN = lf(needle);
    // Written in whatever the file uses — including a lone carriage return,
    // which the previous form silently turned into a newline.
    const replacementOut = toEol(replacement, eol);

    const hits = findAll(norm, needleN);
    if (!hits.length) throw new Error(noMatchMessage(norm, needleN, relPath));
    if (hits.length > 1 && args.replaceAll !== true) {
      throw new Error(ambiguousMessage(norm, hits, relPath));
    }

    // Back to offsets in the original, so the splice is over real bytes.
    const spans = hits.map(at => [origin(breaks, at), origin(breaks, at + needleN.length)]);
    const cut = args.replaceAll === true ? spans : [spans[0]];
    let after = '';
    let cursor = 0;
    for (const [from, to] of cut) {
      after += before.slice(cursor, from) + replacementOut;
      cursor = to;
    }
    after += before.slice(cursor);
    // Where the first edit landed and how long it is, in the original's terms.
    const matchedLength = spans[0][1] - spans[0][0];
    hits[0] = spans[0][0];
    const wroteLength = replacementOut.length;

    if (after === before) {
      // Not an error worth failing on — but saying "1 replacement" over an
      // unchanged file is the kind of green result that teaches a model the
      // edit worked when nothing happened.
      return {
        path: relPath, replacements: 0, unchanged: true, target: host.target,
        note: '`new` is identical to `old`, so the file is unchanged.'
      };
    }

    // Write through the same host resolution every other file tool uses, so
    // path confinement is enforced in exactly one place. Bytes, not text: the
    // file's own line endings and any trailing-newline convention survive,
    // because we only ever spliced a substring.
    await writeText(host, relPath, after, read.shape);
    noteWrite(ctx, relPath);

    const firstLine = lineOf(before, hits[0]);
    return {
      path: relPath,
      replacements: args.replaceAll === true ? hits.length : 1,
      line: firstLine,
      target: host.target,
      // What it looked like and what it looks like now, ±3 lines. The agent
      // needs to SEE the edit; re-reading the file to check is a call it skips.
      before: excerpt(before, hits[0], matchedLength),
      after: excerpt(after, hits[0], wroteLength)
    };
  }
};

// Record the write against the run's concurrent-write ledger, the same way
// write_file does. Imported lazily-by-hand rather than at module scope only to
// keep this file's imports honest about what it uses.
function noteWrite(ctx, relPath) {
  const conflict = ctx?.ledger?.noteWrite?.(ctx.taskId, relPath) ?? null;
  if (conflict) {
    ctx.store?.appendLog?.(ctx.runId, {
      event: 'workspace_write_conflict',
      node: ctx.taskId ? `executor:${ctx.taskId}` : undefined,
      path: relPath,
      alsoWrittenBy: `executor:${conflict}`
    });
  }
  return conflict;
}

/** `text` with every CRLF collapsed to a bare newline. */
/**
 * `text` with every line ending flattened to a bare newline.
 *
 * A lone carriage return is folded too. It is a 1:1 substitution, so it costs
 * the mapping nothing — only the CRLF pairs remove a character, and only those
 * are recorded. Leaving it out would have left a file that uses old-style Mac
 * endings with precisely the bug CRLF files had, for precisely as long as it
 * took somebody to open one.
 */
const lf = text => String(text).split('\r\n').join('\n').split('\r').join('\n');

/**
 * A newline-normalised view of `text`, and what is needed to map back into it.
 *
 * The only transformation is dropping the `` of a CRLF pair, so the mapping
 * is arithmetic rather than a table: an index in `norm` sits that many
 * characters later in the original as there were pairs collapsed before it.
 * `breaks` records where each collapsed newline landed IN `norm` — one entry
 * per line rather than one per character, which matters because this runs on
 * every edit: the per-character version cost 122ms and a 2.5-million-entry
 * array on a 2.6MB file, to answer at most a handful of questions.
 *
 * An all-LF file produces no breaks at all and the mapping is the identity,
 * which is the common case in a repository that has not been near Windows.
 */
export function normalized(text) {
  const s = String(text);
  const norm = lf(s);
  const breaks = [];
  if (norm.length !== s.length) {
    for (let i = s.indexOf('\r\n'); i !== -1; i = s.indexOf('\r\n', i + 2)) {
      breaks.push(i - breaks.length);
    }
  }
  return { norm, breaks };
}

/**
 * Where index `i` of the normalised view sits in the original.
 *
 * A collapsed newline maps to the carriage return, the START of the pair it
 * stands for. Mapping it to the newline loses the carriage return whenever a
 * match ends on the line before it: the exclusive end lands between the two,
 * and the splice swallows a line ending it never touched. That cost a test.
 */
export function origin(breaks, i) {
  let lo = 0;
  let hi = breaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (breaks[mid] < i) lo = mid + 1; else hi = mid;
  }
  return i + lo;
}

// Every start index of `needle` in `haystack`. Non-overlapping, left to right.
// indexOf in a loop rather than a regex: the anchor is arbitrary model-authored
// text and escaping it for a regex is one more thing to get wrong.
export function findAll(haystack, needle) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

// 1-based line number of a character offset.
function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

// The changed region with CONTEXT_LINES on either side, as text.
function excerpt(text, offset, length) {
  const lines = text.split('\n');
  const startLine = lineOf(text, offset);
  const endLine = lineOf(text, offset + Math.max(0, length - 1));
  const from = Math.max(0, startLine - 1 - CONTEXT_LINES);
  const to = Math.min(lines.length, endLine + CONTEXT_LINES);
  return lines.slice(from, to).join('\n');
}

function ambiguousMessage(text, hits, relPath) {
  const shown = hits.slice(0, MAX_REPORTED_MATCHES).map(at => lineOf(text, at));
  const rest = hits.length > shown.length ? `, and ${hits.length - shown.length} more` : '';
  return [
    `\`old\` matches ${hits.length} times in "${relPath}" (lines ${shown.join(', ')}${rest}), so which one you meant is a guess.`,
    'Include more surrounding text so the anchor is unique, or pass replaceAll: true if you mean every occurrence.'
  ].join(' ');
}

/**
 * "Not found" plus the closest thing that IS there.
 *
 * A bare no-match sends the next turn back with a slightly different guess. The
 * nearest line — by trigram overlap against the anchor's first line — is almost
 * always the line the model meant, differing by the whitespace or the one word
 * it got wrong, and seeing it ends the loop in one turn.
 */
function noMatchMessage(text, needle, relPath) {
  const wanted = String(needle).split('\n')[0].trim();
  const best = closestLine(text, wanted);
  const head = `\`old\` was not found in "${relPath}".`;
  if (!best) return `${head} Read the file first — its contents are not what you assumed.`;
  return [
    head,
    `The closest line is ${best.line}: ${JSON.stringify(best.text.slice(0, 200))}.`,
    'Whitespace and indentation are part of the match — copy the text from a read_file result rather than retyping it.'
  ].join(' ');
}

// Nearest line by trigram overlap. Deliberately crude and dependency-free
// (D24): this is a hint in an error message, not a search feature.
export function closestLine(text, wanted) {
  const want = trigrams(wanted);
  if (!want.size) return null;
  const lines = String(text).split('\n');
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const have = trigrams(lines[i].trim());
    if (!have.size) continue;
    let shared = 0;
    for (const g of have) if (want.has(g)) shared++;
    const score = shared / (want.size + have.size - shared); // Jaccard
    if (score > 0 && (!best || score > best.score)) best = { line: i + 1, text: lines[i], score };
  }
  return best && best.score >= 0.2 ? best : null;
}

function trigrams(s) {
  const out = new Set();
  const t = String(s).toLowerCase();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}
