// File-based state store. The filesystem is the single source of truth:
// every run lives in runs/<runId>/ as plain Markdown/JSON so any step is
// inspectable, resumable, and auditable. Modules never hold authoritative
// state in memory — they read and write these files.
import fs from 'node:fs';
import path from 'node:path';
import { runMetrics, RUN_RECORD_VERSION } from './runMetrics.js';

// Re-exported from its natural home so `import { RUN_RECORD_VERSION } from
// './state.js'` keeps reading the way it should: the version belongs to the run
// record, the constant lives next to the code that interprets it.
export { RUN_RECORD_VERSION, hasMetrics } from './runMetrics.js';

export class RunStore {
  constructor(rootDir) {
    this.rootDir = rootDir; // e.g. <project>/runs
    fs.mkdirSync(rootDir, { recursive: true });
  }

  // The last millisecond this store minted an id at. Seeded lazily from disk on
  // first use so a restart doesn't hand out a stamp it already used.
  #lastStampMs = null;

  // Creation stamps are strictly increasing, because run *order* is derived
  // from them: two runs created inside the same millisecond used to produce
  // equal `createdAt` values, and equal keys left `runSummaries()` sorting on
  // whatever order readdir happened to return — i.e. on the random id suffix.
  // "Newest first" was a coin flip for fast-succeeding runs (it flaked
  // tests/runList.test.js roughly one run in five). Nudging the stamp forward
  // by a millisecond keeps ids self-describing (`timeFromRunId` still parses
  // them, still accurate to the millisecond) and makes ordering total.
  #nextStampMs() {
    if (this.#lastStampMs === null) {
      // Newest id on disk: listRuns() is sorted ascending and ids are stamped,
      // so the last entry carries the highest stamp this store has issued.
      const ids = this.listRuns();
      const newest = ids.length ? timeFromRunId(ids[ids.length - 1]) : null;
      this.#lastStampMs = newest ? Date.parse(newest) : 0;
    }
    const ms = Math.max(Date.now(), this.#lastStampMs + 1);
    this.#lastStampMs = ms;
    return ms;
  }

  createRun(prompt) {
    // One clock read for both: the id IS the creation instant (timeFromRunId
    // recovers it for runs whose meta predates createdAt), so a second read
    // would have them disagree by a millisecond for no reason.
    const now = new Date(this.#nextStampMs());
    const runId = now.toISOString().replace(/[:.]/g, '-') + '-' +
      Math.random().toString(36).slice(2, 6);
    const dir = this.runDir(runId);
    fs.mkdirSync(path.join(dir, 'retrospectives'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.md'), prompt, 'utf8');
    this.writeMeta(runId, {
      runId,
      // PIVOT-PLAN decision 15 (clean break): v2 runs carry a call ledger. A run
      // without this stamp predates it, and every investigator surface must say
      // "pre-metrics" rather than render zeros it cannot stand behind.
      recordVersion: RUN_RECORD_VERSION,
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
      // `_`-prefixed directories are the store's own, not runs. Today that is
      // runs/_index/ (PIVOT-PLAN §4.5), which carries a meta.json of its own and
      // would otherwise list as a run with no prompt and no stage. runIds are
      // timestamp-prefixed, so the namespace can never collide.
      .filter(d => !d.startsWith('_'))
      .filter(d => fs.existsSync(path.join(this.rootDir, d, 'meta.json')))
      .sort();
  }

  // Where the derived cross-run index lives (PIVOT-PLAN §4.5). Derived and
  // disposable: delete it and every number rebuilds identically.
  indexDir() { return path.join(this.rootDir, '_index'); }

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
      // Newest first. The id is the tie-break so the order is total even for
      // runs this store didn't stamp (imported, hand-made, or written by an
      // older build that could collide on the millisecond): equal timestamps
      // then order by id rather than by readdir's accident.
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
        || String(b.id).localeCompare(String(a.id)));
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
    this.forgetCalls(runId);
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
  // --- tool results: every call's full result as an artifact (TOOLS-PLAN §13) -
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
    let seq = 1;
    for (const f of fs.readdirSync(dir)) {
      const n = Number((f.match(/^(\d+)-/) ?? [])[1]);
      if (Number.isInteger(n) && n >= seq) seq = n + 1;
    }
    for (;;) {
      const file = `${seq}-${name}.json`;
      try {
        fs.writeFileSync(path.join(dir, file), JSON.stringify({ seq, ...record }, null, 2), { encoding: 'utf8', flag: 'wx' });
        return { seq, file, path: `tools/${file}`, handle: `@tool:${seq}` };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        seq += 1;
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

  // --- the call ledger: one record per model-call ATTEMPT (PIVOT-PLAN §4) ----
  //
  //   runs/<id>/calls/<seq>.json           the record
  //   runs/<id>/calls/<seq>.request.json   wire: what was sent
  //   runs/<id>/calls/<seq>.response.json  wire: what came back
  //
  // Immutable once written. Per ATTEMPT, not per node: a call that failed twice
  // before succeeding leaves three records, so retries stop being invisible.
  callsDir(runId) { return path.join(this.runDir(runId), 'calls'); }

  // Claims the next free sequence number by CREATING the record file
  // exclusively ('wx'), retrying on collision — the same rule writeToolResult
  // uses, for the same reason: parallel agentTasks write here concurrently and
  // a counter in memory is exactly the state a crash destroys.
  //
  // `wire` is { request, response } of already-redacted, already-bounded JSON
  // TEXT (core/callLedger.js owns both); this method only decides where it
  // lands. Returns the record as written, with its seq.
  writeCallRecord(runId, record, wire = null) {
    const dir = this.callsDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    let seq = 1;
    for (const f of fs.readdirSync(dir)) {
      const n = Number((f.match(/^(\d+)\.json$/) ?? [])[1]);
      if (Number.isInteger(n) && n >= seq) seq = n + 1;
    }
    for (;;) {
      try {
        // Claim the slot first, empty; the real content follows. A reader that
        // catches the gap sees unparseable JSON, which readCalls() skips —
        // strictly better than two attempts sharing a sequence number.
        fs.writeFileSync(path.join(dir, `${seq}.json`), '', { encoding: 'utf8', flag: 'wx' });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        seq += 1;
      }
    }
    const written = { seq, ...record };
    if (wire?.request != null) {
      fs.writeFileSync(path.join(dir, `${seq}.request.json`), wire.request, 'utf8');
    }
    if (wire?.response != null) {
      fs.writeFileSync(path.join(dir, `${seq}.response.json`), wire.response, 'utf8');
    }
    // The wire pointer can only be written once the sequence number is claimed,
    // which is here — so the record stays self-describing on disk without the
    // ledger having to guess its own file name.
    if (written.wire) {
      written.wire = {
        ...written.wire,
        request: wire?.request != null ? `calls/${seq}.request.json` : null,
        response: wire?.response != null ? `calls/${seq}.response.json` : null
      };
    }
    writeJson(path.join(dir, `${seq}.json`), written);
    return written;
  }

  // Records are immutable once written, so a record read once never needs
  // reading again. The cache holds what has been seen; each call re-lists the
  // directory (one syscall) and reads only the sequence numbers that are new.
  // Without this, a live run's snapshot — pushed several times a second while
  // text streams — re-read every call record it had ever written, every time.
  #callCache = new Map(); // runId -> Map(seq -> record)

  // Every call record for a run, oldest first. Unparseable files are skipped
  // rather than fatal — a record half-written when the process died must not
  // make the whole run unreadable — and are retried on the next read, because a
  // record claimed but not yet filled in becomes readable a moment later.
  readCalls(runId) {
    const dir = this.callsDir(runId);
    if (!fs.existsSync(dir)) return [];
    let seen = this.#callCache.get(runId);
    if (!seen) this.#callCache.set(runId, seen = new Map());
    const seqs = fs.readdirSync(dir)
      .map(f => Number((f.match(/^(\d+)\.json$/) ?? [])[1]))
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
    const out = [];
    for (const seq of seqs) {
      let rec = seen.get(seq);
      if (!rec) {
        try { rec = readJson(path.join(dir, `${seq}.json`)); } catch { rec = null; }
        if (rec) seen.set(seq, rec);
      }
      if (rec) out.push(rec);
    }
    return out;
  }

  // Drop a run's cached records (deletion, branch, a test reusing a directory).
  forgetCalls(runId) { this.#callCache.delete(runId); }

  // One wire file's raw text. `which` is 'request' or 'response'. Null when the
  // call captured no wire (a CLI-delegate call, or capture turned off).
  readCallWire(runId, seq, which) {
    if (!Number.isInteger(Number(seq)) || !['request', 'response'].includes(which)) return null;
    const p = path.join(this.callsDir(runId), `${Number(seq)}.${which}.json`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }

  // --- ask_human answers (TOOLS-PLAN §14.5) ---------------------------------
  // What the user told an agent, kept per task. The call stack does not
  // survive a crash; this does — so a task re-run after a restart recalls the
  // answer instead of asking again, and the cap survives with it.
  answersPath(runId, taskId) {
    const safe = String(taskId ?? 'run').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.runDir(runId), 'answers', `${safe}.json`);
  }
  readAskAnswers(runId, taskId) {
    const p = this.answersPath(runId, taskId);
    if (!fs.existsSync(p)) return [];
    try {
      const doc = readJson(p);
      return Array.isArray(doc?.answers) ? doc.answers : [];
    } catch { return []; }
  }
  writeAskAnswer(runId, taskId, entry) {
    const p = this.answersPath(runId, taskId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const answers = [...this.readAskAnswers(runId, taskId), { ...entry, at: new Date().toISOString() }];
    writeJson(p, { task: taskId ?? null, answers });
    return answers.length;
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

  // --- summary nodes (OUTPUT-VIEW-PLAN B4/D5) ---
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

  // --- comparison records (CONFIGS-COMPARE P2) -------------------------------
  // A comparison is a persisted relationship between two runs of this project:
  //   { id, runIds: [a, b], createdAt, origin: 'launch'|'rematch'|'manual',
  //     verdict: null | {...} }
  // The verdict slot is P3's (the judge writes it); P2 always stores null.
  // Records live in comparisons/ next to runs/ (the store root's sibling), and
  // meta.compareGroup on each run mirrors the pairing so siblings are
  // discoverable from either side. Tab state (compareRunIds) stays the *open
  // view* pointer; these records make pairings restorable across restarts.
  #comparisonsDir() { return path.join(path.dirname(this.rootDir), 'comparisons'); }

  // Same monotonic clock as run ids, for the same reason: `listComparisons()`
  // orders on createdAt, and two comparisons saved in one millisecond would
  // otherwise tie. Sharing the counter means a comparison can push the next run
  // id forward a millisecond — cheaper than a second counter that can disagree.
  newComparisonId() {
    return 'cmp-' + new Date(this.#nextStampMs()).toISOString().replace(/[:.]/g, '-') + '-' +
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
      createdAt: prev?.createdAt ?? new Date(this.#nextStampMs()).toISOString(),
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
      // Newest first, id as the tie-break — see runSummaries().
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
        || String(b.id).localeCompare(String(a.id)));
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
      followups: this.readFollowups(runId),
      // Summary nodes (D5): index entries joined with their Markdown text, so
      // the canvas derives summary cards + dashed edges with no extra reads.
      summaries: this.readSummaries(runId)
        .map(e => ({ ...e, text: this.readSummaryText(runId, e.file) })),
      // The call ledger, folded (PIVOT-PLAN P3). Derived on read like every
      // other view here — there is no metrics file to drift from the records.
      metrics: this.runMetrics(runId)
    };
  }

  // Derived metrics for one run. Cheap enough for a live snapshot because
  // readCalls() only reads records it has not seen (see #callCache).
  runMetrics(runId) {
    let meta = null;
    try { meta = this.readMeta(runId); } catch { /* unreadable meta still yields metrics */ }
    return runMetrics(this.readCalls(runId), meta);
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
