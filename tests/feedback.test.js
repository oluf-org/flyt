// Tool feedback: what the toolbox was like to work with (DESIGN-SPEC.md §8).
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
import { buildRetroPrompt, parseRetro, runRetrospectiveTurn, retroWorker, retroEnabled } from '../core/retroTurn.js';
import { callModel } from '../core/adapters/index.js';
import { makeRetrospective } from '../core/retrospective.js';
import { executeTool, getTools } from '../core/tools/index.js';
import { runAgent } from '../core/agent.js';
import { Workspace } from '../core/workspace.js';
import { makeStore, setScript, testConfig } from './helpers.js';
import { runExecutorTask } from '../core/nodes/executor.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-feedback-'));
const callScript = async prompt =>
  (await callModel({ provider: 'script', model: 'test-model', system: 'SYS', prompt, retry: { attempts: 1, baseMs: 1 } })).text;
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

test('the retrospective turn asks the instance what it had and what was missing', () => {
  // The available-tools list is load-bearing: without it a model reports
  // missing capabilities it was in fact granted, which is noise that looks
  // like signal in the digest.
  const prompt = buildRetroPrompt({
    goal: 'Add tag filtering to the store',
    availableTools: [
      { name: 'read_file', description: 'Read a file from the workspace.' },
      { name: 'bash', description: 'Run a shell command.' }
    ],
    toolCalls: [{ tool: 'bash', ok: false, ms: 5, error: 'rg: not found' }, { tool: 'bash', ok: true, ms: 9 }],
    output: 'Added filterByTag and its tests.'
  });
  assert.match(prompt, /YOUR TASK WAS:[\s\S]*Add tag filtering/);
  assert.match(prompt, /TOOLS YOU HAD[\s\S]*read_file[\s\S]*bash/);
  assert.match(prompt, /anything not here, you did not have/);
  assert.match(prompt, /WHAT YOU CALLED:[\s\S]*bash: 2 call\(s\), 1 failure\(s\)/);
  assert.match(prompt, /WHAT YOU PRODUCED:[\s\S]*filterByTag/);
});

test('a retrospective is parsed leniently, but cannot invent a tool it never had', () => {
  const available = [{ name: 'bash', description: '' }, { name: 'read_file', description: '' }];
  const parsed = parseRetro(`Here you go.
\`\`\`json
{"used":[{"tool":"bash","rating":"awkward","note":"six calls","improvement":"a search tool"},
         {"tool":"read_file","rating":"nonsense-rating"},
         {"tool":"web_search","rating":"good","note":"never had this"}],
 "missing":[{"want":"regex search across the repo","why":"finding callers"},{"why":"no want, so dropped"}]}
\`\`\``, { availableTools: available });

  assert.equal(parsed.used.length, 2, 'a review of a tool it never had is a hallucination, not evidence');
  assert.equal(parsed.used[0].rating, 'awkward');
  assert.equal(parsed.used[1].rating, 'adequate', 'an invented rating degrades rather than rejecting the lot');
  assert.equal(parsed.missing.length, 1, 'a request with no `want` says nothing');
  assert.equal(parsed.missing[0].want, 'regex search across the repo');

  // No block at all is "no retrospective", which callers treat as ordinary.
  assert.equal(parseRetro('I have no opinions.', { availableTools: available }), null);
});

test('the retrospective turn never fails the task it followed', async () => {
  setScript(() => { throw new Error('provider exploded'); });
  const problems = [];
  const answer = await runRetrospectiveTurn({
    worker: { provider: 'script', model: 'test-model' },
    goal: 'g', availableTools: [{ name: 'bash' }], output: 'done',
    retry: { attempts: 1, baseMs: 1 },
    onProblem: p => problems.push(p)
  });
  // The work is already written by the time this runs. A retrospective that
  // errors is absent, never an exception the caller has to survive.
  assert.equal(answer, null);
  assert.match(problems[0], /retrospective turn failed/);

  setScript(() => 'no json here at all');
  assert.equal(await runRetrospectiveTurn({
    worker: { provider: 'script', model: 'test-model' },
    goal: 'g', availableTools: [], output: 'done', retry: { attempts: 1, baseMs: 1 },
    onProblem: p => problems.push(p)
  }), null);
  assert.match(problems[1], /no parsable/);
});

test('the judgment can run on a different, cheaper worker than the work did', () => {
  const cheap = { provider: 'openrouter', model: 'cheap/model' };
  assert.deepEqual(retroWorker({ workers: { retrospective: cheap } }, { provider: 'anthropic', model: 'expensive' }), cheap);
  // Unconfigured, it falls back to whoever did the work — correct, not thrifty.
  assert.deepEqual(retroWorker({}, { provider: 'anthropic', model: 'expensive' }), { provider: 'anthropic', model: 'expensive' });
  // And it is off unless asked for: an attended user should not pay for a
  // second call per node they never requested.
  assert.equal(retroEnabled({}), false);
  assert.equal(retroEnabled({ retrospective: { enabled: true } }), true);
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

test('an instance is prompted again after finishing, and the reviewer folds it in', async () => {
  // The shape the user described: prompt -> completion -> prompted once more,
  // with the completion handed back, to produce the retrospective.
  const feedback = newStore();
  const seen = [];
  setScript(({ system, prompt }) => {
    seen.push({ system, prompt });
    if (!/ROLE: retrospective/.test(system)) return 'Done — filterByTag added.';
    return ['```json', JSON.stringify({
      used: [{ tool: 'bash', rating: 'awkward', note: 'Six calls to imitate a search.', improvement: 'a first-class search tool' }],
      missing: [{ want: 'search file contents by regex across the repo', why: 'finding callers', workaround: 'bash + grep' }]
    }), '```'].join('\n');
  });

  const work = await callScript('Do the work');
  assert.equal(work, 'Done — filterByTag added.');

  const answer = await runRetrospectiveTurn({
    worker: { provider: 'script', model: 'test-model' },
    goal: 'Add tag filtering',
    availableTools: [{ name: 'bash', description: 'Run a shell command.' }],
    toolCalls: [{ tool: 'bash', ok: false, ms: 4, error: 'rg: not found' }],
    output: work,
    retry: { attempts: 1, baseMs: 1 }
  });

  // The instance saw its own completion in the second prompt.
  assert.match(seen[1].prompt, /Done — filterByTag added\./);
  assert.equal(answer.used[0].rating, 'awkward');

  feedback.record({
    runId: 'r1', nodeId: 'work-1',
    usage: FeedbackStore.usageFromToolCalls([{ tool: 'bash', ok: false, ms: 4, error: 'rg: not found' }]),
    review: answer.used,
    missing: answer.missing
  });

  const digest = feedback.digest();
  assert.equal(digest.instances, 1);
  assert.equal(digest.tools.find(t => t.tool === 'bash').notes[0].rating, 'awkward');
  assert.equal(digest.missing[0].requests[0].workaround, 'bash + grep');
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

test('a real executor task produces a retrospective without being asked for one', async () => {
  // The full shape, through runExecutorTask: the instance gets its scoped
  // prompt and tools, finishes, and is then prompted again with its own
  // completion. Nothing volunteers anything — the turn simply happens.
  const store = makeStore();
  const runId = store.createRun('retro turn');
  const workspace = new Workspace(tmp()).ensure();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  store.writeTasks(runId, {
    tasks: [{
      id: 'task-1', title: 'Add tag filtering', goal: 'Add filterByTag and tests.',
      inputs: ['prompt.md'], constraints: [], status: 'pending',
      worker: { provider: 'script', model: 'test-model' }, tools: ['read_file']
    }]
  });

  const prompts = [];
  setScript(({ system, prompt }) => {
    prompts.push({ system, prompt });
    if (/ROLE: retrospective/.test(system)) {
      return ['```json', JSON.stringify({
        used: [{ tool: 'read_file', rating: 'awkward', note: 'No line range.', improvement: 'a line-range argument' }],
        missing: [{ want: 'regex search across the repo', why: 'finding callers', workaround: 'read whole files' }]
      }), '```'].join('\n');
    }
    return 'Added filterByTag and its tests.';
  });

  const feedback = newStore();
  const retro = await runExecutorTask(store, runId, 'task-1',
    testConfig({ retrospective: { enabled: true } }),
    { retry: { attempts: 1, baseMs: 1 }, feedback });

  assert.equal(retro.status, 'success');
  // The second prompt is the retrospective, and it carried the completion back.
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].system, /ROLE: retrospective/);
  assert.match(prompts[1].prompt, /Added filterByTag and its tests\./);
  assert.match(prompts[1].prompt, /TOOLS YOU HAD/);

  // It rides on the retrospective AND lands in the project's feedback pile.
  assert.equal(retro.review[0].improvement, 'a line-range argument');
  assert.equal(retro.missing[0].want, 'regex search across the repo');
  const [entry] = feedback.pending();
  assert.equal(entry.review[0].tool, 'read_file');
  assert.equal(entry.missing[0].want, 'regex search across the repo');
  assert.ok(store.readLog(runId).some(e => e.event === 'retrospective'));
});

test('with the turn off, a task costs exactly one call', async () => {
  const store = makeStore();
  const runId = store.createRun('no retro');
  const workspace = new Workspace(tmp()).ensure();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  store.writeTasks(runId, {
    tasks: [{
      id: 'task-1', title: 'T', goal: 'G', inputs: ['prompt.md'], constraints: [], status: 'pending',
      worker: { provider: 'script', model: 'test-model' }, tools: []
    }]
  });
  let calls = 0;
  setScript(() => { calls += 1; return 'done'; });
  await runExecutorTask(store, runId, 'task-1', testConfig(), { retry: { attempts: 1, baseMs: 1 } });
  // Off by default: an attended user does not pay for a second call per node
  // they never asked for.
  assert.equal(calls, 1);
});
