// grep: search file CONTENTS across the workspace (TOOLS-PLAN §14.2).
//
// Ripgrep-shaped without ripgrep (D24): a regex over the files a glob-ish
// filter selects, with per-file and total caps so a broad pattern returns a
// useful answer instead of a context-destroying one. Read-effect, so a node
// that only needs to find things never needs the shell.
import fs from 'node:fs';
import { fileHost } from './fileHost.js';
import { loadIgnore } from './ignore.js';
import { walk, globToRegExp } from './glob.js';

const MAX_MATCHES = 200;
const MAX_PER_FILE = 20;
const MAX_LINE_CHARS = 400;
const MAX_FILE_BYTES = 2_000_000;

export default {
  name: 'grep',
  title: 'Search file contents',
  description: 'Search the workspace for a regular expression and return matching lines with their file and line number. Narrow with `glob` (e.g. "src/**/*.ts"). Results are capped; refine the pattern rather than raising the cap. Use the glob tool to search file NAMES.',
  effects: ['read'],
  risk: 'safe',
  autoExecute: true,
  keywords: ['grep', 'search', 'find', 'contents', 'regex', 'where', 'usage'],
  examples: ['where is filterByTag defined', 'find every TODO in the source'],
  parameters: {
    type: 'object',
    required: ['pattern'],
    additionalProperties: false,
    properties: {
      pattern: { type: 'string', description: 'Regular expression (JavaScript syntax) to search for.' },
      glob: { type: 'string', description: 'Optional path pattern limiting which files are searched, e.g. "src/**/*.js".' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search. Default false.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_MATCHES, description: `Maximum matching lines to return (default 50, max ${MAX_MATCHES}).` }
    }
  },
  run(args, ctx) {
    const host = fileHost(ctx);
    const root = host.resolve('.');
    const limit = Math.min(args.limit ?? 50, MAX_MATCHES);
    let re;
    try { re = new RegExp(args.pattern, args.ignoreCase ? 'i' : ''); }
    catch (err) { throw new Error(`Invalid regular expression: ${err.message}`); }
    const fileFilter = args.glob ? globToRegExp(args.glob) : null;
    const ignore = loadIgnore(root);

    const matches = [];
    let filesSearched = 0;
    let truncated = false;
    walk(root, root, ignore, (rel, abs) => {
      if (truncated) return;
      if (fileFilter && !fileFilter.test(rel)) return;
      let text;
      try {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) return;
        text = fs.readFileSync(abs, 'utf8');
      } catch { return; }
      if (text.indexOf(String.fromCharCode(0)) !== -1) return; // a NUL byte means binary; skip it
      filesSearched += 1;
      let inFile = 0;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        if (matches.length >= limit) { truncated = true; return; }
        if (inFile >= MAX_PER_FILE) {
          matches.push({ path: rel, line: i + 1, text: `… more matches in this file (showing ${MAX_PER_FILE})` });
          return;
        }
        inFile += 1;
        const text_ = lines[i].length > MAX_LINE_CHARS ? lines[i].slice(0, MAX_LINE_CHARS) + '…' : lines[i];
        matches.push({ path: rel, line: i + 1, text: text_ });
      }
    });

    return {
      pattern: args.pattern,
      matches,
      count: matches.length,
      files: new Set(matches.map(m => m.path)).size,
      filesSearched,
      ...(truncated ? { truncated: true } : {}),
      target: host.target
    };
  }
};
