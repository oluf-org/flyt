// Template skills injected into execution (V1 task 10, core/skills.js).
// A skill is expertise the bound PROJECT supplies (.llmflow/skills/<name>.md);
// a template only names it, so the same template adapts per repo (D15, Q-D5).
// These tests prove the thing that was missing: attaching a skill measurably
// changes what the model is asked, and every hit and miss is in the audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlowRunner } from '../core/flowRunner.js';
import { Workspace } from '../core/workspace.js';
import { loadSkills, skillsSection, withSkillsSection, skillPath } from '../core/skills.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-skill-'));

// A workspace with the given skills written into .llmflow/skills/.
function wsWithSkills(skills = {}) {
  const ws = new Workspace(tmpDir()).ensure();
  for (const [name, content] of Object.entries(skills)) {
    const p = path.join(ws.root, skillPath(name));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return ws;
}

const readLog = (store, runId) =>
  fs.readFileSync(path.join(store.runDir(runId), 'log.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));

// --- loadSkills ---

test('loadSkills reads attached skills from the workspace', () => {
  const ws = wsWithSkills({ 'house-style': '# House style\n\nTabs, never spaces.' });
  const { found, missing } = loadSkills(ws, ['house-style']);
  assert.deepEqual(missing, []);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'house-style');
  assert.match(found[0].content, /Tabs, never spaces/);
});

test('loadSkills reports a missing file with a reason instead of throwing', () => {
  const ws = wsWithSkills({});
  const { found, missing } = loadSkills(ws, ['nope']);
  assert.deepEqual(found, []);
  assert.equal(missing.length, 1);
  assert.match(missing[0].reason, /no \.llmflow\/skills\/nope\.md/);
});

test('loadSkills without a bound workspace reports why, rather than silently doing nothing', () => {
  const { found, missing } = loadSkills(null, ['house-style']);
  assert.deepEqual(found, []);
  assert.match(missing[0].reason, /no workspace bound/);
});

// Skill names come from templates and flow YAML (i.e. from users) and are
// interpolated into a path — they must not be able to reach out of .llmflow/.
test('loadSkills rejects names that try to escape the skills directory', () => {
  const ws = wsWithSkills({});
  fs.writeFileSync(path.join(ws.root, 'secret.md'), 'do not read me', 'utf8');
  for (const evil of ['../../secret', '../secret', 'a/b', 'a\\b', '..', 'x\0y']) {
    const { found, missing } = loadSkills(ws, [evil]);
    assert.deepEqual(found, [], `"${evil}" must not resolve`);
    assert.match(missing[0].reason, /invalid skill name/);
  }
});

test('loadSkills skips blank names and handles an empty list', () => {
  const ws = wsWithSkills({});
  assert.deepEqual(loadSkills(ws, ['', '   ']), { found: [], missing: [] });
  assert.deepEqual(loadSkills(ws, []), { found: [], missing: [] });
  assert.deepEqual(loadSkills(ws, undefined), { found: [], missing: [] });
});

test('an empty skill file counts as missing, not as silent success', () => {
  const ws = wsWithSkills({ blank: '   \n  ' });
  const { found, missing } = loadSkills(ws, ['blank']);
  assert.deepEqual(found, []);
  assert.equal(missing.length, 1);
});

// --- prompt assembly ---

test('withSkillsSection leaves a prompt untouched when nothing resolved', () => {
  assert.equal(withSkillsSection('ROLE: executor', []), 'ROLE: executor');
  assert.equal(skillsSection([]), '');
});

test('skillsSection labels each skill by name', () => {
  const s = skillsSection([{ name: 'a', content: 'AAA' }, { name: 'b', content: 'BBB' }]);
  assert.match(s, /--- skill: a ---\nAAA/);
  assert.match(s, /--- skill: b ---\nBBB/);
});

// --- execution: the gap task 10 exists to close ---

test('an aiStep template skill reaches the model and is logged', async () => {
  const store = makeStore();
  const ws = wsWithSkills({ 'house-style': 'Always open with the words BLUE HERON.' });
  const runner = new FlowRunner(store, testConfig());
  let sawSystem = null;
  setScript(({ system }) => { sawSystem = system; return 'done'; });

  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute', skills: ['house-style'] }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner.start(flow, { workspace: ws.root });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  // Measurably different execution: the project's expertise is in the prompt.
  assert.match(sawSystem, /BLUE HERON/);
  assert.match(sawSystem, /--- skill: house-style ---/);
  assert.match(sawSystem, /ROLE: executor/); // appended to the base prompt, not replacing it

  const log = readLog(store, runId);
  assert.deepEqual(log.find(e => e.event === 'skills_injected')?.skills, ['house-style']);
});

test('a node with no skills leaves the prompt exactly as it was', async () => {
  const store = makeStore();
  const ws = wsWithSkills({ 'house-style': 'BLUE HERON' });
  const runner = new FlowRunner(store, testConfig());
  let sawSystem = null;
  setScript(({ system }) => { sawSystem = system; return 'done'; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }), node('step', 'aiStep', { role: 'execute' }), node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner.start(flow, { workspace: ws.root });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.doesNotMatch(sawSystem, /SKILLS/);
  assert.doesNotMatch(sawSystem, /BLUE HERON/);
});

// The executor runs from tasks.json alone and never sees the node, so the skill
// has to ride on the task the way tools and the approval gate do.
test('an agentTask template skill rides the task to the executor', async () => {
  const store = makeStore();
  const ws = wsWithSkills({ 'test-style': 'Name every test after the bug it prevents.' });
  const runner = new FlowRunner(store, testConfig());
  let sawSystem = null;
  setScript(({ system }) => { sawSystem = system; return 'Task complete.'; });

  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('work', 'agentTask', { title: 'Write tests', goal: 'Write tests.', skills: ['test-style'] }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'out')]);
  const runId = runner.start(flow, { workspace: ws.root });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  assert.deepEqual(store.readTasks(runId).tasks[0].skills, ['test-style'],
    'the task must carry the skill: the executor never sees the node');
  assert.match(sawSystem, /Name every test after the bug it prevents/);
  const log = readLog(store, runId);
  assert.equal(log.find(e => e.event === 'skills_injected')?.node, 'executor:task-1');
});

test('an attached skill the project does not define is logged, and the run continues', async () => {
  const store = makeStore();
  const ws = wsWithSkills({});
  const runner = new FlowRunner(store, testConfig());
  setScript(() => 'done');
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute', skills: ['absent'] }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner.start(flow, { workspace: ws.root });
  // A skill that isn't there is not fatal — the node just runs without it.
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  const miss = readLog(store, runId).find(e => e.event === 'skill_missing');
  assert.equal(miss.skill, 'absent');
  assert.equal(miss.node, 'step');
  assert.match(miss.reason, /no \.llmflow\/skills\/absent\.md/);
});

// The same flow, run against two projects, must behave differently — that
// indirection is the entire point of naming skills instead of inlining them.
test('the same template picks up whichever project it is bound to', async () => {
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute', skills: ['house-style'] }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);

  const seen = [];
  setScript(({ system }) => { seen.push(system); return 'done'; });

  for (const marker of ['PROJECT ALPHA RULES', 'PROJECT BETA RULES']) {
    const store = makeStore();
    const r = new FlowRunner(store, testConfig());
    const ws = wsWithSkills({ 'house-style': marker });
    const runId = r.start(flow, { workspace: ws.root });
    assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  }
  assert.ok(seen.some(s => s.includes('PROJECT ALPHA RULES')));
  assert.ok(seen.some(s => s.includes('PROJECT BETA RULES')));
  // Never both in one prompt: each run sees only its own project's expertise.
  assert.ok(!seen.some(s => s.includes('ALPHA') && s.includes('BETA')));
});

// --- contextSpec must read the BOUND PROJECT (V1 task 12) ---

// A planner declaring "Context files: src/types.ts" means the file in the repo
// the run is pointed at. Resolution used to consult only runs/<id>/workspace/,
// so every contextSpec naming a real project file came back [NOT FOUND] — the
// minimal-context mechanism could not see the project it was aimed at.
test('an aiStep contextSpec reads the file out of the bound project', async () => {
  const store = makeStore();
  const ws = new Workspace(tmpDir()).ensure();
  fs.mkdirSync(path.join(ws.root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws.root, 'src', 'types.ts'), 'export interface AppConfig { PORT: number }', 'utf8');

  const runner = new FlowRunner(store, testConfig());
  let sawPrompt = null;
  setScript(({ prompt }) => { sawPrompt = prompt; return 'done'; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', {
       role: 'execute',
       contextSpec: { files: [{ path: 'src/types.ts', description: 'the config interface' }] }
     }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner.start(flow, { workspace: ws.root });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  assert.match(sawPrompt, /interface AppConfig/, 'the project file must reach the model');
  assert.doesNotMatch(sawPrompt, /NOT FOUND/);
});

test('a contextSpec path that escapes the project is not resolved', async () => {
  const store = makeStore();
  const ws = new Workspace(tmpDir()).ensure();
  const secret = path.join(ws.root, '..', 'outside-secret.txt');
  fs.writeFileSync(secret, 'TOP SECRET', 'utf8');
  try {
    const runner = new FlowRunner(store, testConfig());
    let sawPrompt = null;
    setScript(({ prompt }) => { sawPrompt = prompt; return 'done'; });
    const flow = makeFlow(
      [node('in', 'input', { text: 'b' }),
       node('step', 'aiStep', { role: 'execute', contextSpec: { files: [{ path: '../outside-secret.txt' }] } }),
       node('out', 'output')],
      [edge('in', 'step'), edge('step', 'out')]);
    const runId = runner.start(flow, { workspace: ws.root });
    assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
    assert.doesNotMatch(sawPrompt, /TOP SECRET/, 'confinement must hold for context reads too');
    assert.match(sawPrompt, /NOT FOUND/);
  } finally { fs.rmSync(secret, { force: true }); }
});

// The executor resolves a task's declared inputs the same way, and had the same
// blind spot — it only ever consulted the run sandbox.
test('an agentTask declared input reads the file out of the bound project', async () => {
  const store = makeStore();
  const ws = new Workspace(tmpDir()).ensure();
  fs.writeFileSync(path.join(ws.root, 'STYLE.md'), 'House rule: tabs, never spaces.', 'utf8');

  const runner = new FlowRunner(store, testConfig());
  let sawPrompt = null;
  setScript(({ prompt }) => { sawPrompt = prompt; return 'Task complete.'; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('work', 'agentTask', {
       title: 'W', goal: 'g',
       contextSpec: { files: [{ path: 'STYLE.md', description: 'house style' }] }
     }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'out')]);
  const runId = runner.start(flow, { workspace: ws.root });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.match(sawPrompt, /tabs, never spaces/);
});
