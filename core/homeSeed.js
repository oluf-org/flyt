// homeSeed (DECISIONS.md D38): a deterministic first look at the
// workspace the run is standing in.
//
// This is a SEED, not the deliverable. The orientation node gets it together
// with read-only tools, so it does not spend its first four tool calls
// rediscovering that package.json exists — and can go deeper wherever the seed
// looks thin or contradictory. The judgement (what is this project, and what
// relationship does it have to the repo we are about to read) is the agent's;
// assembling the obvious facts is not, and paying a model to list a directory
// is the kind of thing that makes a cheap step expensive.
//
// Pure and total: every section is optional, nothing throws, and a workspace
// that is genuinely empty yields a seed that SAYS so — which is a real finding
// (relation: empty), not a failure.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// The config directory is named in exactly one place (D29, tests/brand.test.js)
// and resolved per project, so a workspace that predates the rename is still
// found without this file knowing what it used to be called.
import { configDirName } from './workspace.js';

// Overall cap, then per-section budgets inside it. Same posture as
// SUMMARY_SOURCE_BUDGET: bounded, and truncation marked inline so a model can
// tell "this is all of it" from "this is the first part of it".
export const SEED_BUDGET = 4000;
const DOC_BUDGET = 1500;
const TREE_ENTRIES = 40;
const DECISION_LINES = 40;

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'README.md'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target', 'vendor']);

const clip = (text, max) => {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[${s.length - max} more characters — read the file if you need them]`;
};

// One workspace-relative read that never throws, whatever the path or the
// filesystem does.
function read(root, rel) {
  try {
    const p = path.join(root, rel);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

function gitFacts(root) {
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000
      }).trim();
    } catch { return ''; }
  };
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  const head = git('rev-parse', 'HEAD');
  return {
    head: head || null,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD') || null,
    remote: git('config', '--get', 'remote.origin.url') || null
  };
}

// The manifest, whichever ecosystem this is. `scripts` is the part that earns
// its place: `gates: ["npm test"]` on a backlog task should come from the
// commands this project actually has, not from a guess that happens to be
// right in most repositories.
function manifest(root) {
  const pkgRaw = read(root, 'package.json');
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      return {
        kind: 'node', name: pkg.name ?? null, description: pkg.description ?? null,
        scripts: pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : [],
        scriptBodies: pkg.scripts ?? {}
      };
    } catch { return { kind: 'node', broken: true }; }
  }
  for (const [file, kind] of [
    ['pyproject.toml', 'python'], ['Cargo.toml', 'rust'], ['go.mod', 'go'],
    ['pom.xml', 'java'], ['build.gradle', 'java'], ['Gemfile', 'ruby'], ['composer.json', 'php']
  ]) {
    if (read(root, file) != null) return { kind, file };
  }
  return null;
}

// Depth-2 directories with file counts, not a full listing: a real repository's
// full tree buries the shape it was meant to show.
function tree(root) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  const dirs = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name)).map(e => e.name).sort();
  const files = entries.filter(e => e.isFile()).map(e => e.name).sort();
  if (files.length) out.push(`. — ${files.length} file(s): ${files.slice(0, 12).join(', ')}${files.length > 12 ? ', …' : ''}`);
  for (const dir of dirs) {
    if (out.length >= TREE_ENTRIES) { out.push('… (more directories not listed)'); break; }
    let kids;
    try { kids = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    const fileCount = kids.filter(k => k.isFile()).length;
    const subs = kids.filter(k => k.isDirectory() && !SKIP_DIRS.has(k.name)).map(k => k.name).sort();
    out.push(`${dir}/ — ${fileCount} file(s)${subs.length ? `, subdirs: ${subs.slice(0, 8).join(', ')}${subs.length > 8 ? ', …' : ''}` : ''}`);
  }
  return out;
}

// `### D<n> — <title>` lines only. The titles answer "have we already decided
// this?" in about thirty lines; the bodies are the entire file.
function decisionTitles(root) {
  const text = read(root, 'DECISIONS.md');
  if (!text) return [];
  const titles = [...text.matchAll(/^#{2,4}\s*(D\d+\s*—.*)$/gm)].map(m => m[1].trim());
  return titles.length > DECISION_LINES
    ? [...titles.slice(-DECISION_LINES), `… (${titles.length - DECISION_LINES} earlier decisions not listed)`]
    : titles;
}

// The context file a previous run left behind (§3.3). Its presence turns the
// next orientation from a full survey into a confirm-or-revise, which is the
// whole reason it is written to the project rather than only to the run.
function priorContext(root) {
  const dir = configDirName(root);
  const text = read(root, path.join(dir, 'context.md'));
  return text == null ? null : { dir, text };
}

// Everything above, as one bounded markdown block.
//
// `workspace` is a core/workspace.js Workspace, or null when the run has none —
// which is itself the answer to the orientation question, so it produces a seed
// rather than an error.
export function homeSeed(workspace, { budget = SEED_BUDGET } = {}) {
  if (!workspace?.root) {
    return 'HOME WORKSPACE: none — this run is not bound to a project folder.\n'
      + 'There is nothing here to orient against: treat the home side as EMPTY.';
  }
  const root = workspace.root;
  const parts = [`HOME WORKSPACE: ${path.basename(root)}\nRoot: ${root}`];

  const git = gitFacts(root);
  if (git) {
    parts.push(['GIT', `- HEAD: ${git.head ?? '(unknown)'}`, `- branch: ${git.branch ?? '(unknown)'}`,
      `- remote: ${git.remote ?? '(none)'}`].join('\n'));
  }

  const man = manifest(root);
  if (man?.kind === 'node' && !man.broken) {
    parts.push(['MANIFEST (package.json)',
      `- name: ${man.name ?? '(unnamed)'}`,
      man.description ? `- description: ${man.description}` : null,
      man.scripts.length
        ? `- scripts: ${man.scripts.map(s => `${s} → ${String(man.scriptBodies[s]).slice(0, 60)}`).join('\n             ')}`
        : '- scripts: (none)'
    ].filter(Boolean).join('\n'));
  } else if (man?.broken) {
    parts.push('MANIFEST: package.json exists but does not parse.');
  } else if (man) {
    parts.push(`MANIFEST: ${man.file} — this looks like a ${man.kind} project.`);
  } else {
    parts.push('MANIFEST: none found (no package.json, pyproject.toml, Cargo.toml, go.mod, …).');
  }

  const t = tree(root);
  parts.push(t.length ? `TREE (depth 2)\n${t.map(l => `- ${l}`).join('\n')}` : 'TREE: the workspace is empty.');

  for (const file of INSTRUCTION_FILES) {
    const text = read(root, file);
    if (text != null) parts.push(`${file}\n${clip(text, DOC_BUDGET)}`);
  }

  const cfg = read(root, path.join(configDirName(root), 'config.json'));
  if (cfg != null) parts.push(`PROJECT CONFIG\n${clip(cfg, 400)}`);

  const decisions = decisionTitles(root);
  if (decisions.length) parts.push(`DECISIONS ALREADY TAKEN (titles from DECISIONS.md)\n${decisions.map(d => `- ${d}`).join('\n')}`);

  const prior = priorContext(root);
  if (prior) {
    parts.push(`EXISTING CONTEXT FILE (${prior.dir}/context.md) — written by an earlier run or by hand.\n`
      + 'Confirm or revise it; do not re-survey from scratch if it still holds.\n'
      + clip(prior.text, DOC_BUDGET));
  }

  // Section-by-section so the cut lands between sections where it can, rather
  // than mid-sentence in whichever one happened to be last.
  const out = [];
  let used = 0;
  for (const part of parts) {
    if (used + part.length > budget && out.length) {
      out.push(`…[seed truncated at ${budget} characters — use your tools to read further]`);
      break;
    }
    out.push(part);
    used += part.length + 2;
  }
  return out.join('\n\n');
}

// Which commands this project actually has, for the backlog contract's `gates`
// (§3.1 point 2). Empty when there is no manifest — a task with no checkable
// gate is better than one that names `npm test` in a repository that has none.
export function projectGates(workspace) {
  if (!workspace?.root) return [];
  const man = manifest(workspace.root);
  if (man?.kind !== 'node' || !man.scripts?.length) return [];
  return man.scripts.filter(s => ['test', 'lint', 'typecheck', 'build', 'check'].includes(s)).map(s => `npm run ${s}`)
    .map(cmd => cmd.replace('npm run test', 'npm test'));
}
