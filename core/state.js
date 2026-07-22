// File-based state store. The filesystem is the single source of truth:
// every run lives in runs/<runId>/ as plain Markdown/JSON so any step is
// inspectable, resumable, and auditable. Modules never hold authoritative
// state in memory — they read and write these files.
import fs from 'node:fs';
import path from 'node:path';

export class RunStore {
  constructor(rootDir) {
    this.rootDir = rootDir; // e.g. <project>/runs
    fs.mkdirSync(rootDir, { recursive: true });
  }

  createRun(prompt) {
    // One clock read for both: the id IS the creation instant (timeFromRunId
    // recovers it for runs whose meta predates createdAt), so a second read
    // would have them disagree by a millisecond for no reason.
    const now = new Date();
    const runId = now.toISOString().replace(/[:.]/g, '-') + '-' +
      Math.random().toString(36).slice(2, 6);
    const dir = this.runDir(runId);
    fs.mkdirSync(path.join(dir, 'retrospectives'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.md'), prompt, 'utf8');
    this.writeMeta(runId, {
      runId,
      createdAt: now.toISOString(),
      stage: 'prompt',       // prompt | planning | awaiting_approval | awaiting_input | routing | execution | verification | done | failed | rejected | cancelled
      currentTaskId: null,
      error: null
    });
    this.appendLog(runId, { event: 'run_created', prompt: truncate(prompt) });
    return runId;
  }

  runDir(runId) { return path.join(this.rootDir, runId); }

  listRuns() {
    if (!fs.existsSync(this.rootDir)) return [];
    return fs.readdirSync(this.rootDir)
      .filter(d => fs.existsSync(path.join(this.rootDir, d, 'meta.json')))
      .sort();
  }

  // The index view of every run: enough for a list to name, group and sort runs
  // without opening any of them. There is no separate index file to drift —
  // runs are self-describing on disk, so a summary is just meta.json plus the
  // first line of prompt.md. Newest first, the order the list shows them in.
  runSummaries() {
    return this.listRuns()
      .map(runId => {
        let meta = {};
        try { meta = this.readMeta(runId) ?? {}; } catch { /* unreadable meta still lists, unnamed */ }
        const named = String(meta.name ?? '').trim();
        // Runs predating createdAt (and any half-written meta) still sort and
        // group correctly: the runId itself carries the creation instant.
        const createdAt = meta.createdAt ?? timeFromRunId(runId) ?? this.#mtime(runId);
        return {
          id: runId,
          name: named || deriveRunName(this.#tryPrompt(runId)),
          named: Boolean(named),
          createdAt,
          updatedAt: meta.updatedAt ?? createdAt,
          stage: meta.stage ?? 'unknown',
          flowName: meta.flowName ?? null,
          turns: Number(meta.turn ?? 0),
          interrupted: Boolean(meta.interrupted),
          error: meta.error ?? null
        };
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  // Rename a run. A blank name clears the override rather than storing an empty
  // string, so the run falls back to its prompt-derived name (the same rule the
  // flow-name field follows). Returns the name the run now shows.
  setRunName(runId, name) {
    const meta = this.readMeta(runId);
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_RUN_NAME);
    if (clean) meta.name = clean; else delete meta.name;
    this.writeMeta(runId, { ...meta, updatedAt: meta.updatedAt ?? new Date().toISOString() });
    this.appendLog(runId, { event: 'run_renamed', name: clean || null });
    return clean || deriveRunName(this.#tryPrompt(runId));
  }

  // Delete a run and everything under it. runId reaches this from the renderer
  // over IPC, so the resolved directory must be a direct child of runs/ — a
  // crafted id ('..', an absolute path) would otherwise recursively delete an
  // arbitrary folder.
  deleteRun(runId) {
    const dir = path.resolve(this.runDir(runId));
    if (path.dirname(dir) !== path.resolve(this.rootDir) || !fs.existsSync(dir)) {
      throw new Error(`Not a run in this store: "${runId}"`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  #tryPrompt(runId) {
    try { return this.readPrompt(runId); } catch { return ''; }
  }
  #mtime(runId) {
    try { return fs.statSync(this.runDir(runId)).mtime.toISOString(); } catch { return new Date(0).toISOString(); }
  }

  // --- meta (pipeline position) ---
  readMeta(runId) {
    return readJson(path.join(this.runDir(runId), 'meta.json'));
  }
  writeMeta(runId, meta) {
    writeJson(path.join(this.runDir(runId), 'meta.json'), meta);
  }
  setStage(runId, stage, extra = {}) {
    const meta = this.readMeta(runId);
    this.writeMeta(runId, { ...meta, ...extra, stage, updatedAt: new Date().toISOString() });
    this.appendLog(runId, { event: 'stage_change', stage, ...extra });
  }

  // --- artifacts ---
  readPrompt(runId) {
    return fs.readFileSync(path.join(this.runDir(runId), 'prompt.md'), 'utf8');
  }
  writePlan(runId, markdown) {
    fs.writeFileSync(path.join(this.runDir(runId), 'plan.md'), markdown, 'utf8');
  }
  readPlan(runId) {
    const p = path.join(this.runDir(runId), 'plan.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  writeTasks(runId, tasks) {
    writeJson(path.join(this.runDir(runId), 'tasks.json'), tasks);
  }
  readTasks(runId) {
    const p = path.join(this.runDir(runId), 'tasks.json');
    return fs.existsSync(p) ? readJson(p) : null;
  }
  // The audit log as parsed entries, for the replay scrubber (flare 6). Skips
  // any malformed line rather than failing the whole read.
  readLog(runId) {
    const p = path.join(this.runDir(runId), 'log.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').map(l => {
      try { return l.trim() ? JSON.parse(l) : null; } catch { return null; }
    }).filter(Boolean);
  }
  // Task spec markdown (written by the write_task_md tool): the agent's own
  // structured description of the task it is executing.
  writeTaskSpec(runId, taskId, markdown) {
    const p = path.join(this.runDir(runId), 'tasks', `${taskId}.spec.md`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, markdown, 'utf8');
    return path.join('tasks', `${taskId}.spec.md`);
  }

  // --- workspace: the only place agent tools may write arbitrary files ---
  // Resolves a tool-supplied relative path inside runs/<runId>/workspace/ and
  // rejects anything (.., absolute paths, drive letters) that escapes it.
  workspacePath(runId, relPath) {
    const base = path.join(this.runDir(runId), 'workspace');
    const resolved = path.resolve(base, String(relPath));
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`Path "${relPath}" escapes the run workspace`);
    }
    return resolved;
  }
  writeWorkspaceFile(runId, relPath, content) {
    const p = this.workspacePath(runId, relPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
    return path.relative(this.runDir(runId), p).split(path.sep).join('/');
  }
  // Read a workspace file (throws on paths that escape the workspace,
  // returns null when the file simply doesn't exist).
  readWorkspaceFile(runId, relPath) {
    const p = this.workspacePath(runId, relPath);
    return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  }

  writeTaskOutput(runId, taskId, markdown) {
    fs.writeFileSync(path.join(this.runDir(runId), 'tasks', `${taskId}.md`), markdown, 'utf8');
  }
  readTaskOutput(runId, taskId) {
    const p = path.join(this.runDir(runId), 'tasks', `${taskId}.md`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }

  // --- flow runs: the executed flow definition + per-node outputs ---
  writeFlow(runId, flow) {
    writeJson(path.join(this.runDir(runId), 'flow.json'), flow);
  }
  readFlow(runId) {
    const p = path.join(this.runDir(runId), 'flow.json');
    return fs.existsSync(p) ? readJson(p) : null;
  }
  nodeOutputPath(runId, nodeId) {
    return path.join(this.runDir(runId), 'nodes', `${String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '_')}.md`);
  }
  writeNodeOutput(runId, nodeId, markdown) {
    const p = this.nodeOutputPath(runId, nodeId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, markdown, 'utf8');
  }
  // Delete a node's output artifacts: nodes/<id>.md plus any auxiliary port
  // files nodes/<id>.<port>.md. RUN-CONTROL: a node being re-run (restartNode,
  // branch) must never hand its stale output to a downstream prompt.
  deleteNodeOutputs(runId, nodeId) {
    const dir = path.join(this.runDir(runId), 'nodes');
    if (!fs.existsSync(dir)) return;
    const safe = `${String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
    for (const f of fs.readdirSync(dir)) {
      // Exact match, or `<id>.<port>.md` (a `.` boundary, so node "a" never
      // matches "ab.md").
      if (f === safe || (f.startsWith(safe.slice(0, -3) + '.') && f.endsWith('.md'))) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  }
  deleteTaskOutput(runId, taskId) {
    const p = path.join(this.runDir(runId), 'tasks', `${taskId}.md`);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  // Duplicate one run directory into another (RUN-CONTROL branch): a full
  // recursive copy, so the fork carries every artifact the source produced.
  copyRunDir(srcRunId, destRunId) {
    fs.cpSync(this.runDir(srcRunId), this.runDir(destRunId), { recursive: true });
  }
  readNodeOutput(runId, nodeId) {
    const p = this.nodeOutputPath(runId, nodeId);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  readNodeOutputs(runId) {
    const dir = path.join(this.runDir(runId), 'nodes');
    if (!fs.existsSync(dir)) return {};
    const out = {};
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md')) out[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
    return out;
  }
  writeResult(runId, markdown) {
    fs.writeFileSync(path.join(this.runDir(runId), 'result.md'), markdown, 'utf8');
  }

  // --- refiner input gate (MODES-COMPARE T6): a refine node's clarifying
  // questions, parked until the user answers from the composer ---
  #questionsPath(runId, nodeId) {
    return path.join(this.runDir(runId), 'nodes', `${String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '_')}.questions.json`);
  }
  writeNodeQuestions(runId, nodeId, questions) {
    const p = this.#questionsPath(runId, nodeId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJson(p, questions);
  }
  readNodeQuestions(runId, nodeId) {
    const p = this.#questionsPath(runId, nodeId);
    return fs.existsSync(p) ? readJson(p) : null;
  }

  // --- follow-up turns (FOLLOWUP-PLAN): each reply to a finished run gets a
  // numbered folder under followups/, append-only like everything else ---
  followupDir(runId, turn) {
    return path.join(this.runDir(runId), 'followups', String(turn));
  }
  // The next free turn number. Derived from the folders rather than meta.turn,
  // so a turn that died before meta was updated can never be overwritten.
  nextTurn(runId) {
    const base = path.join(this.runDir(runId), 'followups');
    if (!fs.existsSync(base)) return 1;
    const used = fs.readdirSync(base).map(Number).filter(Number.isInteger);
    return used.length ? Math.max(...used) + 1 : 1;
  }
  // FU8: snapshot flow.json + meta.json before the turn mutates them, so every
  // turn boundary stays reconstructable.
  snapshotBeforeTurn(runId, turn) {
    const dir = path.join(this.followupDir(runId, turn), 'before');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['flow.json', 'meta.json']) {
      const src = path.join(this.runDir(runId), f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
    }
  }
  writeFollowupPrompt(runId, turn, text) {
    const dir = this.followupDir(runId, turn);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.md'), text, 'utf8');
  }
  writeFollowupTriage(runId, turn, obj) {
    const dir = this.followupDir(runId, turn);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'triage.json'), obj);
  }
  writeFollowupAnswer(runId, turn, markdown) {
    const dir = this.followupDir(runId, turn);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'answer.md'), markdown, 'utf8');
  }
  // Every turn, oldest first: { turn, prompt, triage, answer } with nulls for
  // pieces that don't exist (a question turn has no nodes; a turn that died
  // mid-triage has no triage.json).
  readFollowups(runId) {
    const base = path.join(this.runDir(runId), 'followups');
    if (!fs.existsSync(base)) return [];
    const tryRead = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
    const tryJson = p => { try { return readJson(p); } catch { return null; } };
    return fs.readdirSync(base)
      .map(Number).filter(Number.isInteger).sort((a, b) => a - b)
      .map(turn => ({
        turn,
        prompt: tryRead(path.join(base, String(turn), 'prompt.md')),
        triage: tryJson(path.join(base, String(turn), 'triage.json')),
        answer: tryRead(path.join(base, String(turn), 'answer.md'))
      }));
  }

  // --- retrospectives: the structured backbone every node must emit ---
  writeRetrospective(runId, name, retro) {
    writeJson(path.join(this.runDir(runId), 'retrospectives', `${name}.json`), retro);
    this.appendLog(runId, { event: 'retrospective', node: name, status: retro.status, confidence: retro.confidence });
  }
  readRetrospectives(runId) {
    const dir = path.join(this.runDir(runId), 'retrospectives');
    if (!fs.existsSync(dir)) return {};
    const out = {};
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) out[f.replace(/\.json$/, '')] = readJson(path.join(dir, f));
    }
    return out;
  }

  // --- audit log: every AI action observable ---
  // Safe under the concurrent writers that parallel agentTasks introduce (V1
  // task 6): appendFileSync opens/appends/closes in one synchronous call, which
  // Node runs to completion before any other continuation, so lines can never
  // interleave or be lost. Readability under concurrency comes from attribution
  // instead — entries emitted while tasks overlap carry `node: executor:<id>`,
  // so one task's story can still be followed end to end.
  appendLog(runId, entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(path.join(this.runDir(runId), 'log.jsonl'), line + '\n', 'utf8');
  }

  // Full snapshot for the UI.
  snapshot(runId) {
    const tasks = this.readTasks(runId);
    return {
      meta: this.readMeta(runId),
      prompt: this.readPrompt(runId),
      plan: this.readPlan(runId),
      tasks,
      retrospectives: this.readRetrospectives(runId),
      taskOutputs: Object.fromEntries(
        (tasks?.tasks ?? []).map(t => [t.id, this.readTaskOutput(runId, t.id)])
      ),
      // Flow runs only (null/empty for classic pipeline runs).
      flow: this.readFlow(runId),
      nodeOutputs: this.readNodeOutputs(runId),
      // Follow-up turns (empty for runs that were never replied to).
      followups: this.readFollowups(runId)
    };
  }

  // History across runs: prior retrospectives inform future planning.
  historyDigest(limit = 5) {
    const runs = this.listRuns().slice(-limit - 1);
    const lines = [];
    for (const runId of runs) {
      const retros = this.readRetrospectives(runId);
      for (const [name, r] of Object.entries(retros)) {
        if (r.recommendation) {
          lines.push(`- [${runId}/${name}] (${r.status}, confidence ${r.confidence}): ${r.recommendation}`);
        }
      }
    }
    return lines.slice(-20).join('\n');
  }
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); }
function truncate(s, n = 200) { return s.length > n ? s.slice(0, n) + '…' : s; }

export const UNTITLED_RUN = 'Untitled run';
const MAX_RUN_NAME = 80;

// What a run is called when nobody has named it: the first meaningful line of
// the prompt that started it, stripped of Markdown decoration and cut at a word
// boundary. Derived on read rather than written at creation, so the runs already
// on disk get a name too, and editing prompt.md keeps the list honest.
export function deriveRunName(prompt) {
  const line = String(prompt ?? '')
    .split(/\r?\n/)
    .map(l => l
      .replace(/^\s*(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/, '') // heading / quote / list marker
      .replace(/[*_`~]/g, '')                            // emphasis, code ticks
      .trim())
    .find(Boolean);
  if (!line) return UNTITLED_RUN;
  if (line.length <= MAX_RUN_NAME) return line;
  const cut = line.slice(0, MAX_RUN_NAME);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour a word boundary that isn't a drastic cut; otherwise take the
  // hard slice (one very long token).
  return (lastSpace > MAX_RUN_NAME * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

// runIds are minted as an ISO timestamp with ':' and '.' swapped for '-', so the
// creation instant is recoverable from the id alone.
function timeFromRunId(runId) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(String(runId));
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
