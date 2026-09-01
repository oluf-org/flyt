// File-based state store. The filesystem is the single source of truth:
// every run lives in runs/<runId>/ as plain Markdown/JSON so any step is
// inspectable, resumable, and auditable. Modules never hold authoritative
// state in memory — they read and write these files.
import fs from 'node:fs';
import path from 'node:path';

export class RunStore {
  constructor(rootDir, { projectId = null, telemetry = null } = {}) {
    this.rootDir = rootDir; // e.g. <project>/runs
    // Global analytics is a secondary sink. The per-run JSONL above remains
    // authoritative and a telemetry failure must never change execution.
    this.projectId = projectId;
    this.telemetry = telemetry;
    // The directory remains authoritative; this is only the next known free
    // number in this process so a many-tool run does not rescan every prior
    // result for every new result (quadratic metadata I/O).
    this.toolSequences = new Map();
    fs.mkdirSync(rootDir, { recursive: true });
  }

  createRun(prompt) {
    // One clock read for both: the id IS the creation instant (timeFromRunId
    // recovers it for runs whose meta predates createdAt), so a second read
    // would have them disagree by a millisecond for no reason.
    // Two starts can share one millisecond on fast machines. Keep creation
    // order in the file-backed id by advancing one millisecond past the newest
    // run already on disk; otherwise equal createdAt values leave the UI order
    // to a random suffix and make "newest first" nondeterministic.
    const latest = this.listRuns().at(-1);
    const latestMs = latest ? Date.parse(timeFromRunId(latest) ?? '') : NaN;
    const now = new Date(Math.max(Date.now(), Number.isNaN(latestMs) ? 0 : latestMs + 1));
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

  // A retired task's run folder is MOVED to the archive and replaced with a
  // pointer stub written by core/archive.js relocateRetiredRuns:
  //   { taskId, retiredAt, archivePath, revivedAt? }
  // Readers resolve this before treating the path as a run, so a retired run
  // reads as relocated rather than as missing. The stub is the spec's carrier,
  // not a second registry: nothing here reads the archived run data itself.
  runRetirement(runId) {
    const p = this.runDir(runId);
    try {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
      const stub = JSON.parse(fs.readFileSync(p, 'utf8'));
      const { taskId, retiredAt, archivePath, revivedAt } = stub ?? {};
      if (typeof taskId !== 'string' || !taskId) return null;
      if (typeof retiredAt !== 'string' || !retiredAt) return null;
      if (typeof archivePath !== 'string' || !archivePath) return null;
      // The run stayed in the archive; the TASK came back. A reader told only
      // that the run was "retired with task t-0092" is being told something that
      // stopped being true, so the revival travels with it.
      return {
        taskId, retiredAt, archivePath,
        ...(typeof revivedAt === 'string' && revivedAt ? { revivedAt } : {})
      };
    } catch { return null; }
  }

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
          stackId: meta.stackId ?? null,
          flowId: meta.flowId ?? null,
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
    this.toolSequences.delete(runId);
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
    let current = null;
    try { current = this.readMeta(runId); } catch { /* first write */ }
    const incoming = meta?.toolActivity ?? {};
    const existing = current?.toolActivity ?? {};
    const toolActivity = { ...existing };
    // A stale whole-meta write must not resurrect an older activity edge over
    // a newer one produced by a parallel node.
    for (const [node, edge] of Object.entries(incoming)) {
      if ((Number(edge?.sequence) || 0) >= (Number(toolActivity[node]?.sequence) || 0)) {
        toolActivity[node] = edge;
      }
    }
    const lifecycleChanged = current && (
      meta?.stage !== current.stage
      || meta?.interrupted !== current.interrupted
      || meta?.paused !== current.paused
    );
    if (lifecycleChanged) {
      const at = new Date().toISOString();
      for (const [node, edge] of Object.entries(toolActivity)) {
        if (edge?.active) toolActivity[node] = { ...edge, active: false, at };
      }
    }
    writeJson(path.join(this.runDir(runId), 'meta.json'), {
      ...meta,
      ...(Object.keys(toolActivity).length ? { toolActivity } : {})
    });
  }
  writeToolActivity(runId, nodeId, state) {
    let meta;
    try { meta = this.readMeta(runId); }
    catch { return null; } // standalone tool invocation: no run snapshot to update
    const activity = meta.toolActivity ?? {};
    const sequence = Math.max(0, ...Object.values(activity).map(x => Number(x?.sequence) || 0)) + 1;
    const edge = {
      tool: String(state?.tool ?? '').slice(0, 100),
      subject: typeof state?.subject === 'string' ? state.subject.slice(0, 60) : null,
      active: state?.active === true,
      at: new Date().toISOString(),
      sequence
    };
    this.writeMeta(runId, {
      ...meta,
      toolActivity: { ...activity, [String(nodeId ?? 'run')]: edge }
    });
    return edge;
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
  // --- tool results: every call's full result as an artifact (DESIGN-SPEC.md §5) -
  // The model gets a bounded preview and a handle; the untruncated result
  // lives here, so "file-based state is the single source of truth" holds for
  // what a tool returned as well as for what a node wrote.
  toolResultsDir(runId) { return path.join(this.runDir(runId), 'tools'); }

  // Claims the next free sequence number by CREATING the file exclusively
  // ('wx'), retrying on collision. Parallel agentTasks (V1 task 6) write here
  // concurrently, and a counter in memory is exactly the state a crash
  // destroys — the directory is the counter.
  writeToolResult(runId, record) {
    const dir = this.toolResultsDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const name = String(record?.tool ?? 'tool').replace(/[^a-zA-Z0-9_-]/g, '_');
    const nextOnDisk = () => {
      let next = 1;
      for (const f of fs.readdirSync(dir)) {
        const n = Number((f.match(/^(\d+)-/) ?? [])[1]);
        if (Number.isInteger(n) && n >= next) next = n + 1;
      }
      return next;
    };
    let seq = this.toolSequences.get(runId) ?? nextOnDisk();
    for (;;) {
      const file = `${seq}-${name}.json`;
      try {
        fs.writeFileSync(path.join(dir, file), JSON.stringify({ seq, ...record }, null, 2), { encoding: 'utf8', flag: 'wx' });
        this.toolSequences.set(runId, seq + 1);
        return { seq, file, path: `tools/${file}`, handle: `@tool:${seq}` };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Another process may have advanced beyond the cached value. One
        // collision earns one authoritative rescan; the exclusive create is
        // still the final arbiter if two writers race again.
        seq = Math.max(seq + 1, nextOnDisk());
      }
    }
  }

  // Read one back by sequence number (what read_tool_result resolves a handle
  // to). Null — never a throw — when there is no such artifact.
  readToolResult(runId, seq) {
    const dir = this.toolResultsDir(runId);
    if (!Number.isInteger(seq) || seq < 1 || !fs.existsSync(dir)) return null;
    const file = fs.readdirSync(dir).find(f => f.startsWith(`${seq}-`) && f.endsWith('.json'));
    if (!file) return null;
    try { return readJson(path.join(dir, file)); } catch { return null; }
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

  // --- summary nodes (DESIGN-SPEC.md §7) ---
  // Right-click summarization artifacts: one Markdown file per summary under
  // summaries/, plus an index.json registering every summary's provenance —
  // { id, sources: [{ id, statusAtCreation }], at, model, file, position? }.
  // A summary is a run artifact, never part of flow.json, and never re-runs:
  // it's a snapshot of what it read (D6), staleness is only recorded
  // (statusAtCreation), not tracked.
  summariesDir(runId) { return path.join(this.runDir(runId), 'summaries'); }

  // Summary ids/files are derived from source ids, so a crafted id must never
  // escape the summaries dir on delete/read.
  #summaryFile(file) {
    const f = String(file ?? '');
    if (!/^[a-zA-Z0-9_+-]+\.md$/.test(f)) throw new Error(`Invalid summary file "${f}"`);
    return f;
  }

  readSummaries(runId) {
    const p = path.join(this.summariesDir(runId), 'index.json');
    if (!fs.existsSync(p)) return [];
    try { return readJson(p)?.summaries ?? []; } catch { return []; }
  }
  writeSummaries(runId, summaries) {
    const dir = this.summariesDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'index.json'), { summaries });
  }
  readSummaryText(runId, file) {
    const p = path.join(this.summariesDir(runId), this.#summaryFile(file));
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  // Write the Markdown and upsert the index entry (same id replaces — a
  // re-summarize of the same sources refreshes in place).
  saveSummary(runId, entry, markdown) {
    const dir = this.summariesDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.#summaryFile(entry.file);
    fs.writeFileSync(path.join(dir, file), markdown, 'utf8');
    const list = this.readSummaries(runId);
    const idx = list.findIndex(e => e.id === entry.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    this.writeSummaries(runId, list);
    return entry;
  }
  updateSummaryPosition(runId, summaryId, position) {
    const list = this.readSummaries(runId);
    const e = list.find(x => x.id === summaryId);
    if (!e) return null;
    e.position = { x: Math.round(Number(position?.x) || 0), y: Math.round(Number(position?.y) || 0) };
    this.writeSummaries(runId, list);
    return e;
  }
  // Delete removes BOTH the file and the index entry (B4): a summary is only
  // ever the pair together.
  deleteSummary(runId, summaryId) {
    const list = this.readSummaries(runId);
    const e = list.find(x => x.id === summaryId);
    if (!e) return false;
    try { fs.rmSync(path.join(this.summariesDir(runId), this.#summaryFile(e.file)), { force: true }); }
    catch { /* file already gone — the entry still goes */ }
    this.writeSummaries(runId, list.filter(x => x.id !== summaryId));
    return true;
  }

  // --- refiner input gate (DECISIONS.md D27): a refine node's clarifying
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

  // --- follow-up turns (DECISIONS.md D21): each reply to a finished run gets a
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

  // --- comparison records (DECISIONS.md D27) -------------------------------
  // A comparison is a persisted relationship between two runs of this project:
  //   { id, runIds: [a, b], createdAt, origin: 'launch'|'rematch'|'manual',
  //     verdict: null | {...} }
  // The verdict slot is P3's (the judge writes it); P2 always stores null.
  // Records live in comparisons/ next to runs/ (the store root's sibling), and
  // meta.compareGroup on each run mirrors the pairing so siblings are
  // discoverable from either side. Tab state (compareRunIds) stays the *open
  // view* pointer; these records make pairings restorable across restarts.
  #comparisonsDir() { return path.join(path.dirname(this.rootDir), 'comparisons'); }

  newComparisonId() {
    return 'cmp-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' +
      Math.random().toString(36).slice(2, 6);
  }

  comparisonPath(id) {
    if (!/^cmp-[a-zA-Z0-9_-]+$/.test(String(id))) throw new Error(`Invalid comparison id "${id}"`);
    return path.join(this.#comparisonsDir(), `${id}.json`);
  }

  // Create or update a comparison record, then stamp meta.compareGroup on both
  // runs (label A/B by runIds order) so the pairing is discoverable from
  // either side. Runs already carrying a group keep it (a run may sit in
  // several comparisons; the meta pointer is first-come). An update preserves
  // createdAt and any verdict P3 has written.
  saveComparison({ id = null, runIds, origin = 'manual' } = {}) {
    if (!Array.isArray(runIds) || runIds.length !== 2
      || runIds.some(r => typeof r !== 'string' || !r) || runIds[0] === runIds[1]) {
      throw new Error('A comparison needs two distinct run ids.');
    }
    if (!['launch', 'rematch', 'manual'].includes(origin)) {
      throw new Error(`Unknown comparison origin "${origin}".`);
    }
    const cid = id ?? this.newComparisonId();
    const p = this.comparisonPath(cid);
    let prev = null;
    try { prev = readJson(p); } catch { /* new record */ }
    const record = {
      id: cid,
      runIds: [runIds[0], runIds[1]],
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      origin,
      verdict: prev?.verdict ?? null
    };
    fs.mkdirSync(this.#comparisonsDir(), { recursive: true });
    writeJson(p, record);
    for (const [i, label] of [[0, 'A'], [1, 'B']]) {
      try {
        const meta = this.readMeta(runIds[i]);
        if (meta && !meta.compareGroup) {
          this.writeMeta(runIds[i], { ...meta, compareGroup: { id: cid, label } });
        }
      } catch { /* run unreadable/gone — the record still stands */ }
    }
    return record;
  }

  listComparisons() {
    const dir = this.#comparisonsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return readJson(path.join(dir, f)); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  // P3: the judge's half of the record. Written after a run:judge call;
  // re-judging REPLACES the verdict (the record keeps the latest word, the
  // run logs keep every call). Shape per the design:
  //   { summary, winner?, axes?, judgeModel, at }   (+ notes — see core/judge.js)
  // Fields are sanitized here so a renderer (or a future automation) can never
  // land arbitrary junk in the file.
  saveComparisonVerdict(id, verdict = {}) {
    const p = this.comparisonPath(id); // validates the id shape
    let rec;
    try { rec = readJson(p); } catch { throw new Error(`Comparison ${id} not found.`); }
    const side = v => (v === 'A' || v === 'B' || v === 'tie' ? v : null);
    let axes = null;
    if (verdict.axes && typeof verdict.axes === 'object' && !Array.isArray(verdict.axes)) {
      const clean = {};
      for (const [k, v] of Object.entries(verdict.axes)) {
        const s = side(v);
        if (String(k).trim() && s) clean[String(k).trim()] = s;
      }
      if (Object.keys(clean).length) axes = clean;
    }
    rec.verdict = {
      summary: String(verdict.summary ?? ''),
      winner: side(verdict.winner),
      axes,
      notes: typeof verdict.notes === 'string' && verdict.notes.trim() ? verdict.notes.trim() : null,
      judgeModel: typeof verdict.judgeModel === 'string' && verdict.judgeModel ? verdict.judgeModel : 'unknown',
      at: typeof verdict.at === 'string' && verdict.at ? verdict.at : new Date().toISOString()
    };
    writeJson(p, rec);
    return rec;
  }

  // Run-deletion hygiene: comparisons naming the run go with it.
  deleteComparisonsFor(runId) {
    for (const rec of this.listComparisons()) {
      if (rec.runIds?.includes(runId)) {
        try { fs.rmSync(this.comparisonPath(rec.id), { force: true }); } catch { /* best effort */ }
      }
    }
  }

  // --- audit log: every AI action observable ---
  // Safe under the concurrent writers that parallel agentTasks introduce (V1
  // task 6): appendFileSync opens/appends/closes in one synchronous call, which
  // Node runs to completion before any other continuation, so lines can never
  // interleave or be lost. Readability under concurrency comes from attribution
  // instead — entries emitted while tasks overlap carry `node: executor:<id>`,
  // so one task's story can still be followed end to end.
  appendLog(runId, entry) {
    const recorded = { ts: new Date().toISOString(), ...entry };
    const line = JSON.stringify(recorded);
    fs.appendFileSync(path.join(this.runDir(runId), 'log.jsonl'), line + '\n', 'utf8');
    try { this.telemetry?.recordRunLog?.(this.projectId, runId, recorded); }
    catch { /* an analytical projection can never fail the run record */ }
  }

  // --- the liveness lease (D40) --------------------------------------------
  //
  // Which PROCESS is walking this run, refreshed while it walks.
  //
  // `live` was an in-memory Set, so "is anything running this?" could only ever
  // be answered about the current process. Every other process — a `flyt`
  // command, a second window, the desktop app opened beside a headless run —
  // saw an empty set, concluded the run had been cut off, marked it interrupted
  // and rewound its node statuses to pending underneath the process that was
  // still working on it. Reading a run in flight corrupted it, which made the
  // whole point of a headless front door self-defeating: you could start a run
  // without the app, but not look at it.
  writeLease(runId, lease) {
    const p = path.join(this.runDir(runId), 'live.json');
    try { fs.writeFileSync(p, JSON.stringify(lease), 'utf8'); } catch { /* a lease is advisory */ }
  }
  readLease(runId) {
    try { return JSON.parse(fs.readFileSync(path.join(this.runDir(runId), 'live.json'), 'utf8')); }
    catch { return null; }
  }
  clearLease(runId) {
    try { fs.rmSync(path.join(this.runDir(runId), 'live.json'), { force: true }); } catch { /* already gone */ }
  }

  // --- the model-call black box (D40) --------------------------------------
  // Every model call a node makes, kept per node in calls/<nodeId>.jsonl.
  //
  // The same records are in log.jsonl, interleaved with everything else; a
  // fan-out puts four lanes and several hundred tool calls in that one file,
  // and "what did THIS lane's calls look like" was a grep with a lot of hope in
  // it. One file per node makes the question a read.
  writeCallTrace(runId, nodeId, record) {
    const dir = path.join(this.runDir(runId), 'calls');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    fs.appendFileSync(path.join(dir, `${safeName(nodeId)}.jsonl`), line + '\n', 'utf8');
  }

  readCallTrace(runId, nodeId) {
    const file = path.join(this.runDir(runId), 'calls', `${safeName(nodeId)}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  // Every node that made a call this run, in the order the directory lists them.
  callTraceNodes(runId) {
    const dir = path.join(this.runDir(runId), 'calls');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, ''));
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
      followups: this.readFollowups(runId),
      // Summary nodes (D5): index entries joined with their Markdown text, so
      // the canvas derives summary cards + dashed edges with no extra reads.
      summaries: this.readSummaries(runId)
        .map(e => ({ ...e, text: this.readSummaryText(runId, e.file) }))
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

// The same sanitising nodeOutputPath applies, so a node's call trace and its
// output artifact are findable under the same name. Node ids carry ':' on the
// executor path ("executor:task-1"), which is not a legal Windows filename.
// A node id as a file name. Exported because the ledger has to compare a node
// it read from a DIRECTORY LISTING with one it read from a JSON key, and those
// are the same node written two ways: `interrogate:reask` is on disk as
// `interrogate_reask`. Comparing the two spellings without agreeing on one is
// how the same call got counted twice.
export function safeName(nodeId) { return String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '_'); }

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
