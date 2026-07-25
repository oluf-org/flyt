// Plaintext mirror (flare 7): a typeset dossier of a run, projected from the
// files the renderer already holds in its snapshot — meta, flow, tasks,
// retrospectives, node outputs. No new state; it's the same run the canvas
// shows, rendered for a terminal/issue/PR instead of a graph. Pure:
// runDocument(snapshot) → string, monospace, box-drawing rules + aligned columns.
import { outputKey, spawnedTasks } from './runGraph.js';
import { APP_NAME } from '../core/brand.js';

const RULE = '─';
const WIDTH = 62;

function rule(label) {
  if (!label) return RULE.repeat(WIDTH);
  const head = `${label} `;
  return head + RULE.repeat(Math.max(0, WIDTH - head.length));
}

function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtElapsed(meta) {
  const a = Date.parse(meta?.createdAt ?? '');
  const b = Date.parse(meta?.updatedAt ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const s = Math.max(0, Math.round((b - a) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);

export function runDocument(snapshot) {
  if (!snapshot?.meta) return '';
  const { meta, flow, tasks, retrospectives = {}, nodeOutputs = {}, taskOutputs = {}, prompt } = snapshot;
  const L = [];

  // Duration for a node: its own retrospective, or its executor task's.
  const durOf = node => {
    const tid = node.data?.taskId;
    const retro = retrospectives[node.id] ?? (tid ? retrospectives[`executor-${tid}`] : null);
    return fmtDur(retro?.durationMs);
  };
  const statusOf = id => meta.nodeStatus?.[id] ?? (flow ? 'pending' : '—');
  const hasArtifact = id => nodeOutputs[outputKey(id)] != null;

  // ---- header ----
  const runName = (prompt ?? '').split('\n').map(s => s.trim()).find(Boolean) || 'Untitled run';
  L.push(`${APP_NAME.toUpperCase()} — RUN DOSSIER`);
  L.push('═'.repeat(WIDTH));
  L.push('');
  L.push(`  Run       ${runName}`);
  L.push(`  Id        ${meta.runId ?? ''}`);
  if (flow) L.push(`  Flow      ${flow.name ?? meta.flowName ?? ''} · ${flow.nodes.length} nodes`);
  const doneN = Object.values(meta.nodeStatus ?? {}).filter(s => s === 'done').length;
  const totalN = flow?.nodes?.length ?? 0;
  L.push(`  Stage     ${meta.stage}${totalN ? ` · ${doneN}/${totalN} nodes done` : ''}`);
  if (meta.turn) L.push(`  Turns     ${meta.turn}`);
  const elapsed = fmtElapsed(meta);
  if (elapsed) L.push(`  Elapsed   ${elapsed}`);
  if (meta.error) L.push(`  Error     ${meta.error}`);
  L.push('');

  // ---- nodes ----
  if (flow?.nodes?.length) {
    L.push(rule('NODES'));
    L.push('');
    const ids = flow.nodes.map(n => n.id);
    const idW = Math.min(24, Math.max(8, ...ids.map(i => i.length)));
    const typeW = Math.max(...flow.nodes.map(n => (n.type || '').length), 4);
    for (const n of flow.nodes) {
      const st = statusOf(n.id);
      const mark = st === 'done' ? '✓' : st === 'failed' ? '✕' : st === 'active' ? '▸' : '·';
      const dur = padL(durOf(n), 6);
      const art = hasArtifact(n.id) ? '  ·  nodes/' + outputKey(n.id) + '.md' : '';
      L.push(`  ${mark} ${pad(st, 9)} ${pad(n.id, idW)}  ${pad(n.type, typeW)} ${dur}${art}`);
    }
    L.push('');
  }

  // ---- tasks (agent tasks, incl. spawned) ----
  const allTasks = tasks?.tasks ?? [];
  if (allTasks.length) {
    L.push(rule('TASKS'));
    L.push('');
    const titleW = Math.min(28, Math.max(5, ...allTasks.map(t => (t.title || t.id).length)));
    for (const t of allTasks) {
      const mark = t.status === 'done' ? '✓' : t.status === 'failed' ? '✕' : t.status === 'running' ? '▸' : '·';
      const worker = t.worker ? `${t.worker.provider}/${t.worker.model}` : '';
      const retro = retrospectives[`executor-${t.id}`];
      const dur = padL(fmtDur(retro?.durationMs), 6);
      const out = taskOutputs[t.id] != null ? '  ·  tasks/' + t.id + '.md' : '';
      L.push(`  ${mark} ${pad(t.id, 8)} ${pad((t.title || t.id).slice(0, titleW), titleW)}  ${pad(worker, 20)} ${dur}${out}`);
    }
    L.push('');
  }

  // Tasks with no node of their own — flag their origin so the dossier matches
  // the canvas, which draws them in a column of their own.
  const spawned = flow ? spawnedTasks(snapshot).map(s => s.task.id) : [];
  if (spawned.length) {
    L.push(`  spawned at run time: ${spawned.join(', ')}`);
    L.push('');
  }

  // ---- result ----
  const outputs = (flow?.nodes ?? [])
    .filter(n => n.type === 'output')
    .map(n => nodeOutputs[outputKey(n.id)])
    .filter(Boolean);
  if (outputs.length) {
    L.push(rule('RESULT'));
    L.push('');
    for (const o of outputs) for (const line of String(o).split('\n')) L.push(`  ${line}`);
    L.push('');
  }

  // ---- footer: where the files actually are ----
  L.push(rule());
  L.push(`runs/${meta.runId ?? ''}`);

  return L.join('\n');
}
