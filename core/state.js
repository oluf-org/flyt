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
    const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' +
      Math.random().toString(36).slice(2, 6);
    const dir = this.runDir(runId);
    fs.mkdirSync(path.join(dir, 'retrospectives'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.md'), prompt, 'utf8');
    this.writeMeta(runId, {
      runId,
      createdAt: new Date().toISOString(),
      stage: 'prompt',       // prompt | planning | awaiting_approval | routing | execution | verification | done | failed | rejected
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
  writeTaskOutput(runId, taskId, markdown) {
    fs.writeFileSync(path.join(this.runDir(runId), 'tasks', `${taskId}.md`), markdown, 'utf8');
  }
  readTaskOutput(runId, taskId) {
    const p = path.join(this.runDir(runId), 'tasks', `${taskId}.md`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
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
  appendLog(runId, entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(path.join(this.runDir(runId), 'log.jsonl'), line + '\n', 'utf8');
  }

  // Full snapshot for the UI.
  snapshot(runId) {
    return {
      meta: this.readMeta(runId),
      prompt: this.readPrompt(runId),
      plan: this.readPlan(runId),
      tasks: this.readTasks(runId),
      retrospectives: this.readRetrospectives(runId),
      taskOutputs: Object.fromEntries(
        (this.readTasks(runId)?.tasks ?? []).map(t => [t.id, this.readTaskOutput(runId, t.id)])
      )
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
