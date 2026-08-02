// What a repo search should never look at.
//
// Two layers: a hardcoded floor (directories nobody ever means, and which are
// big enough to dominate a walk) plus the project's own .gitignore. The
// .gitignore support is the useful subset — literal paths, `*`/`**`/`?`,
// leading `/` for root-anchored, trailing `/` for directory-only, `!` for
// negation — not the full spec. Anything it can't parse is skipped rather
// than guessed at: over-searching is a slow answer, under-searching is a wrong
// one, and a search tool that silently hid files would be the worse failure.
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from './glob.js';

export const ALWAYS_SKIP = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.venv', '__pycache__', 'target', 'vendor'
]);

// Returns (relPath, isDir) => true when the entry should be skipped.
export function loadIgnore(root) {
  const rules = parseGitignore(path.join(root, '.gitignore'));
  return (rel, isDir) => {
    const name = rel.split('/').pop();
    if (ALWAYS_SKIP.has(name)) return true;
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(rel) || rule.re.test(name)) ignored = !rule.negated;
    }
    return ignored;
  };
}

function parseGitignore(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    let body = negated ? line.slice(1) : line;
    const dirOnly = body.endsWith('/');
    if (dirOnly) body = body.slice(0, -1);
    const anchored = body.startsWith('/');
    if (anchored) body = body.slice(1);
    if (!body) continue;
    try {
      // An unanchored rule matches at any depth, which is what `node_modules`
      // in a .gitignore is understood to mean.
      rules.push({ re: globToRegExp(anchored ? body : `**/${body}`), negated, dirOnly });
      if (!anchored) rules.push({ re: globToRegExp(body), negated, dirOnly });
    } catch { /* an unparseable rule is skipped, never guessed at */ }
  }
  return rules;
}
