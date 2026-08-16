// Workspace orientation (HOME-CONTEXT / D38): the deterministic seed, the
// stance contract, the context file, and the addressing hygiene that stops a
// node reading OUR repository and reporting it as a finding about someone
// else's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlowRunner, contextIsStale, readContextStamp, orientSummary, ORIENT_SUMMARY_WORDS } from '../core/flowRunner.js';
import { homeSeed, projectGates, SEED_BUDGET } from '../core/homeSeed.js';
import { parseOrientation, stripJsonBlock } from '../core/planEval.js';
import { Workspace } from '../core/workspace.js';
import { globToRegExp } from '../core/tools/glob.js';
import { sharedPreamble } from '../core/nodes/fanout.js';
import { executeTool } from '../core/tools/index.js';
import { makeStore, setScript, roleOf, testConfig, waitFor, waitForStage, makeFlow, node, edge } from './helpers.js';

function tmpProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-home-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
  }
  return dir;
}

// --- the seed (P2) ----------------------------------------------------------

test('the seed reads a real project without being told anything about it', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ name: 'thing', description: 'A thing.', scripts: { test: 'node --test', lint: 'eslint .' } }),
    'README.md': '# Thing\n\nIt does the thing.',
    'CLAUDE.md': '# Guidance\n\nRead GOALS.md first.',
    'DECISIONS.md': '### D1 — We chose files over a database\nbody\n\n### D2 — One engine, not two\nbody',
    'src/index.js': 'export const x = 1;',
    'src/deep/nested.js': 'export const y = 2;',
    'node_modules/junk/index.js': 'nobody wants this'
  });
  const seed = homeSeed(new Workspace(dir));
  assert.match(seed, /MANIFEST \(package\.json\)/);
  assert.match(seed, /name: thing/);
  assert.match(seed, /scripts: test → node --test/, 'the scripts are where a real gate command comes from');
  assert.match(seed, /src\/ — 1 file\(s\), subdirs: deep/);
  assert.match(seed, /# Guidance/);
  assert.match(seed, /D1 — We chose files over a database/);
  assert.match(seed, /D2 — One engine, not two/);
  assert.ok(!seed.includes('nobody wants this'), 'node_modules is not the shape of your project');
});

test('the seed says "empty" rather than failing on an empty or unbound workspace', () => {
  const bare = homeSeed(new Workspace(tmpProject()));
  assert.match(bare, /TREE: the workspace is empty\./);
  assert.match(bare, /MANIFEST: none found/);

  const none = homeSeed(null);
  assert.match(none, /HOME WORKSPACE: none/);
  assert.match(none, /treat the home side as EMPTY/);
});

test('the seed is deterministic, bounded, and marks its truncation', () => {
  const dir = tmpProject({
    'package.json': '{"name":"big"}',
    'README.md': 'x'.repeat(40_000),
    'CLAUDE.md': 'y'.repeat(40_000)
  });
  const ws = new Workspace(dir);
  const a = homeSeed(ws);
  assert.equal(a, homeSeed(ws), 'identical bytes in, identical seed out');
  assert.ok(a.length <= SEED_BUDGET + 200, `seed is bounded (${a.length})`);
  assert.match(a, /more characters — read the file if you need them|seed truncated at/);
});

test('a missing manifest, README or config is a shrug, not a throw', () => {
  const dir = tmpProject({ 'notes.txt': 'hello' });
  assert.doesNotThrow(() => homeSeed(new Workspace(dir)));
  assert.deepEqual(projectGates(new Workspace(dir)), [], 'no manifest means no gate to name');
});

test('projectGates names commands the project actually has', () => {
  const dir = tmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'node --test', build: 'tsc', dev: 'vite' } }) });
  const gates = projectGates(new Workspace(dir));
  assert.deepEqual(gates, ['npm test', 'npm run build'], 'dev is not a gate; test and build are');
});

// --- the stance contract (P3) -----------------------------------------------

const stance = (over = {}) => 'Some prose about the project.\n\n```json\n' + JSON.stringify({
  relation: 'similar', confidence: 'high',
  mission: 'find where they solved our scheduling problem better than we did.',
  focus: ['the scheduler'], ignore: ['their CSS'],
  assumptions: [], questions: [],
  ...over
}) + '\n```';

test('parseOrientation: a well-formed stance survives', () => {
  const r = parseOrientation(stance());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.orientation.relation, 'similar');
  assert.deepEqual(r.orientation.focus, ['the scheduler']);
  assert.deepEqual(r.orientation.ignore, ['their CSS']);
});

test('parseOrientation: an invented relation is rejected, never coerced', () => {
  const r = parseOrientation(stance({ relation: 'kind-of-similar' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /relation: required, one of/.test(e)));
});

test('parseOrientation: "unrelated" needs no mission — there is nothing to go and learn', () => {
  const r = parseOrientation(stance({ relation: 'unrelated', mission: '' }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.orientation.relation, 'unrelated');

  const other = parseOrientation(stance({ relation: 'similar', mission: '' }));
  assert.equal(other.ok, false, 'every other stance owes the readers a mission');
});

test('parseOrientation: questions come back in the refiner shape, capped at three', () => {
  const r = parseOrientation(stance({
    relation: 'empty',
    questions: [
      { id: 'what', text: 'What are you building?', why: 'nothing here says' },
      { text: 'Second' }, { text: 'Third' }, { text: 'Fourth' }
    ]
  }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.orientation.questions.length, 3, 'every question costs the user a round-trip');
  assert.equal(r.orientation.questions[0].id, 'what');
  assert.equal(r.orientation.questions[1].id, 'q2', 'a question with no id gets a positional one');
});

test('parseOrientation is total: prose alone comes back as errors, never a throw', () => {
  const r = parseOrientation('I think this project is quite similar to that one.');
  assert.equal(r.ok, false);
  assert.ok(r.errors.length);
});

test('the context file is the prose, without the machine block', () => {
  const text = stripJsonBlock(stance());
  assert.equal(text, 'Some prose about the project.');
  assert.equal(stripJsonBlock('no block here'), 'no block here');
});

test('the summary is capped in code, not by instruction', () => {
  // It reaches EVERY lane of a fan-out, and a detailed shared prior is exactly
  // what collapses the divergence a fan-out exists to produce.
  const prose = `# Context\n\n## This project\n${'word '.repeat(4000)}\n\n## Where it stands\nmore`;
  const summary = orientSummary(
    { relation: 'adjacent', confidence: 'medium', mission: 'find the transferable mechanism.' }, prose);
  assert.ok(summary.split(/\s+/).length <= ORIENT_SUMMARY_WORDS + 1, summary.split(/\s+/).length);
  assert.match(summary, /Relation to the subject: adjacent/);
  assert.match(summary, /find the transferable mechanism\./);
});

// --- the context file (P5) ---------------------------------------------------

test('staleness: a different subject, a moved HEAD, or plain age all re-survey', () => {
  const fresh = { written: new Date().toISOString(), head: 'abc', subject: 'repo-a', bodyHash: 'x' };
  assert.equal(contextIsStale(fresh, { subject: 'repo-a', head: 'abc' }), false);
  assert.equal(contextIsStale(fresh, { subject: 'repo-b', head: 'abc' }), true,
    'a context written while reading another repository says nothing trustworthy about this one');
  assert.equal(contextIsStale(fresh, { subject: 'repo-a', head: 'def' }), true);
  assert.equal(contextIsStale({ ...fresh, written: '2020-01-01T00:00:00Z' }, { subject: 'repo-a' }), true);
  assert.equal(contextIsStale(null), true);
  assert.equal(contextIsStale({ written: 'nonsense' }), true);
});

test('the stamp round-trips out of the file it was written into', () => {
  const stamp = { written: '2026-08-15T00:00:00.000Z', head: 'abc', subject: 'r', bodyHash: 'h' };
  const file = `<!-- flyt-context: ${JSON.stringify(stamp)} -->\n\n# Context\n\nbody`;
  assert.deepEqual(readContextStamp(file), stamp);
  assert.equal(readContextStamp('# Context\n\nhand-written, no stamp'), null);
});

// --- glob (P2/P3 dependency) -------------------------------------------------

test('glob matches within a segment, across segments, and one character', () => {
  assert.ok(globToRegExp('*.md').test('README.md'));
  assert.ok(!globToRegExp('*.md').test('docs/README.md'), '* does not cross a separator');
  assert.ok(globToRegExp('**/*.md').test('docs/deep/README.md'));
  assert.ok(globToRegExp('**/*.md').test('README.md'), '**/ matches zero directories too');
  assert.ok(globToRegExp('src/?.js').test('src/a.js'));
  assert.ok(!globToRegExp('src/?.js').test('src/ab.js'));
});

test('glob lists the project and skips what is not the project', async () => {
  const dir = tmpProject({
    'package.json': '{}', 'README.md': '#', 'src/a.js': '1', 'src/deep/b.js': '2',
    'node_modules/pkg/index.js': '3', '.git/config': '4'
  });
  const store = makeStore();
  const ctx = { workspace: new Workspace(dir), store, runId: 'r1' };
  const all = await executeTool('glob', { pattern: '**/*.js' }, ctx);
  assert.deepEqual(all.result.paths, ['src/a.js', 'src/deep/b.js']);
  assert.equal(all.result.target, 'workspace', 'the result says which root it came from');
  const top = await executeTool('glob', { pattern: '*.md' }, ctx);
  assert.deepEqual(top.result.paths, ['README.md']);
  const scoped = await executeTool('glob', { pattern: '*.js', dir: 'src' }, ctx);
  assert.deepEqual(scoped.result.paths, ['src/a.js'], 'paths come back ready for read_file');
});

// --- addressing hygiene (P1) -------------------------------------------------

const orientFlow = (data = {}) => makeFlow(
  [node('in', 'input', { text: 'brief' }),
   node('step', 'aiStep', { role: 'analyze', title: 'Read', tools: ['read_file'], ...data }),
   node('out', 'output')],
  [edge('in', 'step'), edge('step', 'out')]);

test('a node pointed at a subject that reads the workspace instead is logged', async () => {
  const dir = tmpProject({ 'src/ours.js': 'export const ours = 1;' });
  const store = makeStore();
  let asked = false;
  setScript(({ prompt }) => {
    if (asked) return 'done';
    asked = true;
    return '```tool\n{"tool":"read_file","args":{"path":"src/ours.js"}}\n```';
  });
  const runner = new FlowRunner(store, testConfig());
  // subjectRepo is what materializeInputs stamps when a repo input feeds a node.
  const runId = runner.start(orientFlow({ subjectRepo: 'their-repo' }), { userInput: 'brief', workspace: dir });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const hit = store.readLog(runId).find(l => l.event === 'tool_target_unexpected');
  assert.ok(hit, 'a read of the wrong root must not be invisible');
  assert.equal(hit.path, 'src/ours.js');
  assert.equal(hit.expected, 'reference:their-repo');
});

test('a node that reads the workspace by design is not reported for doing so', async () => {
  const dir = tmpProject({ 'src/ours.js': 'export const ours = 1;' });
  const store = makeStore();
  let asked = false;
  setScript(() => {
    if (asked) return 'done';
    asked = true;
    return '```tool\n{"tool":"read_file","args":{"path":"src/ours.js"}}\n```';
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(orientFlow({ subjectRepo: 'their-repo', subjectStrict: false }),
    { userInput: 'brief', workspace: dir });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');
  assert.ok(!store.readLog(runId).some(l => l.event === 'tool_target_unexpected'),
    'orient surveys home on purpose');
});

test('every file result says which root it came from', async () => {
  const dir = tmpProject({ 'src/ours.js': 'export const ours = 1;' });
  const store = makeStore();
  const transcripts = [];
  let asked = false;
  setScript(({ prompt }) => {
    transcripts.push(prompt);
    if (asked) return 'done';
    asked = true;
    return '```tool\n{"tool":"read_file","args":{"path":"src/ours.js"}}\n```';
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(orientFlow(), { userInput: 'brief', workspace: dir });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');
  // The information always existed on the result; it was buried in the JSON
  // body among the file's own contents, which is where nobody reads it.
  assert.ok(transcripts.some(t => /\[from THIS PROJECT's own workspace/.test(t)),
    'the answer says which root before it says anything else');
});

// --- the orient node, end to end (P3–P6) -------------------------------------

const STANCE = (over = {}) => '# Context\n\n## This project\nA flow runner.\n\n'
  + '## The relationship\nWe solve the same problem.\n\n```json\n'
  + JSON.stringify({
    relation: 'similar', confidence: 'high',
    mission: 'find where they solved our scheduling problem better than we did.',
    focus: ['the scheduler'], ignore: ['their CSS'], assumptions: [], questions: [],
    ...over
  }) + '\n```';

const flowWithOrient = (extra = {}) => makeFlow(
  [node('in', 'input', { text: 'brief' }),
   node('orient', 'aiStep', { role: 'orient', title: 'Orient', tools: ['glob', 'read_file'], ...extra }),
   node('out', 'output')],
  [edge('in', 'orient'), edge('orient', 'out')]);

test('orient writes the context, the stance and a capped summary', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"home","scripts":{"test":"node --test"}}', 'README.md': '# Home' });
  const store = makeStore();
  let seenPrompt = '';
  setScript(({ system, prompt }) => {
    if (roleOf(system) === 'orient') { seenPrompt = prompt; return STANCE(); }
    return 'ok';
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flowWithOrient(), { userInput: 'learn from that repo', workspace: dir });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  // The seed reached the node, so it did not have to discover package.json.
  assert.match(seenPrompt, /WHAT IS ALREADY KNOWN ABOUT THIS WORKSPACE/);
  assert.match(seenPrompt, /scripts: test → node --test/);

  const context = store.readNodeOutput(runId, 'orient');
  assert.match(context, /## This project/);
  assert.ok(!context.includes('"relation"'), 'the context file a person reads is prose');

  const stance = JSON.parse(store.readNodeOutput(runId, 'orient.stance'));
  assert.equal(stance.relation, 'similar');
  assert.deepEqual(stance.focus, ['the scheduler']);
  assert.match(store.readNodeOutput(runId, 'orient.summary'), /Relation to the subject: similar/);
  const logged = store.readLog(runId).find(l => l.event === 'orientation');
  assert.equal(logged.relation, 'similar');
});

test('an unparseable stance degrades to "adjacent" rather than failing the run', async () => {
  const dir = tmpProject({ 'package.json': '{}' });
  const store = makeStore();
  setScript(({ system }) => roleOf(system) === 'orient' ? 'This project seems related, I think.' : 'ok');
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flowWithOrient(), { userInput: 'brief', workspace: dir });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const stance = JSON.parse(store.readNodeOutput(runId, 'orient.stance'));
  assert.equal(stance.relation, 'adjacent', 'the stance that assumes least');
  assert.equal(stance.confidence, 'low');
  assert.ok(store.readLog(runId).some(l => l.event === 'orientation_failed'));
  assert.match(store.readNodeOutput(runId, 'orient'), /related, I think/, 'the prose still stands as the context');
});

test('an empty workspace with no stated goal parks the run, once', async () => {
  const dir = tmpProject();
  const store = makeStore();
  const prompts = [];
  setScript(({ system, prompt }) => {
    if (roleOf(system) !== 'orient') return 'ok';
    prompts.push(prompt);
    // The one case that genuinely warrants asking: no evidence anywhere, and
    // everything downstream depends on the answer.
    return prompts.length === 1
      ? STANCE({ relation: 'empty', mission: 'find what is worth adopting wholesale.',
        questions: [{ id: 'what', text: 'What are you building here?', why: 'the workspace is empty' }] })
      : STANCE({ relation: 'empty', mission: 'find what is worth adopting for a task queue.' });
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flowWithOrient(), { userInput: 'learn from it', workspace: dir });

  await waitFor(() => store.readMeta(runId).stage === 'awaiting_input', { label: 'the input gate' });
  assert.match(store.readNodeOutput(runId, 'orient.questions'), /What are you building here\?/);
  runner.answerInput(runId, 'A task queue.');

  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done', store.readMeta(runId).error ?? '');
  assert.equal(prompts.length, 2, 'it ran again with the answer');
  assert.match(prompts[1], /USER ANSWERS TO YOUR CLARIFYING QUESTIONS[\s\S]*A task queue\./);
  assert.match(store.readNodeOutput(runId, 'orient.stance'), /task queue/);
});

test('an unattended run never parks: the questions become recorded assumptions', async () => {
  // A flow that can park forever is not usable from the loop, and the loop is
  // where these flows are meant to end up.
  const dir = tmpProject();
  const store = makeStore();
  let calls = 0;
  setScript(({ system }) => {
    if (roleOf(system) !== 'orient') return 'ok';
    calls += 1;
    return STANCE({ relation: 'empty', questions: [{ id: 'what', text: 'What are you building here?' }] });
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flowWithOrient(), { userInput: 'brief', workspace: dir, approvalMode: 'always' });
  assert.equal(await waitForStage(store, runId, ['done', 'failed', 'awaiting_input']), 'done',
    store.readMeta(runId).error ?? '');

  assert.equal(calls, 1, 'no gate, no re-run');
  const stance = JSON.parse(store.readNodeOutput(runId, 'orient.stance'));
  assert.ok(stance.assumptions.some(a => /^ASSUMED: What are you building here\?/.test(a)),
    'a fork taken blind is recorded as one');
  const logged = store.readLog(runId).find(l => l.event === 'orientation_assumed');
  assert.match(logged.reason, /unattended/);
});

test('the context file is written to the project, stamped, and left alone when fresh', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"home"}' });
  const store = makeStore();
  setScript(({ system }) => roleOf(system) === 'orient' ? STANCE() : 'ok');
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flowWithOrient(), { userInput: 'brief', workspace: dir });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const file = fs.readFileSync(path.join(dir, '.flyt', 'context.md'), 'utf8');
  assert.match(file, /^<!-- flyt-context: /, 'stamped, so the next run can judge it');
  assert.match(file, /## This project/);
  const stamp = readContextStamp(file);
  assert.equal(stamp.relation, 'similar');

  // A second run finds it fresh and leaves it exactly as it is.
  const second = runner.start(flowWithOrient(), { userInput: 'brief', workspace: dir });
  await waitForStage(store, second, ['done', 'failed']);
  assert.equal(fs.readFileSync(path.join(dir, '.flyt', 'context.md'), 'utf8'), file, 'untouched');
  assert.ok(store.readLog(second).some(l => l.event === 'context_file_kept' && /fresh/.test(l.reason)));
  // And it seeds the next orientation, so that run is a confirm rather than a survey.
  assert.match(homeSeed(new Workspace(dir)), /EXISTING CONTEXT FILE/);
});

test('a hand-edited context file is never overwritten — the divergence is reported', async () => {
  // Silently rewriting a file the user edited is the one way this feature
  // becomes something people turn off.
  const dir = tmpProject({ 'package.json': '{"name":"home"}' });
  fs.mkdirSync(path.join(dir, '.flyt'), { recursive: true });
  const mine = '# Context\n\nI wrote this myself and I mean it.';
  fs.writeFileSync(path.join(dir, '.flyt', 'context.md'), mine, 'utf8');

  const store = makeStore();
  setScript(({ system }) => roleOf(system) === 'orient' ? STANCE() : 'ok');
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flowWithOrient(), { userInput: 'brief', workspace: dir });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  assert.equal(fs.readFileSync(path.join(dir, '.flyt', 'context.md'), 'utf8'), mine, 'left exactly alone');
  assert.ok(store.readLog(runId).some(l => l.event === 'context_file_kept'));
  const divergence = store.readNodeOutput(runId, 'orient.divergence');
  assert.match(divergence, /was left alone/);
  assert.match(divergence, /## This project/, 'what it would have said is still offered');
});

test('an unattended run does not edit the project at all', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"home"}' });
  const store = makeStore();
  setScript(({ system }) => roleOf(system) === 'orient' ? STANCE() : 'ok');
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flowWithOrient(), { userInput: 'brief', workspace: dir, approvalMode: 'always' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');
  assert.equal(fs.existsSync(path.join(dir, '.flyt', 'context.md')), false);
  assert.ok(store.readLog(runId).some(l => l.event === 'context_file_skipped' && /unattended/.test(l.reason)));
  assert.ok(store.readNodeOutput(runId, 'orient'), 'the run-folder copy is always written');
});

test('the fan-out inherits the mission it was handed instead of inventing one', async () => {
  // The planner used to derive mission/focus/ignore from the prompt alone. A
  // node that read BOTH repositories has better evidence, so the planner's job
  // narrows to choosing a roster.
  const dir = tmpProject({ 'package.json': '{"name":"home"}' });
  const store = makeStore();
  const laneSystems = [];
  setScript(call => {
    const role = roleOf(call.system);
    if (role === 'orient') return STANCE();
    if (role === 'subject-peek') return 'A small JS repo.';
    if (role === 'lane-planner') {
      // The planner tries to substitute its own mission and its own focus.
      return '```json\n' + JSON.stringify({
        mission: 'read the repository and summarise it.',
        subject: 'the repository', focus: ['everything'], ignore: [],
        lanes: [
          { preset: 'architecture', id: 'arch', label: 'Arch', intent: 'shape' },
          { preset: 'adversarial', id: 'attack', label: 'Attack', intent: 'breaks' }
        ]
      }) + '\n```';
    }
    laneSystems.push(call.system);
    return 'findings';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('orient', 'aiStep', { role: 'orient', title: 'Orient', tools: ['glob', 'read_file'] }),
     node('fan', 'fanout', {
       title: 'Read it', goal: 'Read it.', plan: 'auto', tools: ['read_file'], lanes: ['standard', 'wildcard']
     }),
     node('out', 'output')],
    [edge('in', 'orient'), edge('in', 'fan'),
     { id: 'e-orient-fan', source: 'orient', target: 'fan', sourceHandle: 'summary' },
     edge('fan', 'out')]);
  const runner = new FlowRunner(store, testConfig({
    activeModels: [{ id: 'm/one', enabled: true }, { id: 'm/two', enabled: true }],
    resolveModelSource: model => ({ provider: 'script', model, apiKey: null })
  }));
  const runId = runner.start(flow, { userInput: 'brief', workspace: dir });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  assert.equal(laneSystems.length, 2);
  for (const s of laneSystems) {
    assert.match(s, /find where they solved our scheduling problem better than we did\./,
      'the orientation\'s mission, not the planner\'s');
    assert.match(s, /TREAT AS CENTRAL:\n- the scheduler/);
    assert.match(s, /LOW PRIORITY[\s\S]*- their CSS/);
    assert.ok(!s.includes('read the repository and summarise it.'));
  }
  const brief = store.readNodeOutput(runId, 'fan.brief');
  assert.match(brief, /\*\*Relation to this project\*\* — similar/);
  const planned = store.readLog(runId).find(l => l.event === 'fanout_planned');
  assert.equal(planned.inheritedFrom, 'orient');
});

test('lanes pointed at a subject are told how to address it', async () => {
  const store = makeStore();
  const laneSystems = [];
  setScript(call => {
    if (roleOf(call.system) === 'subject-peek') return 'shape';
    laneSystems.push(call.system);
    return 'findings';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('fan', 'fanout', {
       title: 'Read it', goal: 'Read it.', tools: ['read_file'],
       // Stamped by materializeInputs when a repo input feeds the node.
       subjectRepo: 'their-repo',
       system: 'PREAMBLE-BY-HAND.', lanes: ['standard', 'wildcard']
     }),
     node('out', 'output')],
    [edge('in', 'fan'), edge('fan', 'out')]);
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flow, { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  // An author-written preamble is not the generated one, so the addressing
  // block does not apply here — this asserts the lanes still inherit the
  // subject stamp, which is what scopes their tools.
  const f = store.readFlow(runId);
  for (const id of ['fan-standard', 'fan-wildcard']) {
    assert.equal(f.nodes.find(n => n.id === id).data.subjectRepo, 'their-repo');
  }
});

test('the generated preamble carries the addressing block, and only with a subject', () => {
  const withSubject = sharedPreamble({ mission: 'read it.', subject: 'the repository', count: 2, subjectRepo: 'their-repo' });
  assert.match(withSubject, /THE SUBJECT IS NOT THIS PROJECT/);
  assert.match(withSubject, /reference:their-repo/);
  assert.match(withSubject, /reads THIS PROJECT, not the subject/);
  assert.match(withSubject, /not evidence for anything you were asked/,
    'the failure mode is what makes a model catch its own slip');

  const without = sharedPreamble({ mission: 'read it.', subject: 'the document', count: 2 });
  assert.ok(!without.includes('THE SUBJECT IS NOT THIS PROJECT'),
    'a fan-out over a document has no reference to mis-address');
});

test('search_references scopes itself to the subject, and "*" opts out', async () => {
  const searched = [];
  const references = {
    catalog: () => [{ name: 'their-repo', cloned: true, about: '' }, { name: 'opencode', cloned: true, about: '' }],
    search: (pattern, opts) => { searched.push(opts.repo); return { results: [], truncated: false }; }
  };
  const ctx = { references, subject: { repo: 'their-repo', strict: true } };
  const scoped = await executeTool('search_references', { pattern: 'retry' }, ctx);
  assert.equal(searched[0], 'their-repo', 'a shared library searched unscoped returns other people\'s repositories');
  assert.match(scoped.result.note, /Scoped to the subject repository "their-repo"/);

  await executeTool('search_references', { pattern: 'retry', repo: '*' }, ctx);
  assert.equal(searched[1], null, '"*" is how you opt out, deliberately');

  await executeTool('search_references', { pattern: 'retry', repo: 'opencode' }, ctx);
  assert.equal(searched[2], 'opencode', 'an explicit repo still wins');

  await executeTool('search_references', { pattern: 'retry' }, { references });
  assert.equal(searched[3], null, 'no subject, no scoping — every other flow is unchanged');
});

// --- attribution (D40) -------------------------------------------------------
//
// A tool call has to say WHICH node made it. The executor path always stamped
// its task; an aiStep's calls were logged with `node: undefined`, so a fan-out
// reading a repository through several lanes in parallel produced hundreds of
// interleaved anonymous entries and "what did this lane actually open" had no
// answer. Observed on a real run: 237 tool calls, none attributable, and the
// per-node diagnostics read every lane as having made none.
test('an aiStep tool call is attributed to the node that made it', async () => {
  const dir = tmpProject({ 'src/ours.js': 'export const ours = 1;' });
  const store = makeStore();
  let asked = false;
  setScript(() => {
    if (asked) return 'done';
    asked = true;
    return '```tool\n{"tool":"read_file","args":{"path":"src/ours.js"}}\n```';
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(orientFlow(), { userInput: 'brief', workspace: dir });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const call = store.readLog(runId).find(l => l.event === 'tool_call' && l.tool === 'read_file');
  assert.ok(call, 'the call happened');
  assert.equal(call.node, 'step', 'and it says which node made it');
});
