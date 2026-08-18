// glob: list files in the workspace by pattern (DECISIONS.md D38).
//
// The gap this closes: `read_file` can open a path you already know and
// `search_references` can only reach the read-only library, so a node asked to
// orient itself in THIS project had no way to see what is in it. A model that
// cannot list guesses paths, and a guessed path that happens to exist is
// indistinguishable from a read one.
//
// Read-effect and workspace-confined, so an aiStep may hold it (§6.4).
import fs from 'node:fs';
import path from 'node:path';
import { fileHost } from './fileHost.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
// Directories nobody is orienting themselves with, and which dominate the
// listing when present. `.flyt` is NOT here: its config and context file are
// exactly what a survey wants to find.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target', 'vendor']);
const MAX_ENTRIES_SCANNED = 20_000;

export default {
  name: 'glob',
  title: 'List files',
  description: [
    'List files in the workspace (the bound project) matching a glob pattern like "src/**/*.js",',
    '"*.md" or "**/package.json". Use it to see what is actually here before reading anything —',
    'paths come back workspace-relative and ready to hand to read_file. Build output, node_modules',
    'and .git are skipped. This lists THIS project, never the read-only reference library; use',
    'search_references for that.'
  ].join(' '),
  effects: ['read'],
  scope: 'workspace',
  risk: 'safe',
  autoExecute: true,
  keywords: ['list', 'files', 'glob', 'find', 'tree', 'directory', 'what is here'],
  examples: ['list every markdown file at the top level', 'what test files exist'],
  parameters: {
    type: 'object',
    required: ['pattern'],
    additionalProperties: false,
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob: "*" matches within one path segment, "**" matches across segments, "?" one character. E.g. "src/**/*.ts", "*.json", "**/README.md".'
      },
      dir: {
        type: 'string',
        description: 'Optional subdirectory to search under, e.g. "src". Defaults to the workspace root.'
      },
      limit: {
        type: 'integer', minimum: 1, maximum: MAX_LIMIT,
        description: `Cap on paths returned (default ${DEFAULT_LIMIT}).`
      },
      includeDirs: {
        type: 'boolean',
        description: 'Match directories as well as files (default false).'
      }
    }
  },
  run(args, ctx) {
    const host = fileHost(ctx);
    const base = host.resolve(args.dir ? String(args.dir) : '.');
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      throw new Error(`Directory "${args.dir ?? '.'}" does not exist in the workspace.`);
    }
    const prefix = args.dir ? String(args.dir).replace(/\\/g, '/').replace(/^\.?\/*|\/*$/g, '') : '';
    const re = globToRegExp(String(args.pattern ?? ''));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit ?? DEFAULT_LIMIT)));
    const includeDirs = args.includeDirs === true;

    const matches = [];
    let scanned = 0;
    let truncated = false;
    const walk = dir => {
      if (truncated) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (++scanned > MAX_ENTRIES_SCANNED) { truncated = true; return; }
        const abs = path.join(dir, entry.name);
        const rel = path.relative(base, abs).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (includeDirs && re.test(rel)) matches.push(`${withPrefix(prefix, rel)}/`);
          walk(abs);
        } else if (entry.isFile() && re.test(rel)) {
          matches.push(withPrefix(prefix, rel));
        }
        if (matches.length >= limit) { truncated = true; return; }
      }
    };
    walk(base);

    matches.sort();
    return {
      pattern: args.pattern,
      ...(args.dir ? { dir: args.dir } : {}),
      // Named so a model cannot mistake this listing for the subject repository
      // it may also be holding (DECISIONS.md D38).
      target: host.target,
      count: matches.length,
      ...(truncated ? { truncated: true } : {}),
      paths: matches
    };
  }
};

const withPrefix = (prefix, rel) => (prefix ? `${prefix}/${rel}` : rel);

// A small glob, deliberately: segment `*`, cross-segment `**`, single-char `?`.
// No brace expansion and no character classes — those are a query language, and
// a model can call twice instead.
export function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` may match zero directories, so "**/x.js" finds a top-level x.js.
        if (p[i + 2] === '/') { out += '(?:[^/]*\\/)*'; i += 2; }
        else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}
