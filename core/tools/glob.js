// glob: find files by path pattern (TOOLS-PLAN §14.2).
//
// Why this exists when `bash` could run `find`: bash is a `shell`-effect tool
// and gated; LOOKING for files changes nothing and should never be. Making
// search a first-class read tool means a node that only needs to find things
// never needs a ceiling that includes the shell.
//
// Hand-rolled matcher (D24) over the standard subset: `*`, `**`, `?`, and
// `{a,b}` alternation. Walks the workspace, skips the directories nobody means
// (node_modules, .git, dist) plus whatever .gitignore says, and caps results.
import fs from 'node:fs';
import path from 'node:path';
import { fileHost } from './fileHost.js';
import { loadIgnore } from './ignore.js';

const MAX_RESULTS = 500;
const MAX_ENTRIES = 50_000; // walk bound, so a huge tree can't hang a run

export default {
  name: 'glob',
  title: 'Find files by name',
  description: 'Find files in the workspace by path pattern — "src/**/*.js", "**/*.test.ts", "{README,LICENSE}*". Returns paths, newest first, capped. Respects .gitignore and skips node_modules/.git/dist. Use grep to search file CONTENTS.',
  effects: ['read'],
  risk: 'safe',
  autoExecute: true,
  keywords: ['find', 'files', 'glob', 'pattern', 'list', 'search', 'ls'],
  examples: ['find every test file', 'what components exist under src/'],
  parameters: {
    type: 'object',
    required: ['pattern'],
    additionalProperties: false,
    properties: {
      pattern: { type: 'string', description: 'Glob pattern relative to the workspace root, e.g. "src/**/*.js".' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: `Maximum paths to return (default 100, max ${MAX_RESULTS}).` }
    }
  },
  run(args, ctx) {
    const host = fileHost(ctx);
    const root = host.resolve('.');
    const limit = Math.min(args.limit ?? 100, MAX_RESULTS);
    const re = globToRegExp(args.pattern);
    const ignore = loadIgnore(root);
    const hits = [];
    walk(root, root, ignore, (rel, abs) => {
      if (!re.test(rel)) return;
      let mtime = 0;
      try { mtime = fs.statSync(abs).mtimeMs; } catch { /* raced deletion */ }
      hits.push({ path: rel, mtime });
    });
    hits.sort((a, b) => b.mtime - a.mtime);
    const paths = hits.slice(0, limit).map(h => h.path);
    return {
      pattern: args.pattern,
      paths,
      count: paths.length,
      ...(hits.length > paths.length ? { truncated: true, total: hits.length } : {}),
      target: host.target
    };
  }
};

// Depth-first walk with the ignore rules applied to directories as well as
// files, so a pruned directory costs one check rather than a subtree.
export function walk(root, dir, ignore, onFile, state = { seen: 0 }) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (state.seen >= MAX_ENTRIES) return;
    state.seen += 1;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (ignore(rel, entry.isDirectory())) continue;
    if (entry.isDirectory()) walk(root, abs, ignore, onFile, state);
    else if (entry.isFile()) onFile(rel, abs);
  }
}

// `*` any run without a separator · `**` any run including separators
// `?` one character · `{a,b}` alternation · everything else literal.
export function globToRegExp(pattern) {
  let out = '';
  const src = String(pattern ?? '').trim();
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '*') {
      if (src[i + 1] === '*') {
        // `**/` may match zero directories, so "**/*.js" also finds "a.js".
        if (src[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') out += '(?:';
    else if (c === '}') out += ')';
    else if (c === ',') out += '|';
    else out += c.replace(/[.+^$()\[\]\\|]/g, m => '\\' + m);
  }
  return new RegExp(`^${out}$`);
}
