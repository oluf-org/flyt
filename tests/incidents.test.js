// Incidents, and putting back what one of them took (core/incidents.js).
//
// The night this comes from: an OpenRouter balance ran out mid-loop, and the
// loop charged every 402 to whichever task was next — five parked with reasons
// describing work that never ran, one having climbed from `medium` to `xhigh`
// across six attempts without receiving a single model call. Repairing that by
// hand took knowing what each task had been BEFORE, which nothing recorded.
//
// So two things are tested here. That an incident is loud and durable, because
// a log line dies with the process that wrote it. And that a reset restores the
// rung a task actually started on rather than a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  raiseIncident, listIncidents, openIncidents, resolveIncident,
  incidentHeadline, damagedBy, clearDamaged, noteSuccess, INCIDENT_KINDS,
} from '../core/incidents.js';
import { Backlog } from '../core/backlog.js';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-inc-'));
const backlogIn = r => new Backlog(path.join(r, 'backlog'));

const CREDIT = {
  kind: 'provider',
  code: 'credit',
  detail: 'This request requires more credits, or fewer max_tokens',
  remedy: 'Add credit. Waiting will not clear it.',
};

// --- the record ------------------------------------------------------------

test('an incident outlives the process that met it', () => {
  const r = root();
  const raised = raiseIncident(r, CREDIT);

  // Read back by something that never saw the object — which is the whole
  // point, because the process that raised it has exited by the time anyone
  // looks.
  const [found] = listIncidents(r);
  assert.equal(found.id, raised.id);
  assert.equal(found.code, 'credit');
  assert.equal(found.resolvedAt, null);
});

test('the same fault twice is one incident, counted', () => {
  // Twenty identical "out of credit" records are not twenty times as
  // informative, and a pile of them hides the one fact they all carry.
  const r = root();
  raiseIncident(r, CREDIT);
  raiseIncident(r, CREDIT);
  const again = raiseIncident(r, CREDIT);

  assert.equal(listIncidents(r).length, 1);
  assert.equal(again.count, 3);
  assert.match(incidentHeadline(r), /seen 3 times/);
});

test('an incident stays in the way until somebody says otherwise', () => {
  const r = root();
  const raised = raiseIncident(r, CREDIT);
  assert.equal(openIncidents(r).length, 1);
  assert.match(incidentHeadline(r), /Add credit/);

  resolveIncident(r, raised.id, { by: 'olav' });
  assert.equal(openIncidents(r).length, 0);
  assert.equal(incidentHeadline(r), null, 'and stops shouting once it is dealt with');
  assert.equal(listIncidents(r)[0].resolvedBy, 'olav', 'but it is still history');
});

test('a headline names the repair, and stops naming it once it is done', () => {
  const r = root();
  const raised = raiseIncident(r, {
    ...CREDIT,
    damaged: [{ taskId: 't-0083', attempts: 3, level: 'xhigh' }],
  });
  assert.match(incidentHeadline(r), /flyt task reset --incident/,
    'the command that undoes it is in the message, not in a manual');

  clearDamaged(r, raised.id, ['t-0083']);
  assert.ok(!/flyt task reset --incident/.test(incidentHeadline(r)),
    'a channel that keeps offering a repair already done teaches people to ignore it');
  assert.deepEqual(damagedBy(r, raised.id), []);
});

test('an unknown kind is refused rather than recorded', () => {
  const r = root();
  assert.throws(() => raiseIncident(r, { kind: 'vibes' }), /Unknown incident kind/);
  for (const kind of INCIDENT_KINDS) {
    assert.doesNotThrow(() => raiseIncident(r, { kind, dedupeKey: kind }));
  }
});

test('a torn file does not hide the incidents beside it', () => {
  const r = root();
  raiseIncident(r, CREDIT);
  fs.writeFileSync(path.join(r, 'incidents', 'broken.json'), '{ not json');
  assert.equal(listIncidents(r).length, 1, 'the readable one still reads');
});

// --- putting a task back ---------------------------------------------------

test('escalating records where the ladder started, once', () => {
  const r = root();
  const b = backlogIn(r);
  const t = b.add({ title: 'x', goal: 'g', level: 'medium' });

  b.escalate(t.id, { reason: 'failed', workerAt: l => l });
  assert.equal(b.get(t.id).baseLevel, 'medium', 'the ground it started from');
  b.escalate(t.id, { reason: 'failed', workerAt: l => l });
  assert.equal(b.get(t.id).level, 'xhigh');
  assert.equal(b.get(t.id).baseLevel, 'medium',
    'and the second rung does not record the first rung as the ground');
});

test('a reset puts back the rung, the attempts and the silence', () => {
  const r = root();
  const b = backlogIn(r);
  const t = b.add({ title: 'x', goal: 'g', level: 'low' });
  b.escalate(t.id, { reason: 'failed', workerAt: l => l });
  b.escalate(t.id, { reason: 'failed', workerAt: l => l });
  b.update(t.id, { resumeFrom: 'deadbeef', resumeStage: 'gates', failureSignature: 'abc' });

  const out = b.reset(t.id, { reason: 'provider was out of credit' });

  assert.equal(out.level, 'low', 'the level it was authored at, not a guess');
  assert.equal(out.attempts, 0, 'attempts that never reached a model are not attempts');
  assert.equal(out.status, 'queued');
  assert.equal(out.baseLevel, null, 'and the ladder has no history to undo any more');
  assert.equal(out.resumeFrom, null, 'a task starting over must not resume a judged commit');
  assert.equal(out.resumeStage, null);
  assert.equal(out.failureSignature, null);
  assert.match(out.blockedReason, /provider was out of credit/,
    'the reason it was reset is worth keeping; the reason it was parked is not');
  // What it was, so the caller can say what changed rather than "done".
  assert.equal(out.before.level, 'high', 'low, escalated twice');
  assert.equal(out.before.attempts, 2);
});

test('a task nobody escalated resets to exactly what it is', () => {
  const r = root();
  const b = backlogIn(r);
  const t = b.add({ title: 'x', goal: 'g', level: 'high' });
  const out = b.reset(t.id);
  assert.equal(out.level, 'high', 'no baseLevel means the level IS the base');
  assert.equal(out.status, 'queued');
});

test('a reset clears the lease, or the task can never be picked up again', () => {
  const r = root();
  const b = backlogIn(r);
  const t = b.add({ title: 'x', goal: 'g' });
  b.take('supervisor');
  assert.ok(fs.existsSync(path.join(r, 'backlog', `${t.id}.lock`)));

  b.reset(t.id);
  assert.ok(!fs.existsSync(path.join(r, 'backlog', `${t.id}.lock`)),
    'a queued task holding a lock nobody owns is a task that never runs again');
  assert.equal(b.get(t.id).claimedBy, null);
});

test('landed work has nothing to put back', () => {
  const r = root();
  const b = backlogIn(r);
  const t = b.add({ title: 'x', goal: 'g' });
  b.update(t.id, { status: 'landed' });
  assert.throws(() => b.reset(t.id), /landed/);
});

test('resetting something that is not there says so rather than inventing it', () => {
  assert.equal(backlogIn(root()).reset('t-9999'), null);
});

test('a call going through is recorded against an open incident, not treated as a fix', () => {
  // The credit incident raised on 2026-08-24 was still leading flyt doctor two
  // days and dozens of successful free calls later, because nothing ever closed
  // one but a human. An incident that outlives its truth is noise, and noise is
  // what a loud channel cannot afford.
  const r = root();
  const raised = raiseIncident(r, CREDIT);

  noteSuccess(r, { model: 'stealth/ox-alpha' });
  noteSuccess(r, { model: 'stealth/ox-alpha' });

  const [after] = listIncidents(r);
  assert.equal(after.succeededSince, 2);
  assert.equal(after.lastSuccessModel, 'stealth/ox-alpha');
  assert.equal(after.resolvedAt, null,
    'succeeding on a model that costs nothing does not prove a paid call would');
  assert.equal(openIncidents(r).length, 1, 'so it is still in the way');

  const said = incidentHeadline(r);
  assert.match(said, /2 call\(s\) have gone through/);
  assert.match(said, /most recently on stealth\/ox-alpha/);
  assert.match(said, /may already be fixed/);
  assert.match(said, new RegExp(`flyt incident resolve ${raised.id}`),
    'the reader is handed the decision, not asked to go looking for it');
});

test('nothing is said about calls going through when nothing is wrong', () => {
  const r = root();
  assert.equal(noteSuccess(r, { model: 'x' }), 0);
  assert.equal(incidentHeadline(r), null);
});

test('a resolved incident is not annotated by later traffic', () => {
  const r = root();
  const raised = raiseIncident(r, CREDIT);
  resolveIncident(r, raised.id, { by: 'olav' });

  noteSuccess(r, { model: 'x' });
  assert.equal(listIncidents(r)[0].succeededSince ?? 0, 0, 'it is history, not a live question');
});
