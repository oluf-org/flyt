// glob: list files in the workspace or one read-only reference by pattern
// (DECISIONS.md D38).
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
// Keep Flyt's authored config, context, backlog and skills discoverable while
// excluding high-volume runtime history that is not part of the source tree.
const SKIP_PATHS = new Set(['.flyt/runs', '.flyt/archive', '.flyt/feedback', '.flyt/chats', '.flyt/ledger', '.flyt/loop', '.flyt/incidents', '.flyt/userdata']);
const MAX_ENTRIES_SCANNED = 20_000;

export default {
  name: 'glob',
  title: 'List files',
  description: [
    'List files matching a glob pattern like "src/**/*.js", "*.md" or "**/package.json".',
    'By default this lists the bound workspace. To list a read-only reference repository, pass',
    'dir: "reference:<repo>" or a subdirectory such as "reference:opencode/packages/opencode/src".',
    'Returned paths are ready to hand to read_file. Build output, node_modules and .git are skipped.'
  ].join(' '),
  effects: ['read'],
  // A list of paths is cheap per entry and useless partially: the file you
  // needed is as likely to be the twenty-first as the first.
  result: { preview: 'json', maxPreviewChars: 12_000, artifact: true },
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
        description: 'Optional workspace subdirectory ("src") or read-only reference root/subdirectory ("reference:opencode" or "reference:opencode/packages/app"). Defaults to the workspace root.'
      },
      limit: {
        type: 'integer', minimum: 1, maximum: MAX_LIMIT,
        description: `Cap on paths returned (default ${DEFAULT_LIMIT}).`
      },
      offset: {
        type: 'integer', minimum: 0,
        description: 'Zero-based result offset for the next page. When truncated is true, repeat the call with nextOffset instead of repeating the same arguments.'
      },
      includeDirs: {
        type: 'boolean',
        description: 'Match directories as well as files (default false).'
      }
    }
  },
  async run(args, ctx) {
    const requestedDir = args.dir ? String(args.dir).replace(/\\/g, '/').replace(/\/+$/, '') : '';
    const reference = requestedDir.startsWith('reference:');
    let base;
    let prefix;
    let target;
    if (reference) {
      if (!ctx?.references) throw new Error('No reference library is available in this run.');
      const match = /^reference:([^/]+)(?:\/(.*))?$/.exec(requestedDir);
      if (!match) throw new Error(`Invalid reference directory "${requestedDir}".`);
      base = ctx.references.resolve(requestedDir);
      prefix = requestedDir;
      target = 'reference';
    } else {
      const host = fileHost(ctx);
      if (host.seam) {
        const basePrefix = requestedDir.replace(/^\.?\/*|\/*$/g, '');
        const re = globToRegExp(String(args.pattern ?? ''));
        const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit ?? DEFAULT_LIMIT)));
        const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)));
        const includeDirs = args.includeDirs === true;
        const entries = await host.seam.list(requestedDir || '.', host.execution?.signal);
        const matches = [];
        let scanned = 0;
        let scanTruncated = false;
        for (const entry of entries) {
          if (isSkipped(entry.path)) continue;
          // Remote seams commonly return a flat workspace walk. Do not let a
          // large ignored tree consume the scan budget before project files
          // are considered.
          if (++scanned > MAX_ENTRIES_SCANNED) { scanTruncated = true; break; }
          const relative = basePrefix && entry.path.startsWith(`${basePrefix}/`) ? entry.path.slice(basePrefix.length + 1) : entry.path;
          if ((entry.kind === 'file' || includeDirs) && re.test(relative)) matches.push(entry.kind === 'directory' ? `${entry.path}/` : entry.path);
        }
        matches.sort();
        const paths = matches.slice(offset, offset + limit);
        const truncated = scanTruncated || offset + paths.length < matches.length;
        return { pattern: args.pattern, ...(args.dir ? { dir: args.dir } : {}), target: host.target,
          offset, count: paths.length, ...(!scanTruncated ? { totalMatches: matches.length } : {}),
          ...(scanTruncated ? { scanLimitReached: true, hint: 'Narrow pattern or dir; repeating identical arguments cannot continue this scan.' } : {}),
          ...(truncated ? { truncated: true, ...(paths.length ? { nextOffset: offset + paths.length } : {}) } : {}), paths };
      }
      base = host.resolve(requestedDir || '.');
      prefix = requestedDir.replace(/^\.?\/*|\/*$/g, '');
      target = host.target;
    }
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      throw new Error(reference
        ? `Reference directory "${requestedDir}" does not exist.`
        : `Directory "${args.dir ?? '.'}" does not exist in the workspace.`);
    }
    const re = globToRegExp(String(args.pattern ?? ''));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit ?? DEFAULT_LIMIT)));
    const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)));
    const includeDirs = args.includeDirs === true;

    const matches = [];
    let scanned = 0;
    let scanTruncated = false;
    const walk = dir => {
      if (scanTruncated) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      catch { return; }
      for (const entry of entries) {
        if (++scanned > MAX_ENTRIES_SCANNED) { scanTruncated = true; return; }
        const abs = path.join(dir, entry.name);
        const rel = path.relative(base, abs).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (isSkipped(rel)) continue;
          if (includeDirs && re.test(rel)) matches.push(`${withPrefix(prefix, rel)}/`);
          walk(abs);
        } else if (entry.isFile() && re.test(rel)) {
          matches.push(withPrefix(prefix, rel));
        }
      }
    };
    walk(base);

    matches.sort();
    const paths = matches.slice(offset, offset + limit);
    const truncated = scanTruncated || offset + paths.length < matches.length;
    return {
      pattern: args.pattern,
      ...(args.dir ? { dir: args.dir } : {}),
      // Named so a model cannot mistake this listing for the subject repository
      // it may also be holding (DECISIONS.md D38).
      target,
      ...(reference ? { readOnly: true } : {}),
      offset,
      count: paths.length,
      ...(!scanTruncated ? { totalMatches: matches.length } : {}),
      ...(scanTruncated ? { scanLimitReached: true, hint: 'Narrow pattern or dir; repeating identical arguments cannot continue this scan.' } : {}),
      ...(truncated ? { truncated: true, ...(paths.length ? { nextOffset: offset + paths.length } : {}) } : {}),
      paths
    };
  }
};

const withPrefix = (prefix, rel) => (prefix ? `${prefix}/${rel}` : rel);

const isSkipped = relPath => {
  const normalized = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (normalized.split('/').some(segment => SKIP_DIRS.has(segment))) return true;
  return [...SKIP_PATHS].some(skipped => normalized === skipped || normalized.startsWith(`${skipped}/`));
};

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
