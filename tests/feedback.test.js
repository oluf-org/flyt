// Tool feedback: what the toolbox was like to work with (LOOP-PLAN §12).
//
// The split under test: the FACTS about tool use are derived from the run's own
// calls and cost nothing, while the JUDGMENT — was it awkward, what was missing
// — comes from the agent through a tool. And the reviewer folds both into ONE
// document rather than a pile of near-duplicate backlog entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeedbackStore, requestKey, recordToolUsage, clusterRequests, similarity, requestWords } from '../core/feedback.js';
import { makeRetrospective } from '../core/retrospective.js';
import { executeTool, getTools } from '../core/tools/index.js';
import { runAgent } from '../core/agent.js';
import { Workspace } from '../core/workspace.js';
import { makeStore, setScript } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-feedback-'));
const newStore = () => new FeedbackStore(path.join(tmp(), '.flyt', 'feedback'));

// --- the mechanical half ---------------------------------------------------

test('a retrospective summarizes its own tool use without being asked', () => {
  const retro = makeRetrospective({
    node: 'work-1',
    status: 'success',
    confidence: 0.75,
    toolCalls: [
      { tool: 'read_file', ok: true, ms: 12 },
      { tool: 'read_file', ok: true, ms: 8 },
      { tool: 'bash', ok: false, ms: 300, error: 'command not found: rg' },
      { tool: 'bash', ok: true, ms: 120 }
    ]
  });
  // Derived, never asked for: the facts are already in the calls, so spending a
  // model call to recount them would buy a worse answer at a higher price.
  assert.deepEqual(retro.tools.map(t => t.tool), ['read_file', 'bash']);
  assert.equal(retro.tools[0].calls, 2);
  assert.equal(retro.tools[1].failures, 1);
  assert.equal(retro.tools[1].ms, 420);
  assert.match(retro.tools[1].errors[0], /rg/);
});

test('an instance that called nothing leaves nothing behind', () => {
  const feedback = newStore();
  const retro = makeRetrospective({ node: 'n1', status: 'success', confidence: 1, toolCalls: [] });
  assert.equal(recordToolUsage(feedback, { runId: 'r1', nodeId: 'n1', retro }), null);
  assert.equal(feedback.pending().length, 0, 'no entry saying "used nothing, thought nothing"');
  // ...and a run with nowhere to record is a no-op, not a crash.
  assert.equal(recordToolUsage(null, { runId: 'r1', nodeId: 'n1', retro: { tools: [{ tool: 'x' }] } }), null);
});

// --- the judgment half -----------------------------------------------------

function toolCtx(feedback = newStore()) {
  const store = makeStore();
  const runId = store.createRun('feedback test');
  const workspace = new Workspace(tmp()).ensure();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  return { store, runId, nodeId: 'work-1', workspace, feedback };
}

test('tool_feedback records a review and a missing capability', async () => {
  const ctx = toolCtx();
  const rec = await executeTool('tool_feedback', {
    used: [{ tool: 'read_file', rating: 'awkward', note: 'No line range, so whole files had to be read.', improvement: 'a line-range argument' }],
    missing: [{ want: 'search file contents by regex across the repo', why: 'looking for every caller of resolveWorker', workaround: 'six bash calls with grep' }]
  }, ctx);

  assert.equal(rec.ok, true);
  const [entry] = ctx.feedback.pending();
  assert.equal(entry.review[0].rating, 'awkward');
  assert.equal(entry.missing[0].want, 'search file contents by regex across the repo');
  assert.equal(entry.nodeId, 'work-1');
  assert.ok(ctx.store.readLog(ctx.runId).some(e => e.event === 'tool_feedback'));
});

test('reporting gates honestly, and an empty report is refused', async () => {
  const { isDestructive } = await import('../core/tools/index.js');
  // It writes project state that outlives the run, so it gates like any other
  // out-of-run write — free under the loop's `always` mode, one prompt when
  // attended. Scoping it 'run' to dodge that would be a lie in the one field
  // the safety model reads (Q-L9).
  assert.equal(isDestructive('tool_feedback'), true);

  const ctx = toolCtx();
  const empty = await executeTool('tool_feedback', {}, ctx);
  assert.equal(empty.ok, false, 'a call with nothing in it is a failed call, not a silent no-op');
});

test('a long task may report more than once; reviews accumulate, facts overwrite', () => {
  const feedback = newStore();
  feedback.record({ runId: 'r1', nodeId: 'n1', usage: [{ tool: 'bash', calls: 1, failures: 0, ms: 5 }] });
  feedback.record({ runId: 'r1', nodeId: 'n1', review: [{ tool: 'bash', rating: 'good' }] });
  feedback.record({ runId: 'r1', nodeId: 'n1', review: [{ tool: 'read_file', rating: 'awkward' }] });
  feedback.record({ runId: 'r1', nodeId: 'n1', usage: [{ tool: 'bash', calls: 4, failures: 1, ms: 40 }] });

  const [entry] = feedback.pending();
  assert.equal(entry.review.length, 2, 'opinions accumulate — an agent learns as it goes');
  assert.equal(entry.usage[0].calls, 4, 'the mechanical record is simply true, so it replaces');
  assert.equal(feedback.pending().length, 1, 'one entry per instance, not one per report');
});

// --- the reviewer ----------------------------------------------------------

test('the digest groups by tool and by what was missing, keeping every context', () => {
  const feedback = newStore();
  // Three instances, two of which wanted the same thing in different words.
  feedback.record({
    runId: 'r1', nodeId: 'n1', task: 'task-1',
    usage: [{ tool: 'bash', calls: 6, failures: 2, ms: 900, errors: ['rg: not found'] }],
    review: [{ tool: 'bash', rating: 'awkward', note: 'six calls to fake a grep', improvement: 'a real search tool' }],
    missing: [{ want: 'search file contents by regex', why: 'finding callers', workaround: 'bash + grep' }]
  });
  feedback.record({
    runId: 'r1', nodeId: 'n2',
    usage: [{ tool: 'read_file', calls: 3, failures: 0, ms: 30 }],
    missing: [{ want: 'regex search of file contents', why: 'same problem again' }]
  });
  feedback.record({
    runId: 'r2', nodeId: 'n1',
    usage: [{ tool: 'bash', calls: 2, failures: 0, ms: 100 }],
    review: [{ tool: 'read_file', rating: 'awkward', note: 'no line range' }]
  });

  const d = feedback.digest();
  assert.equal(d.instances, 3);

  const bash = d.tools.find(t => t.tool === 'bash');
  assert.equal(bash.calls, 8, 'counts add up across instances');
  assert.equal(bash.failures, 2);
  assert.equal(bash.instances, 2);
  assert.equal(bash.notes[0].from.runId, 'r1', 'each note keeps the run it came from');

  // Different wording, same want: grouped, and the count is the argument for
  // building it.
  assert.equal(d.missing[0].requests.length, 2);
  assert.equal(requestKey('search file contents by regex'), requestKey('regex search of file contents'));

  // The document a human or a model actually reads.
  const md = FeedbackStore.renderDigest(d);
  assert.match(md, /## Tools used/);
  assert.match(md, /## Missing capabilities/);
  assert.match(md, /six calls to fake a grep/);
  assert.match(md, /×2/, 'the number of askers is on the page');
  assert.match(md, /from n1 in r1/, 'with the context to act on it');
});

test('digesting archives exactly what it covered, and nothing that arrived after', () => {
  const feedback = newStore();
  feedback.record({ runId: 'r1', nodeId: 'n1', review: [{ tool: 'bash', rating: 'good' }] });
  feedback.record({ runId: 'r1', nodeId: 'n2', review: [{ tool: 'bash', rating: 'good' }] });

  const d = feedback.digest();
  // An instance reports WHILE the digest is being written — it was never in
  // this document, so it must survive to be read by the next one.
  feedback.record({ runId: 'r3', nodeId: 'n9', missing: [{ want: 'a time machine' }] });

  const { archived, file } = feedback.writeDigest(d);
  assert.equal(archived.length, 2);
  assert.ok(fs.existsSync(file));
  const left = feedback.pending();
  assert.equal(left.length, 1, 'the late arrival was not swept away unread');
  assert.equal(left[0].runId, 'r3');
  assert.equal(feedback.digests().length, 1);
});

test('an unreadable entry is reported in the digest, not thrown past', () => {
  const feedback = newStore();
  feedback.record({ runId: 'r1', nodeId: 'n1', review: [{ tool: 'bash', rating: 'good' }] });
  fs.writeFileSync(path.join(feedback.pendingDir, 'broken.json'), '{ not json');
  const d = feedback.digest();
  assert.equal(d.instances, 1, 'the good one still counts');
  assert.equal(d.problems.length, 1);
  assert.match(FeedbackStore.renderDigest(d), /Unreadable entries/);
});

// --- end to end ------------------------------------------------------------

test('an agent reviews its tools mid-run, and the reviewer folds it in later', async () => {
  const ctx = toolCtx();
  let turn = 0;
  setScript(() => {
    turn += 1;
    if (turn === 1) {
      return [
        'I could not search the repo, so I shelled out repeatedly.',
        '```tool',
        JSON.stringify({
          tool: 'tool_feedback',
          args: {
            used: [{ tool: 'bash', rating: 'awkward', note: 'Six calls to imitate grep.', improvement: 'a first-class search tool' }],
            missing: [{ want: 'search file contents by regex across the repo', why: 'finding every caller', workaround: 'bash + grep, six calls' }]
          }
        }),
        '```'
      ].join('\n');
    }
    return 'Done. The change is made.';
  });

  const out = await runAgent({
    worker: { provider: 'script', model: 'test-model' },
    system: 'SYS', prompt: 'Do the work',
    tools: getTools(['tool_feedback']),
    ctx
  });
  assert.equal(out.toolCalls[0].tool, 'tool_feedback');
  assert.equal(out.toolCalls[0].ok, true);

  // The mechanical half joins it from the retrospective, without a model.
  const retro = makeRetrospective({
    node: 'work-1', status: 'success', confidence: 0.75, toolCalls: out.toolCalls
  });
  recordToolUsage(ctx.feedback, { runId: ctx.runId, nodeId: 'work-1', retro });

  const digest = ctx.feedback.digest();
  assert.equal(digest.instances, 1);
  assert.ok(digest.tools.find(t => t.tool === 'bash')?.notes.length, 'the opinion is there');
  assert.ok(digest.tools.find(t => t.tool === 'tool_feedback')?.calls, 'and the facts are too');
  assert.equal(digest.missing[0].requests[0].workaround, 'bash + grep, six calls');
});

test('requests that mean the same thing in different words are one group', () => {
  // The failure the first real digest showed: exact-key matching split "search
  // file contents by regex across the repo" from "regex search over file
  // contents", which is one request written twice. The count of who asked IS
  // the argument for building the thing, so splitting it defeats the purpose.
  const grouped = clusterRequests([
    { want: 'search file contents by regex across the repo' },
    { want: 'regex search over file contents' },
    { want: 'apply a patch or diff to a file instead of rewriting it whole' }
  ]);
  assert.equal(grouped.length, 2, 'two real wants, not three');
  const search = grouped.find(g => g.requests.length === 2);
  assert.ok(search, 'the two phrasings of the search request clustered');
  assert.equal(search.want, 'regex search over file contents', 'labelled with the shortest phrasing');

  // ...and genuinely different requests are NOT swept together.
  assert.ok(grouped.some(g => /patch or diff/.test(g.want) && g.requests.length === 1));
  assert.ok(similarity(requestWords('run the test suite'), requestWords('regex search over file contents')) < 0.5);
});
