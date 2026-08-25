// Incidents: the things that stop everything, recorded where they cannot be
// missed.
//
// An incident is not a task failing. It is the machine being unable to work at
// all — an empty account, an expired sign-in, a model the provider will not
// serve, a binary that will not launch. Three properties separate one from an
// ordinary failure, and each of them was learned the expensive way:
//
//  1. NOTHING THE LOOP CAN DO RESOLVES IT. Retrying, escalating a rung and
//     moving to the next task all fail identically, so a loop that keeps going
//     is not being resilient, it is writing false history at speed.
//  2. IT IS NOT THE TASK'S FAULT. On 2026-08-24 an OpenRouter balance ran out
//     and the loop charged every 402 to whichever task happened to be next:
//     five tasks parked with reasons describing work that never ran, one of
//     them having climbed from `medium` to `xhigh` across six attempts without
//     receiving a single model call.
//  3. SOMEBODY HAS TO BE TOLD. A log line is not telling anybody. The process
//     that wrote it exits, and the next person to look sees a backlog full of
//     tasks that appear to have failed on their merits.
//
// So an incident is a FILE. It outlives the process, it is what `flyt doctor`,
// `flyt report`, the blockers and the loop status all read, and it stays open
// until somebody resolves it. Loud by construction rather than by remembering
// to print something.
//
// It also carries what it damaged. Nothing should be damaged now — the loop
// stops before charging anybody — but an incident recognised late still has to
// name the tasks whose attempts and effort ladders it spent, because that list
// is exactly what `flyt task reset` needs in order to put them back.
import fs from 'node:fs';
import path from 'node:path';

/** Where incidents live under the project's state directory. */
export const INCIDENTS_DIR = 'incidents';

/**
 * What kind of thing stopped. A closed vocabulary, like the failure codes it
 * sits above: these are matched on and rendered, and free text would be
 * re-parsed by everything downstream.
 */
export const INCIDENT_KINDS = [
  'provider',   // the provider refused in a way no attempt gets past
  'tooling',    // a tool failed the same way repeatedly; workers route around it
  'gate',       // a declared gate cannot run, or cannot fail
  'process',    // the process that owned the work is gone
];

const ID_RE = /^[0-9TZ:.\-]+-[a-z0-9]+$/i;

const dirOf = root => path.join(root, INCIDENTS_DIR);

function safeId(id) {
  const s = String(id ?? '');
  if (!ID_RE.test(s)) throw new Error(`Invalid incident id "${s}".`);
  return s;
}

/**
 * Record an incident. Returns the record, including the id to resolve it by.
 *
 * Idempotent on `dedupeKey`: an open incident with the same key is UPDATED
 * rather than joined by a second one. Twenty identical "out of credit" records
 * are not twenty times as informative, and a pile of them is its own way of
 * hiding the one fact they all carry.
 */
export function raiseIncident(root, {
  kind, code = null, detail = null, remedy = null,
  taskId = null, runId = null, damaged = [], dedupeKey = null, at = new Date().toISOString(),
} = {}) {
  if (!INCIDENT_KINDS.includes(kind)) throw new Error(`Unknown incident kind "${kind}".`);
  const key = dedupeKey ?? `${kind}:${code ?? 'none'}`;

  const existing = openIncidents(root).find(i => i.dedupeKey === key);
  if (existing) {
    const merged = {
      ...existing,
      lastAt: at,
      count: (existing.count ?? 1) + 1,
      // A later sighting can name a task the first one did not.
      damaged: mergeDamaged(existing.damaged ?? [], damaged),
    };
    write(root, merged);
    return merged;
  }

  const id = `${at.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  const record = {
    id, kind, code, detail, remedy,
    taskId, runId,
    dedupeKey: key,
    at, lastAt: at, count: 1,
    damaged: mergeDamaged([], damaged),
    resolvedAt: null, resolvedBy: null,
  };
  write(root, record);
  return record;
}

/** Every incident, newest first. */
export function listIncidents(root, { includeResolved = true } = {}) {
  let names = [];
  try { names = fs.readdirSync(dirOf(root)).filter(f => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dirOf(root), name), 'utf8'));
      if (!includeResolved && record.resolvedAt) continue;
      out.push(record);
    } catch { /* a torn file is not a reason to hide the rest */ }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** The ones still standing in the way. */
export const openIncidents = root => listIncidents(root, { includeResolved: false });

/**
 * Mark one resolved.
 *
 * By a person, or by the thing that proved it fixed — a run that completed on
 * the provider that was refusing is better evidence than somebody's opinion,
 * so `by` is recorded rather than assumed to be human.
 */
export function resolveIncident(root, id, { by = 'human', at = new Date().toISOString() } = {}) {
  const file = path.join(dirOf(root), `${safeId(id)}.json`);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = { ...record, resolvedAt: at, resolvedBy: by };
  write(root, next);
  return next;
}

/**
 * One line a human reads and acts on, or null when nothing is wrong.
 *
 * Deliberately blunt. This goes at the TOP of `flyt doctor`, `flyt report` and
 * the loop status, and its job is to stop somebody debugging a backlog full of
 * tasks that look like they failed.
 */
export function incidentHeadline(root) {
  const open = openIncidents(root);
  if (!open.length) return null;
  const first = open[0];
  const more = open.length > 1 ? ` (and ${open.length - 1} more)` : '';
  const seen = first.count > 1 ? `, seen ${first.count} times` : '';
  const damaged = first.damaged?.length
    ? ` ${first.damaged.length} task(s) were charged for it — \`flyt task reset --incident ${first.id}\` puts them back.`
    : '';
  // Evidence against it, if any has turned up since. Reported rather than acted
  // on: a call succeeding on a free model does not prove the account can afford
  // a paid one, so this names what happened and lets the reader judge.
  const since = first.succeededSince
    ? ` Since it was raised, ${first.succeededSince} call(s) have gone through`
      + `${first.lastSuccessModel ? ` (most recently on ${first.lastSuccessModel})` : ''}`
      + `, so it may already be fixed — \`flyt incident resolve ${first.id}\` closes it.`
    : '';
  return `${first.kind} incident${seen}${more}: ${first.detail ?? first.code ?? 'unknown'}`
    + `${first.remedy ? ` — ${first.remedy}` : ''}${damaged}${since}`;
}

/**
 * Record that a call went through while an incident was open.
 *
 * An incident that only a human can close is an incident that stays open, and
 * one that stays open past its truth is noise. The credit incident raised on
 * 2026-08-24 was still leading `flyt doctor` two days later, after dozens of
 * successful calls to the same provider — which is the failure this module
 * warns about for the damaged-task list, one level up.
 *
 * It does NOT resolve anything, and that restraint is the point. A call
 * succeeding on a model that costs nothing says nothing whatever about whether
 * the account can afford a paid one, so an empty balance is not disproved by
 * any amount of free traffic. What the evidence can honestly do is be reported
 * beside the incident, and let whoever reads it decide.
 */
export function noteSuccess(root, { model = null, at = new Date().toISOString() } = {}) {
  const open = openIncidents(root).filter(i => i.kind === 'provider');
  for (const incident of open) {
    write(root, {
      ...incident,
      succeededSince: (incident.succeededSince ?? 0) + 1,
      lastSuccessAt: at,
      lastSuccessModel: model ?? incident.lastSuccessModel ?? null,
    });
  }
  return open.length;
}

/**
 * Forget tasks an incident damaged, because they have been put back.
 *
 * The record stays — the incident happened, and that is history — but it stops
 * advertising a repair that is already done. A headline that keeps offering
 * `flyt task reset` for tasks already reset teaches people to ignore it, which
 * is the one thing a loud channel cannot afford.
 */
export function clearDamaged(root, id, taskIds = []) {
  const file = path.join(dirOf(root), `${safeId(id)}.json`);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const gone = new Set(taskIds.map(String));
  const next = {
    ...record,
    damaged: (record.damaged ?? []).filter(d => !gone.has(String(d.taskId))),
    restored: [...new Set([...(record.restored ?? []), ...gone])],
  };
  write(root, next);
  return next;
}

/** The tasks an incident damaged, with what they were before it. */
export function damagedBy(root, id) {
  const file = path.join(dirOf(root), `${safeId(id)}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).damaged ?? []; } catch { return []; }
}

// --- the parts ------------------------------------------------------------

function write(root, record) {
  fs.mkdirSync(dirOf(root), { recursive: true });
  fs.writeFileSync(path.join(dirOf(root), `${record.id}.json`), JSON.stringify(record, null, 2));
}

// A task is listed once. The FIRST snapshot wins, because it is the one taken
// closest to the state we want to restore — a second sighting has already been
// through an escalation and would record the damage as the baseline.
function mergeDamaged(existing, incoming) {
  const byId = new Map(existing.map(d => [d.taskId, d]));
  for (const d of incoming ?? []) {
    if (!d?.taskId || byId.has(d.taskId)) continue;
    byId.set(d.taskId, d);
  }
  return [...byId.values()];
}
