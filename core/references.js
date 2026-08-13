// The reference library (LOOP-PLAN §16).
//
// Zero new dependencies, and no vendored code (D24). These repositories are
// read as RECIPES: proven answers to problems this harness is about to hit,
// written by people who hit them first. Nobody — human or model — should design
// a session event stream from first principles when a working one is sitting on
// disk to read.
//
// The distinction from a bibliography is the whole point. A list of URLs in a
// planning document is a list an agent may or may not open, and mostly will not.
// A shallow clone under a read-only root, greppable at task time, is leverage:
// a task that says "give the supervisor an event stream the UI can attach to"
// should begin by reading how opencode did it, and the harness should make that
// the path of least resistance.
//
// Three properties are enforced rather than documented:
//
//   OUTSIDE every workspace and every worktree, so nothing can be accidentally
//   edited into a task's diff.
//   READ-ONLY, by there being no write path — not by a flag that could be
//   flipped. What is not implemented cannot be bypassed.
//   PINNED, so what an agent read yesterday is what it reads today; refreshing
//   is a deliberate act with a recorded commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './worktree.js';

// Skipped when walking a clone: enormous, uninteresting, and mostly generated.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'coverage', '.cache'
]);
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.mdx', '.txt',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.cs',
  '.sh', '.yml', '.yaml', '.toml', '.ini', '.sql', '.html', '.css', '.scss',
  '.vue', '.svelte', '.graphql', '.proto'
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// The repos this plan actually learned from (§16.2). Shipped as defaults so a
// fresh install has the library the design assumes, and overridable in
// config.json for a project that learns from something else.
export const DEFAULT_REFERENCES = [
  {
    name: 'self_improving_coding_agent',
    url: 'https://github.com/MaximeRobeyns/self_improving_coding_agent',
    about: 'The closest thing to a reference implementation of this whole plan: an archive of scored agent versions, the best of which proposes the next improvement, plus an asynchronous overseer watching for pathological behaviour. Read it for the self-improvement loop and its evaluation cycle.'
  },
  {
    name: 'opencode',
    url: 'https://github.com/sst/opencode',
    about: 'The server/client split. A headless harness over HTTP with every surface — TUI, web, desktop, IDE — as a client synchronized by an event stream. Read it for session lifecycle and for how one live session fans out to several attached viewers.'
  },
  {
    name: 'prime-agent',
    url: 'https://github.com/PrimeIntellect-ai/prime-agent',
    about: 'Long-running sessions: gate commands that must pass before a session may finish, explicit limits on continuations and turns, supervisor restart with session rehydration, and automatic compaction as context grows.'
  }
];

export function defaultReferenceRoot({ home = os.homedir() } = {}) {
  return path.join(home, '.flyt', 'references');
}

export class ReferenceLibrary {
  constructor(rootDir = null, { repos = DEFAULT_REFERENCES } = {}) {
    this.rootDir = path.resolve(rootDir ?? defaultReferenceRoot());
    this.repos = repos;
  }

  // A repo name is used to build a path and comes from config, a CLI argument
  // and a model's tool call, so it is validated rather than trusted.
  #assertName(name) {
    const s = String(name ?? '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s)) throw new Error(`Invalid reference name "${s}".`);
    return s;
  }

  dirFor(name) { return path.join(this.rootDir, this.#assertName(name)); }
  has(name) { try { return fs.statSync(this.dirFor(name)).isDirectory(); } catch { return false; } }

  /**
   * Resolve a `<repo>/<path>` reference to an absolute path inside the library.
   *
   * The confinement is the same shape `Workspace.resolve` uses, for the same
   * reason: the path half comes from a model, and `../../..` must fail here
   * rather than resolve to somewhere interesting.
   */
  resolve(ref) {
    const raw = String(ref ?? '').replace(/^reference:/, '');
    const [name, ...rest] = raw.split('/');
    const dir = this.dirFor(name);
    const rel = rest.join('/');
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      throw new Error(`Reference path escapes the library: "${ref}".`);
    }
    return abs;
  }

  meta(name) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dirFor(name), '.flyt-reference.json'), 'utf8')); }
    catch { return null; }
  }

  list() {
    return this.repos.map(repo => {
      const meta = this.meta(repo.name);
      return {
        ...repo,
        cloned: this.has(repo.name),
        commit: meta?.commit ?? null,
        clonedAt: meta?.clonedAt ?? null,
        dir: this.has(repo.name) ? this.dirFor(repo.name) : null
      };
    });
  }

  /**
   * Shallow-clone (or refresh) one repo, and record the commit it is pinned to.
   *
   * Depth 1: this library is for reading how something is done today, not for
   * its history, and a full clone of three reference repos is a lot of disk for
   * nothing.
   */
  async fetch(name, { onLog = () => {} } = {}) {
    const repo = this.repos.find(r => r.name === name);
    if (!repo) throw new Error(`No reference named "${name}".`);
    const dir = this.dirFor(name);
    fs.mkdirSync(this.rootDir, { recursive: true });

    if (this.has(name)) {
      onLog(`updating ${name}`);
      await git(['fetch', '--depth', '1', 'origin'], { cwd: dir });
      await git(['reset', '--hard', 'FETCH_HEAD'], { cwd: dir });
    } else {
      onLog(`cloning ${name} from ${repo.url}`);
      const args = ['clone', '--depth', '1', '--single-branch'];
      if (repo.ref) args.push('--branch', repo.ref);
      await git([...args, repo.url, dir], { cwd: this.rootDir, timeoutMs: 10 * 60 * 1000 });
    }
    const commit = await git(['rev-parse', 'HEAD'], { cwd: dir });
    const meta = { name, url: repo.url, commit, clonedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, '.flyt-reference.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  // Read one file out of the library. Null when it isn't there — a missing
  // reference file is an ordinary answer, not an error.
  read(ref, { maxChars = 60_000 } = {}) {
    const abs = this.resolve(ref);
    try {
      if (!fs.statSync(abs).isFile()) return null;
      const text = fs.readFileSync(abs, 'utf8');
      return text.length > maxChars
        ? `${text.slice(0, maxChars)}\n…[truncated at ${maxChars} characters]`
        : text;
    } catch { return null; }
  }

  // Every text file in a clone, relative to the library root.
  *walk(name, { dir = null, base = null } = {}) {
    const root = base ?? this.dirFor(name);
    const here = dir ?? root;
    let entries = [];
    try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(here, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        yield* this.walk(name, { dir: abs, base: root });
      } else if (entry.isFile() && TEXT_EXT.has(path.extname(entry.name))) {
        yield abs;
      }
    }
  }

  /**
   * Search the library for a pattern.
   *
   * This is the tool an agent actually reaches for: "how did opencode do X" is
   * a search, not a file path someone already knows. Results carry the file,
   * the line number and the line, so the next step is a `read_file` on a
   * specific place rather than on a whole repository.
   */
  search(pattern, { repo = null, maxResults = 40, maxPerFile = 3, contextLines = 0, flags = 'i' } = {}) {
    let re;
    // A model writes this pattern. An invalid regex is a bad argument, not a
    // crash, and the message has to say which part was wrong.
    try { re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}`); }
    catch (err) { throw new Error(`Invalid search pattern: ${err.message}`); }

    const names = repo ? [this.#assertName(repo)] : this.repos.map(r => r.name).filter(n => this.has(n));
    const results = [];
    let scanned = 0;

    for (const name of names) {
      if (!this.has(name)) continue;
      const root = this.dirFor(name);
      for (const abs of this.walk(name)) {
        if (results.length >= maxResults) return { results, truncated: true, scanned };
        let text;
        try {
          if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
          text = fs.readFileSync(abs, 'utf8');
        } catch { continue; }
        scanned += 1;
        if (!re.test(text)) { re.lastIndex = 0; continue; }
        re.lastIndex = 0;
        const lines = text.split('\n');
        // Capped per file, because one file that mentions the pattern forty
        // times will otherwise consume the whole result budget and hide the
        // file that actually answers the question. Seen immediately: a search
        // for `serve\(` returned six hits from three benchmark probes and
        // nothing from the server.
        let inThisFile = 0;
        for (let i = 0; i < lines.length && results.length < maxResults && inThisFile < maxPerFile; i++) {
          if (!re.test(lines[i])) { re.lastIndex = 0; continue; }
          re.lastIndex = 0;
          const rel = `${name}/${path.relative(root, abs).split(path.sep).join('/')}`;
          inThisFile += 1;
          results.push({
            ref: `reference:${rel}`,
            line: i + 1,
            text: lines[i].trim().slice(0, 300),
            ...(contextLines > 0
              ? { context: lines.slice(Math.max(0, i - contextLines), i + contextLines + 1).join('\n').slice(0, 1200) }
              : {})
          });
        }
      }
    }
    return { results, truncated: results.length >= maxResults, scanned };
  }

  // The hand-written map of what a repo is good for (§16.1). Falls back to the
  // configured `about`, so a library with no index still says something useful
  // rather than nothing.
  index(name) {
    const written = this.read(`${name}/references-index.md`) ?? this.read(`${name}/.flyt-index.md`);
    if (written) return written;
    const repo = this.repos.find(r => r.name === name);
    return repo?.about ?? null;
  }

  // What an agent is told exists, cheaply: names, what each is good for, and
  // whether it is actually on disk. This is what makes a search worth trying.
  catalog() {
    return this.list().map(r => ({
      name: r.name,
      about: r.about ?? null,
      cloned: r.cloned,
      commit: r.commit ? r.commit.slice(0, 8) : null
    }));
  }
}
