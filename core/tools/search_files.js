// search_files: find text inside THIS project.
//
// The gap this closes, watched live rather than reasoned about. A Loop task
// asked to extend one function across three large files spent forty rounds and
// fifty-eight tool calls reading, wrote nothing, and reported its own cause:
// "the files involved are large and needed full, non-truncated reads before a
// safe edit could be made ... rather than repeated offset-based reads of the
// same large files". It then named the tool it wanted — "grep for the exact
// function name backing 'run:explain'" — and that tool did not exist.
//
// The catalog had the two halves of the answer and not the middle: `glob` finds
// FILES by name, `search_references` searches OTHER people's repositories, and
// nothing at all searched the project the agent was standing in and about to
// edit. So the only way to locate a symbol in a 3000-line file was to read it
// in windows until the budget ran out, which is what happened.
//
// Read-effect and workspace-confined, so an aiStep may hold it as glob does.
import fs from 'node:fs';
import path from 'node:path';
import { fileHost } from './fileHost.js';
import { globToRegExp } from './glob.js';
import { readFileShaped, toEol } from './textFile.js';

const DEFAULT_MAX_RESULTS = 40;
const MAX_RESULTS = 200;
const DEFAULT_MAX_PER_FILE = 5;
// Same skip list as glob, and for the same reason: a match in node_modules is
// never the answer to "where is our code that does X", and one vendored copy of
// a common word floods every result.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target', 'vendor']);
const MAX_FILES_SCANNED = 4000;
// A file that is one long line, or a binary that slipped past the extension
// check, is not something a line-oriented search should try to render.
const MAX_FILE_BYTES = 2_000_000;
const MAX_LINE_CHARS = 400;

export default {
  name: 'search_files',
  title: 'Search the project',
  description: [
    'Search the text of files in the workspace (the bound project) for a regular expression, and',
    'get back file paths with line numbers and the matching lines. This is how you LOCATE code:',
    'search first for the symbol, string or call you need, then read_file that path around the',
    'line it names. Reading a large file in windows to find one function wastes the budget you',
    'need for the edit. This searches THIS project only — use search_references for the',
    'read-only reference library, and glob when you want file names rather than contents.'
  ].join(' '),
  effects: ['read'],
  // A search whose results are cut to the 2,000-char default returns a handful
  // of hits with their context shortened to nothing, which reads as "there is
  // almost nothing here" rather than as "you were shown almost nothing".
  result: { preview: 'json', maxPreviewChars: 12_000, artifact: true },
  scope: 'workspace',
  risk: 'safe',
  autoExecute: true,
  keywords: ['search', 'grep', 'find', 'text', 'symbol', 'where is', 'usages', 'references', 'ripgrep'],
  examples: [
    'find every place that handles the awaiting_input stage',
    'where is the function that backs the run:explain command',
    'which files still call the old helper name'
  ],
  parameters: {
    type: 'object',
    required: ['pattern'],
    additionalProperties: false,
    properties: {
      pattern: {
        type: 'string',
        description: 'A JavaScript regular expression, e.g. "run:explain|renderWhy" — case-insensitive unless caseSensitive is set.'
      },
      glob: {
        type: 'string',
        description: 'Limit to files matching this glob, e.g. "src/**/*.jsx" or "**/*.test.js". Defaults to every text file.'
      },
      dir: {
        type: 'string',
        description: 'Optional subdirectory to search under, e.g. "core". Defaults to the workspace root.'
      },
      context: {
        type: 'integer', minimum: 0, maximum: 20,
        description: 'Lines of surrounding context per hit (default 0).'
      },
      caseSensitive: { type: 'boolean', description: 'Match case exactly (default false).' },
      maxResults: {
        type: 'integer', minimum: 1, maximum: MAX_RESULTS,
        description: `Cap on hits (default ${DEFAULT_MAX_RESULTS}).`
      },
      maxPerFile: {
        type: 'integer', minimum: 1, maximum: 50,
        description: `Cap on hits from any one file (default ${DEFAULT_MAX_PER_FILE}), so one noisy file cannot hide the one that answers the question.`
      }
    }
  },
  async run(args, ctx) {
    const host = fileHost(ctx);
    if (host.seam) return searchSeam(host, args, ctx);
    const base = host.resolve(args.dir ? String(args.dir) : '.');
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      throw new Error(`Directory "${args.dir ?? '.'}" does not exist in the workspace.`);
    }

    let re;
    try {
      re = new RegExp(String(args.pattern ?? ''), args.caseSensitive === true ? '' : 'i');
    } catch (err) {
      // The pattern is the model's own input, so the error has to say what to
      // fix rather than surfacing as a tool crash.
      throw new Error(`"${args.pattern}" is not a valid regular expression: ${err.message}`);
    }

    const nameFilter = args.glob ? globToRegExp(String(args.glob)) : null;
    const maxResults = Math.min(MAX_RESULTS, Math.max(1, Number(args.maxResults ?? DEFAULT_MAX_RESULTS)));
    const maxPerFile = Math.max(1, Number(args.maxPerFile ?? DEFAULT_MAX_PER_FILE));
    const contextLines = Math.max(0, Math.min(20, Number(args.context ?? 0)));
    const prefix = args.dir ? String(args.dir).replace(/\\/g, '/').replace(/^\.?\/*|\/*$/g, '') : '';

    const results = [];
    let filesScanned = 0;
    let filesMatched = 0;
    let truncated = false;

    const walk = dir => {
      if (truncated) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (truncated) return;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = path.relative(base, abs).split(path.sep).join('/');
        if (nameFilter && !nameFilter.test(rel)) continue;
        if (++filesScanned > MAX_FILES_SCANNED) { truncated = true; return; }

        let text;
        try {
          if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
          // Through the interpreter, so a search answers the same question every
          // other file tool does. Read blindly as UTF-8, a CRLF file gave every
          // line a trailing carriage return, so `foo$` matched nothing — in
          // silence, and the reader concluded the code was not there. A UTF-16
          // file was searched as mojibake and matched nothing for the same
          // reason, less visibly. Binary files are skipped here as they always
          // were, now by what they are rather than by a NUL in the decoding.
          const read = readFileShaped(abs);
          if (!read || read.shape.binary) continue;
          text = read.text;
        } catch { continue; }

        const lines = toEol(text, '\n').split('\n');
        let hitsHere = 0;
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          if (++hitsHere > maxPerFile) break;
          results.push({
            path: prefix ? `${prefix}/${rel}` : rel,
            line: i + 1,
            text: clip(lines[i]),
            ...(contextLines ? {
              before: lines.slice(Math.max(0, i - contextLines), i).map(clip),
              after: lines.slice(i + 1, i + 1 + contextLines).map(clip)
            } : {})
          });
          if (results.length >= maxResults) { truncated = true; break; }
        }
        if (hitsHere) filesMatched += 1;
        if (truncated) return;
      }
    };
    walk(base);

    ctx.store?.appendLog?.(ctx.runId, {
      event: 'workspace_search',
      node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
      pattern: String(args.pattern ?? ''),
      ...(args.glob ? { glob: String(args.glob) } : {}),
      hits: results.length, files: filesMatched
    });

    return {
      pattern: args.pattern,
      ...(args.glob ? { glob: args.glob } : {}),
      ...(args.dir ? { dir: args.dir } : {}),
      // Which tree this searched, said plainly — a node may also be holding a
      // subject repository, and a finding attributed to the wrong one is worse
      // than no finding (DECISIONS.md D38).
      target: host.target,
      hits: results.length,
      files: filesMatched,
      ...(truncated ? { truncated: true } : {}),
      results,
      // Zero hits reads as "this project does not do that", which is usually
      // wrong and always expensive to act on. Say what was actually looked at.
      ...(results.length ? {} : {
        note: `No line matched in ${filesScanned} file(s) under "${args.dir ?? '.'}"`
          + `${args.glob ? ` matching "${args.glob}"` : ''}. Widen the pattern or drop the glob before concluding it is absent.`
      })
    };
  }
};

async function searchSeam(host, args, ctx) {
  let re;
  try { re = new RegExp(String(args.pattern ?? ''), args.caseSensitive === true ? '' : 'i'); }
  catch (error) { throw new Error(`"${args.pattern}" is not a valid regular expression: ${error.message}`); }
  const nameFilter = args.glob ? globToRegExp(String(args.glob)) : null;
  const maxResults = Math.min(MAX_RESULTS, Math.max(1, Number(args.maxResults ?? DEFAULT_MAX_RESULTS)));
  const maxPerFile = Math.max(1, Number(args.maxPerFile ?? DEFAULT_MAX_PER_FILE));
  const contextLines = Math.max(0, Math.min(20, Number(args.context ?? 0)));
  const prefix = args.dir ? String(args.dir).replace(/\\/g, '/').replace(/^\.?\/*|\/*$/g, '') : '';
  const entries = await host.seam.list(args.dir ? String(args.dir) : '.', host.execution?.signal);
  const results = [];
  let filesScanned = 0;
  const matched = new Set();
  let truncated = false;
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    if (entry.path.split('/').some(segment => SKIP_DIRS.has(segment))) continue;
    const rel = prefix && entry.path.startsWith(`${prefix}/`) ? entry.path.slice(prefix.length + 1) : entry.path;
    if (nameFilter && !nameFilter.test(rel)) continue;
    if (++filesScanned > MAX_FILES_SCANNED) { truncated = true; break; }
    if ((entry.size ?? 0) > MAX_FILE_BYTES) continue;
    let text;
    try { text = await host.seam.read(entry.path, host.execution?.signal); } catch { continue; }
    const lines = toEol(text, '\n').split('\n');
    let hitsHere = 0;
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      if (++hitsHere > maxPerFile) break;
      matched.add(entry.path);
      results.push({
        path: entry.path, line: i + 1, text: clip(lines[i]),
        ...(contextLines ? { before: lines.slice(Math.max(0, i - contextLines), i).map(clip), after: lines.slice(i + 1, i + 1 + contextLines).map(clip) } : {}),
      });
      if (results.length >= maxResults) { truncated = true; break; }
    }
    if (truncated) break;
  }
  ctx.store?.appendLog?.(ctx.runId, { event: 'workspace_search', node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
    pattern: String(args.pattern ?? ''), ...(args.glob ? { glob: String(args.glob) } : {}), hits: results.length, files: matched.size });
  return {
    pattern: args.pattern, ...(args.glob ? { glob: args.glob } : {}), ...(args.dir ? { dir: args.dir } : {}),
    target: host.target, hits: results.length, files: matched.size, ...(truncated ? { truncated: true } : {}), results,
    ...(results.length ? {} : { note: `No line matched in ${filesScanned} file(s) under "${args.dir ?? '.'}"${args.glob ? ` matching "${args.glob}"` : ''}. Widen the pattern or drop the glob before concluding it is absent.` }),
  };
}

const clip = line => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
