// Template skills injected into execution (V1 task 10, core/skills.js).
// A skill is expertise the bound PROJECT supplies (.flyt/skills/<name>.md);
// a template only names it, so the same template adapts per repo (D15, Q-D5).
// These tests prove the thing that was missing: attaching a skill measurably
// changes what the model is asked, and every hit and miss is in the audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlowRunner } from '../core/flowRunner.js';
import { runExecutorTask } from '../core/nodes/executor.js';
import { resolveTools } from '../core/tools/index.js';
import { Workspace } from '../core/workspace.js';
import {
  loadSkills, skillsSection, withSkillsSection, skillPath, listSkills, availableSkillsSection,
  resolveSkillToolRequests, missingSkillToolsSection
} from '../core/skills.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';
import { SEED_NODE_TEMPLATES, resolveInstance } from '../src/flowTypes.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-skill-'));

// A workspace with the given skills written into .flyt/skills/.
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
  assert.match(missing[0].reason, /no \.flyt\/skills\/nope\.md/);
});

test('loadSkills without a bound workspace reports why, rather than silently doing nothing', () => {
  const { found, missing } = loadSkills(null, ['house-style']);
  assert.deepEqual(found, []);
  assert.match(missing[0].reason, /no workspace bound/);
});

// Skill names come from templates and flow YAML (i.e. from users) and are
// interpolated into a path — they must not be able to reach out of .flyt/.
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

// --- D58 tool requests -------------------------------------------------------

test('requiresTools frontmatter is metadata, not injected instructions', () => {
  const ws = wsWithSkills({ research: '---\nrequiresTools: [read_file, web_search]\n---\n# Research\nCheck sources.' });
  const { found } = loadSkills(ws, ['research']);
  assert.deepEqual(found[0].requiresTools, ['read_file', 'web_search']);
  assert.doesNotMatch(found[0].content, /requiresTools/);
});

test('a human-granted skill request makes a tool reachable within the static ceiling', () => {
  const skill = [{ name: 'research', requiresTools: ['read_file'] }];
  const result = resolveSkillToolRequests(skill, {
    granted: ['read_file'], ceiling: ['read_file'], unattended: false, resolve: resolveTools
  });
  assert.deepEqual(result.tools.map(t => t.name), ['read_file']);
  assert.deepEqual(result.refused, []);
});

test('an ungranted request runs degraded with an artifact-ready visible notice', () => {
  const result = resolveSkillToolRequests([{ name: 'research', requiresTools: ['web_search'] }], {
    granted: [], ceiling: ['web_search'], unattended: false, resolve: resolveTools
  });
  assert.deepEqual(result.tools, []);
  assert.match(missingSkillToolsSection(result.ungranted), /research is missing tool web_search: not granted by a human/);
});

test('a Loop worker refuses a skill tool request unattended even if listed as granted', () => {
  const result = resolveSkillToolRequests([{ name: 'research', requiresTools: ['web_search'] }], {
    granted: ['web_search'], ceiling: ['web_search'], unattended: true, resolve: resolveTools
  });
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.ungranted, []);
  assert.match(result.refused[0].reason, /unattended workers cannot grant/);
});

test('a human grant cannot widen the block static ceiling', () => {
  const result = resolveSkillToolRequests([{ name: 'shell-help', requiresTools: ['bash'] }], {
    granted: ['bash'], ceiling: ['read_file'], unattended: false, resolve: resolveTools
  });
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.refused.map(r => r.tool), ['bash']);
  assert.deepEqual(result.ceiling, ['read_file']);
});

test('a granted missing tool still degrades visibly', () => {
  const result = resolveSkillToolRequests([{ name: 'research', requiresTools: ['vanished_tool'] }], {
    granted: ['vanished_tool'], ceiling: ['vanished_tool'], unattended: false, resolve: resolveTools
  });
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.missing, [{ tool: 'vanished_tool', reason: 'unknown', skill: 'research' }]);
});

test('template resolution preserves the human skill-tool grant', () => {
  const work = SEED_NODE_TEMPLATES.find(template => template.id === 'work');
  const resolved = resolveInstance({
    id: 'work', templateId: 'work', position: { x: 0, y: 0 },
    overrides: { skills: ['research'], skillToolGrants: ['read_file'] }
  }, work);
  assert.deepEqual(resolved.data.skillToolGrants, ['read_file']);
});

test('executor records an ungranted request in its prompt, artifact, log, and retrospective', async () => {
  const store = makeStore();
  const ws = wsWithSkills({ research: '---\nrequiresTools: [read_file]\n---\n# Research\nRead carefully.' });
  const runId = store.createRun('work without the requested tool');
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: ws.root });
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Research', goal: 'Research.', inputs: ['prompt.md'], constraints: [],
    tools: [], toolCeiling: ['read_file'], skills: ['research'], skillToolGrants: [],
    worker: { provider: 'script', model: 'test-model' }, status: 'pending'
  }] });
  let system = '';
  setScript(call => { system = call.system; return 'Completed with the stated limitation.'; });

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig(), { unattended: false });
  assert.equal(retro.status, 'success');
  assert.match(system, /SKILL TOOL REQUESTS NOT GRANTED/);
  assert.match(store.readTaskOutput(runId, 'task-1'), /Missing skill tools[\s\S]*research is missing tool read_file/);
  assert.ok(store.readLog(runId).some(event => event.event === 'skill_tool_missing'
    && event.tool === 'read_file' && /not granted by a human/.test(event.reason)));
  assert.ok(retro.problems.some(problem => /research[\s\S]*read_file[\s\S]*not granted by a human/.test(problem)));
});

test('a real Loop run refuses a skill grant even when the node carries it', async () => {
  const store = makeStore();
  const ws = wsWithSkills({ research: '---\nrequiresTools: [read_file]\n---\n# Research\nRead carefully.' });
  const runner = new FlowRunner(store, testConfig({ approvalMode: 'always' }));
  setScript(() => 'Loop work completed without the requested tool.');
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }), node('work', 'agentTask', {
      title: 'Loop work', goal: 'Do it.', tools: [], toolCeiling: ['read_file'],
      skills: ['research'], skillToolGrants: ['read_file']
    }), node('out', 'output')],
    [edge('in', 'work'), edge('work', 'out')]);

  const runId = runner.start(flow, {
    workspace: ws.root, approvalMode: 'always', loopTaskId: 't-loop'
  });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(store.readMeta(runId).attended, null, 'Loop does not promise a human listener');
  assert.deepEqual(store.readTasks(runId).tasks[0].skillToolGrants, ['read_file']);
  const refused = store.readLog(runId).find(event => event.event === 'skill_tool_refused');
  assert.equal(refused.tool, 'read_file');
  assert.match(refused.reason, /unattended workers cannot grant/);
  assert.match(store.readTaskOutput(runId, 'task-1'), /Missing skill tools[\s\S]*unattended workers cannot grant/);
  const retro = store.readRetrospectives(runId)['executor-task-1'];
  assert.ok(retro.problems.some(problem => /unattended workers cannot grant/.test(problem)));
});

test('executor defaults a persisted skill grant to refused without affirmative attendance', async () => {
  const store = makeStore();
  const ws = wsWithSkills({ research: '---\nrequiresTools: [read_file]\n---\n# Research\nRead carefully.' });
  const runId = store.createRun('no attendance context');
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: ws.root });
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Research', goal: 'Research.', inputs: ['prompt.md'], constraints: [],
    tools: [], toolCeiling: ['read_file'], skills: ['research'], skillToolGrants: ['read_file'],
    worker: { provider: 'script', model: 'test-model' }, status: 'pending'
  }] });
  setScript(() => 'Completed without implicit authority.');

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());
  const refused = store.readLog(runId).find(event => event.event === 'skill_tool_refused');
  assert.equal(refused.tool, 'read_file');
  assert.match(refused.reason, /unattended workers cannot grant/);
  assert.match(store.readTaskOutput(runId, 'task-1'), /Missing skill tools[\s\S]*unattended workers cannot grant/);
  assert.ok(retro.problems.some(problem => /unattended workers cannot grant/.test(problem)));
});

test('a requested tool already in the static grant produces no false missing diagnostics', async () => {
  const store = makeStore();
  const ws = wsWithSkills({ research: '---\nrequiresTools: [read_file]\n---\n# Research\nRead carefully.' });
  const runId = store.createRun('already statically granted');
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: ws.root });
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Research', goal: 'Research.', inputs: ['prompt.md'], constraints: [],
    tools: ['read_file'], toolCeiling: ['read_file'], skills: ['research'],
    worker: { provider: 'script', model: 'test-model' }, status: 'pending'
  }] });
  let system = '';
  setScript(call => { system = call.system; return 'Completed with the static tool.'; });

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());
  assert.doesNotMatch(system, /SKILL TOOL REQUESTS NOT GRANTED/);
  assert.doesNotMatch(store.readTaskOutput(runId, 'task-1'), /Missing skill tools/);
  assert.ok(!store.readLog(runId).some(event => event.event.startsWith('skill_tool_')));
  assert.ok(!retro.problems.some(problem => /requested tool/.test(problem)));
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
  assert.match(miss.reason, /no \.flyt\/skills\/absent\.md/);
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

// --- run-level skills (core/backlog.js `skills`) -----------------------------
//
// A skill on a TEMPLATE says "work of this kind is always done this way". A
// skill on a TASK says "this particular job needs this knowledge", and that had
// nowhere to live: teaching one unattended task a convention meant attaching
// the skill to every task the loop runs, so nobody did.

test('a run started with skills attaches them to every node that can hold one', async () => {
  const store = makeStore();
  const ws = wsWithSkills({ 'house-rules': 'House rule: tabs, never spaces.' });
  const runner = new FlowRunner(store, testConfig());
  let sawSystem = null;
  setScript(({ system }) => { sawSystem = system; return 'done'; });

  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute' }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner.start(flow, { workspace: ws.root, skills: ['house-rules'] });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  assert.match(sawSystem, /tabs, never spaces/, 'the task said its worker needs this and it never arrived');
  // The resolved flow is the run's self-describing artifact: what was attached
  // has to be visible there, or two runs cannot be told apart afterwards.
  const resolved = JSON.parse(fs.readFileSync(path.join(store.runDir(runId), 'flow.json'), 'utf8'));
  assert.deepEqual(resolved.nodes.find(n => n.id === 'step').data.skills, ['house-rules']);
});

test('run-level skills are a union with the node\'s own, never a replacement', async () => {
  const store = makeStore();
  const ws = wsWithSkills({
    'house-rules': 'House rule: tabs, never spaces.',
    'from-template': 'Template rule: cite the file you read.'
  });
  const runner = new FlowRunner(store, testConfig());
  let sawSystem = null;
  setScript(({ system }) => { sawSystem = system; return 'done'; });

  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute', skills: ['from-template'] }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner.start(flow, { workspace: ws.root, skills: ['house-rules', 'from-template'] });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  assert.match(sawSystem, /tabs, never spaces/);
  assert.match(sawSystem, /cite the file you read/, 'the template author\'s decision must survive');
  const resolved = JSON.parse(fs.readFileSync(path.join(store.runDir(runId), 'flow.json'), 'utf8'));
  assert.deepEqual(resolved.nodes.find(n => n.id === 'step').data.skills, ['from-template', 'house-rules'],
    'declared first, added second, and no duplicates');
});

// --- the planner's menu ------------------------------------------------------
//
// A planner told to name the skills a future worker needs, but not shown which
// skills exist, has two ways to fail and both are silent: name none, or invent
// a slug that resolves to nothing at run time.

test('listSkills reports what the project has, with a one-line summary', () => {
  const ws = wsWithSkills({
    'tool-authoring': '# Authoring a Flyt tool\n\nUse this when...',
    'house-style': '---\nrequiresTools: [read_file]\n---\nTabs, never spaces.',
    'not-a-skill.txt': 'ignored'
  });
  const found = listSkills(ws);
  assert.deepEqual(found.map(s => s.name), ['house-style', 'tool-authoring'], 'alphabetical, .md only');
  assert.equal(found.find(s => s.name === 'tool-authoring').summary, 'Authoring a Flyt tool',
    'the heading is the summary, without its hashes');
  assert.deepEqual(found.find(s => s.name === 'house-style').requiresTools, ['read_file'],
    'the library makes a skill\'s tool request visible before attachment');
});

test('a project with no skills directory has no skills, which is not an error', () => {
  const ws = new Workspace(tmpDir()).ensure();
  assert.deepEqual(listSkills(ws), []);
  assert.equal(listSkills(null).length, 0);
  assert.equal(availableSkillsSection([]), '', 'nothing to show adds nothing to the prompt');
});

test('the menu tells the planner not to invent a name', () => {
  const section = availableSkillsSection([{
    name: 'house-style', summary: 'Tabs, never spaces.', requiresTools: ['read_file']
  }]);
  assert.match(section, /- house-style — Tabs, never spaces\./);
  assert.match(section, /requests tools: read_file/);
  assert.match(section, /do not invent one/i);
});
