// Fan-out lanes (DECISIONS.md D36): lane normalization and the
// cross-lane brief as pure functions, then the node end to end — lanes
// materialized inside the box, run in parallel, aggregated per lane, with
// each lane told who its siblings are and none of them told what the others
// produced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner } from '../core/flowRunner.js';
import {
  normalizeLane, normalizeLaneWorker, resolveLanes, laneBrief, laneInventory,
  sharedPreamble, applyPreamble, assignWorkers, renderBrief,
  LANE_PRESETS, LANE_PRESET_IDS, DEFAULT_LANE_TEMPLATE
} from '../core/nodes/fanout.js';
import { makeStore, setScript, roleOf, testConfig, waitFor, waitForStage, makeFlow, node, edge } from './helpers.js';

// --- lane normalization -----------------------------------------------------

test('a lane worker may be a plain model id or the {provider, model} object', () => {
  assert.deepEqual(normalizeLaneWorker('anthropic/claude-sonnet-5'), { provider: 'auto', model: 'anthropic/claude-sonnet-5' });
  assert.deepEqual(normalizeLaneWorker('mock-large'), { provider: 'mock', model: 'mock-large' });
  assert.deepEqual(normalizeLaneWorker({ provider: 'openrouter', model: 'x/y' }), { provider: 'openrouter', model: 'x/y' });
  assert.equal(normalizeLaneWorker(''), null);
  assert.equal(normalizeLaneWorker(null), null);
  assert.equal(normalizeLaneWorker({ provider: 'openai' }), null, 'a worker with no model is not a worker');
});

test('a bare string lane is shorthand for that preset', () => {
  const lane = normalizeLane('wildcard');
  assert.equal(lane.id, 'wildcard');
  assert.equal(lane.label, LANE_PRESETS.wildcard.label);
  assert.equal(lane.instructions, LANE_PRESETS.wildcard.instructions);
  assert.equal(lane.intent, LANE_PRESETS.wildcard.intent);
});

test('a preset and the author\'s own instructions compose, preset first', () => {
  const lane = normalizeLane({ preset: 'adversarial', instructions: 'Focus on the auth module.', label: 'Attack' });
  assert.ok(lane.instructions.startsWith(LANE_PRESETS.adversarial.instructions));
  assert.ok(lane.instructions.endsWith('Focus on the auth module.'));
  assert.equal(lane.label, 'Attack', 'an explicit label wins over the preset\'s');
});

test('a lane with no id gets one from its label, then its preset, then its position', () => {
  assert.equal(normalizeLane({ label: 'The Architecture Read' }).id, 'the-architecture-read');
  assert.equal(normalizeLane({ preset: 'contrarian' }).id, 'contrarian');
  assert.equal(normalizeLane({}, 3).id, 'lane-4');
});

// --- the two prompt layers (DECISIONS.md D37) --------------------------------------

test('a preset carries a role prompt as well as instructions, and they compose preset-first', () => {
  const lane = normalizeLane({ preset: 'architecture', system: 'Also name the build system.' });
  assert.ok(lane.system.startsWith(LANE_PRESETS.architecture.system));
  assert.ok(lane.system.endsWith('Also name the build system.'));
  // The two layers are separate: the role prompt does not leak into the
  // user-message instructions or vice versa.
  assert.ok(!lane.instructions.includes('ROLE: architecture reader'));
  assert.match(lane.system, /^ROLE: architecture reader/);
});

test('the fifth preset exists, so the planner can actually select it', () => {
  // learn-from-repo hand-wrote this as `standard` plus an intent string, which
  // put it permanently out of the planner's reach: it picks from the enum.
  assert.deepEqual(LANE_PRESET_IDS, ['standard', 'architecture', 'wildcard', 'adversarial', 'contrarian']);
  for (const id of LANE_PRESET_IDS) {
    assert.ok(LANE_PRESETS[id].system?.trim(), `${id} has a role prompt`);
    assert.match(LANE_PRESETS[id].system, /^ROLE: /, `${id} declares its role`);
    assert.ok(LANE_PRESETS[id].system.includes('Output:'), `${id} owns its output shape`);
  }
});

test('a lane with no preset and no system of its own carries none at all', () => {
  // The no-regression case: no data.system means the child still falls through
  // to DEFAULT_SYSTEM[role], exactly as every fan-out did before this existed.
  const bare = normalizeLane({ id: 'a', label: 'A' });
  assert.ok(!('system' in bare));
  assert.ok(!('emphasis' in bare));
});

test('emphasis narrows a lane inside its preset, capped at one sentence\'s worth', () => {
  const lane = normalizeLane({ preset: 'adversarial', emphasis: 'Concentrate on the retry path.' });
  assert.ok(lane.system.endsWith('THIS LANE SPECIFICALLY: Concentrate on the retry path.'));
  assert.ok(lane.system.startsWith(LANE_PRESETS.adversarial.system), 'the preset still owns the method');

  const long = normalizeLane({ preset: 'standard', emphasis: 'x'.repeat(400) });
  assert.equal(long.emphasis.length, 280, 'a paragraph here is lane authoring by the back door');
});

test('the shared preamble omits both optional blocks when it has nothing to say', () => {
  const bare = sharedPreamble({ mission: 'explain how it retries.', subject: 'the repository', count: 3 });
  assert.match(bare, /You are one of 3 agents reading the repository in parallel/);
  assert.match(bare, /Your shared goal is to explain how it retries\./);
  assert.ok(!bare.includes('TREAT AS CENTRAL'), 'a "FOCUS: none in particular" line is worse than silence');
  assert.ok(!bare.includes('LOW PRIORITY'));

  const full = sharedPreamble({
    mission: 'explain how it retries.', subject: 'the repository', count: 2,
    focus: ['the retry path'], ignore: ['code style']
  });
  assert.match(full, /TREAT AS CENTRAL:\n- the retry path/);
  assert.match(full, /LOW PRIORITY[\s\S]*- code style/);
});

test('ignore reaches the lane as advice, never as a prohibition (§1.2)', () => {
  // "Don't focus on X" is a statement about attention, not about relevance. A
  // user who says "ignore syntax errors" still wants to hear it when a syntax
  // error is why the build is broken — so the escape clause is load-bearing
  // wording, not filler, and must not be softened into a flat ban.
  const p = sharedPreamble({ mission: 'read it.', subject: 'the repo', count: 2, ignore: ['test coverage'] });
  assert.match(p, /unless it is load-bearing for something they did ask for/);
  assert.ok(!/\bnever mention\b|\bdo not report\b|\bexclude\b/i.test(p));
});

test('the preamble is prepended to every lane, and does not replace the preset', () => {
  const lanes = applyPreamble(
    [normalizeLane('standard'), normalizeLane({ id: 'plain', label: 'Plain' })],
    'PREAMBLE-MARKER');
  assert.ok(lanes[0].system.startsWith('PREAMBLE-MARKER'));
  assert.ok(lanes[0].system.includes('ROLE: primary reader'), 'mission and scope first, then method and shape');
  assert.equal(lanes[1].system, 'PREAMBLE-MARKER', 'a lane with no role prompt still gets the mission');
});

// --- staffing the roster (DECISIONS.md D37) ----------------------------------------

const POOL = ['m/one', 'm/two', 'm/three'];

test('two lanes of the same preset never share a model', () => {
  const roster = [
    normalizeLane({ preset: 'architecture', id: 'a1' }),
    normalizeLane({ preset: 'architecture', id: 'a2' }),
    normalizeLane({ preset: 'wildcard', id: 'w' })
  ];
  const { lanes, dropped } = assignWorkers(roster, POOL);
  assert.equal(dropped.length, 0);
  assert.notEqual(lanes[0].worker.model, lanes[1].worker.model);
  // Different presets may share freely — the preset is doing the diverging.
  assert.equal(lanes[2].worker.model, 'm/one');
});

test('a lane that names its own model keeps it, even against another of its preset', () => {
  const roster = [
    normalizeLane({ preset: 'adversarial', id: 'a1', worker: 'm/one' }),
    normalizeLane({ preset: 'adversarial', id: 'a2', worker: 'm/one' })
  ];
  const { lanes, dropped } = assignWorkers(roster, POOL);
  assert.equal(dropped.length, 0, 'the author asked for it');
  assert.deepEqual(lanes.map(l => l.worker.model), ['m/one', 'm/one']);
});

test('an exhausted pool truncates the roster and reports every drop', () => {
  // Three correlated reads sold as coverage is precisely the failure this node
  // exists to prevent, so shipping them silently is worse than two lanes.
  const roster = ['a1', 'a2', 'a3'].map(id => normalizeLane({ preset: 'contrarian', id }));
  const { lanes, dropped } = assignWorkers(roster, ['m/one', 'm/two']);
  assert.deepEqual(lanes.map(l => l.id), ['a1', 'a2']);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'a3');
  assert.equal(dropped[0].preset, 'contrarian');
  assert.match(dropped[0].reason, /already running a "contrarian" lane/);
});

test('assignWorkers is deterministic', () => {
  const roster = () => ['a1', 'a2', 'w'].map((id, i) =>
    normalizeLane({ preset: i === 2 ? 'wildcard' : 'standard', id }));
  const first = assignWorkers(roster(), POOL);
  const second = assignWorkers(roster(), POOL);
  assert.deepEqual(first.lanes.map(l => l.worker.model), second.lanes.map(l => l.worker.model));
});

test('a lane with no preset is unconstrained — it has no fixed role to correlate with', () => {
  const roster = ['a', 'b'].map(id => normalizeLane({ id }));
  const { lanes, dropped } = assignWorkers(roster, ['m/one']);
  assert.equal(dropped.length, 0);
  assert.deepEqual(lanes.map(l => l.worker.model), ['m/one', 'm/one']);
});

test('the brief reads as prose, and a fallback roster says so', () => {
  const plan = {
    mission: 'explain how it retries.', subject: 'the repository',
    focus: ['the retry path'], ignore: ['style'],
    lanes: [{ ...normalizeLane({ preset: 'architecture', id: 'a', label: 'Arch' }), reason: 'the brief is structural' }]
  };
  const md = renderBrief(plan);
  assert.match(md, /# Why these lanes/);
  assert.match(md, /\*\*Mission\*\* — explain how it retries\./);
  assert.match(md, /### Arch — `architecture`/);
  assert.match(md, /Why it exists:\*\* the brief is structural/);
  assert.ok(!md.includes('"preset"'), 'the artifact a user opens is prose, not the contract JSON');

  const fell = renderBrief(plan, { fallback: true, reason: 'the planning call failed' });
  assert.match(fell, /AUTHORED fallback[\s\S]*the planning call failed/);
});

// --- lanes from a model set (P2.4) ------------------------------------------

const SETS = { analysts: { name: 'Analysts', models: ['a/one', 'b/two', 'c/three'] } };

test('a model set mints one lane per member', () => {
  const lanes = resolveLanes({ data: { modelSet: 'analysts' } }, { modelSets: SETS });
  assert.deepEqual(lanes.map(l => l.worker.model), ['a/one', 'b/two', 'c/three']);
  assert.deepEqual(lanes.map(l => l.id), ['a-one', 'b-two', 'c-three']);
  assert.match(lanes[0].intent, /answered by a\/one/, 'siblings are told what makes this lane different');
});

test('a set member that is no longer active does not become a lane', () => {
  const lanes = resolveLanes({ data: { modelSet: 'analysts' } }, {
    modelSets: SETS,
    activeModels: [{ id: 'a/one', enabled: true }, { id: 'b/two', enabled: false }]
  });
  assert.deepEqual(lanes.map(l => l.worker.model), ['a/one'],
    'a lane that cannot run is worse than one fewer lane');
});

test('a set can carry a preset, and authored lanes come first', () => {
  const lanes = resolveLanes({
    data: { lanes: [{ id: 'hand', label: 'Hand-written' }], modelSet: 'analysts', modelSetPreset: 'wildcard' }
  }, { modelSets: SETS });
  assert.equal(lanes[0].id, 'hand');
  assert.equal(lanes.length, 4);
  assert.equal(lanes[1].instructions, LANE_PRESETS.wildcard.instructions);
});

test('colliding lane ids are suffixed, never dropped', () => {
  const lanes = resolveLanes({ data: { lanes: [{ id: 'a-one' }], modelSet: 'analysts' } }, { modelSets: SETS });
  assert.deepEqual(lanes.map(l => l.id), ['a-one', 'a-one-2', 'b-two', 'c-three']);
});

test('an unknown or empty model set yields no lanes rather than throwing', () => {
  assert.deepEqual(resolveLanes({ data: { modelSet: 'nope' } }, { modelSets: SETS }), []);
  assert.deepEqual(resolveLanes({ data: {} }, {}), []);
});

// --- the cross-lane brief (B6) ----------------------------------------------

test('a lane is told who its siblings are, and asked for what only it can reach', () => {
  const lanes = resolveLanes({
    data: { lanes: [{ id: 'arch', label: 'Architecture', intent: 'how it fits together' }, 'wildcard', 'adversarial'] }
  }, {});
  const brief = laneBrief(lanes[0], lanes, { goal: 'Read this repo.' });
  assert.match(brief, /SHARED GOAL/);
  assert.match(brief, /Read this repo\./);
  assert.match(brief, /YOUR LANE: Architecture — how it fits together/);
  assert.match(brief, /THE OTHER LANES WORKING THIS SAME BRIEF \(2\)/);
  assert.match(brief, /- Wildcard —/);
  assert.match(brief, /- Adversarial —/);
  assert.match(brief, /AT LEAST ONE finding that no other lane above is/);
  assert.ok(!brief.includes('- Architecture —'), 'a lane is not listed among its own siblings');
});

test('a single lane gets no sibling section', () => {
  const lanes = resolveLanes({ data: { lanes: ['standard'] } }, {});
  const brief = laneBrief(lanes[0], lanes, { goal: 'g' });
  assert.ok(!brief.includes('THE OTHER LANES'), 'there is nobody to diverge from');
});

test('the lane inventory names the model each lane ran on', () => {
  const lanes = resolveLanes({ data: { modelSet: 'analysts' } }, { modelSets: SETS });
  const inv = laneInventory(lanes);
  assert.match(inv, /3 lane\(s\)/);
  assert.match(inv, /· a\/one/);
});

// --- the node, end to end ---------------------------------------------------

function fanoutFlow(data) {
  return makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('fan', 'fanout', { title: 'Analysis', ...data }),
     node('out', 'output')],
    [edge('in', 'fan'), edge('fan', 'out')]);
}

test('a fan-out materializes one child per lane inside its box and aggregates per lane', async () => {
  const store = makeStore();
  const seen = [];
  setScript(({ prompt }) => {
    const lane = (prompt.match(/YOUR LANE: ([^\n—]+)/) ?? [])[1]?.trim() ?? '?';
    seen.push(lane);
    return `findings from ${lane}`;
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(fanoutFlow({
    goal: 'Read this repo.',
    lanes: [
      { id: 'arch', label: 'Architecture', intent: 'how it fits together', worker: { provider: 'script', model: 'test-model' } },
      'wildcard',
      'adversarial'
    ]
  }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'done');
  assert.equal(meta.nodeStatus.fan, 'done');
  for (const id of ['fan-arch', 'fan-wildcard', 'fan-adversarial']) {
    assert.equal(meta.nodeStatus[id], 'done', `${id} ran`);
  }
  assert.deepEqual(seen.sort(), ['Adversarial', 'Architecture', 'Wildcard']);

  const flow = store.readFlow(runId);
  const child = flow.nodes.find(n => n.id === 'fan-arch');
  assert.equal(child.parentId, 'fan');
  assert.equal(child.data.managedBy, 'fan');
  assert.equal(child.data.laneId, 'arch');
  assert.equal(child.data.requiresApproval, false, 'lanes run autonomously inside the box');
  const fan = flow.nodes.find(n => n.id === 'fan');
  assert.ok(fan.data.box?.w > 0 && fan.data.box?.h > 0, 'the box is sized to fit its lanes');

  // Lanes are independent by construction: wired to the container, to nothing
  // else, and never past it.
  assert.ok(flow.edges.some(e => e.source === 'fan' && e.target === 'fan-arch'));
  assert.ok(!flow.edges.some(e => e.source === 'fan-arch'), 'no lane feeds another, or anything downstream');

  const agg = store.readNodeOutput(runId, 'fan');
  assert.match(agg, /3 lane\(s\)/);
  assert.match(agg, /--- Architecture \(fan-arch\) ---/);
  assert.match(agg, /findings from Wildcard/);
  assert.match(store.readNodeOutput(runId, 'fan.lanes'), /Architecture \(arch\) · test-model/);
  assert.match(store.readNodeOutput(runId, 'out'), /findings from Adversarial/);
});

test('each lane is briefed on its siblings and sees none of their output', async () => {
  const store = makeStore();
  const prompts = [];
  setScript(({ prompt }) => {
    prompts.push(prompt);
    const lane = (prompt.match(/YOUR LANE: ([^\n—]+)/) ?? [])[1]?.trim() ?? '?';
    return `SECRET-OUTPUT-OF-${lane}`;
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(fanoutFlow({
    goal: 'Assess it.',
    lanes: ['standard', 'contrarian']
  }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');

  assert.equal(prompts.length, 2);
  for (const p of prompts) {
    assert.match(p, /THE OTHER LANES WORKING THIS SAME BRIEF \(1\)/);
    assert.ok(!p.includes('SECRET-OUTPUT-OF-'), 'lane outputs never cross — that would collapse the divergence');
  }
});

test('a fan-out from a model set runs one lane per active member', async () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new FlowRunner(store, testConfig({
    modelSets: { analysts: { name: 'Analysts', models: ['mock-large', 'mock-small', 'gone/model'] } },
    activeModels: [{ id: 'mock-large', enabled: true }, { id: 'mock-small', enabled: true }]
  }));
  const runId = runner.start(fanoutFlow({ goal: 'g', modelSet: 'analysts' }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'done');
  assert.equal(meta.nodeStatus['fan-mock-large'], 'done');
  assert.equal(meta.nodeStatus['fan-mock-small'], 'done');
  assert.ok(!('fan-gone-model' in meta.nodeStatus), 'an inactive member mints no lane');
});

test('a fan-out with no lanes is refused at the pre-run gate, not discovered mid-run', () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new FlowRunner(store, testConfig());
  // fanout-lanes is a RUNTIME_RULE: a container that cannot produce a single
  // child would wedge the run rather than degrade it, so start() refuses.
  assert.throws(() => runner.start(fanoutFlow({ goal: 'g' }), { userInput: 'brief' }),
    /fanout-lanes.*at least one lane/s);
});

test('a lane may name its own template; otherwise the node\'s, otherwise the default', async () => {
  const store = makeStore();
  const roles = new Map();
  setScript(({ system, prompt }) => {
    const lane = (prompt.match(/YOUR LANE: ([^\n—]+)/) ?? [])[1]?.trim() ?? '?';
    roles.set(lane, roleOf(system));
    return 'ok';
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(fanoutFlow({
    goal: 'g',
    template: 'work',
    lanes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', template: 'general-analysis' }]
  }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');
  // The template in play shows up as the role its system prompt declares.
  assert.equal(roles.get('A'), 'executor', 'the node\'s template applies where a lane names none');
  assert.equal(roles.get('B'), 'analyze', 'a lane\'s own template wins');
  assert.equal(DEFAULT_LANE_TEMPLATE, 'general-analysis');
});

// --- what a lane can actually see and do -----------------------------------

test("a lane receives the fan-out's upstream output, not just its goal", async () => {
  // Without this a fan-out only works when the whole brief fits in `goal`.
  // The moment the node UPSTREAM is the one that says what to read — which
  // repo, which document — a lane that cannot see it is analysing nothing.
  const store = makeStore();
  const prompts = [];
  setScript(({ prompt }) => { prompts.push(prompt); return 'UPSTREAM-PAYLOAD-42'; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('prep', 'aiStep', { role: 'execute', title: 'Prep', goal: 'prepare' }),
     node('fan', 'fanout', { title: 'Read it', goal: 'Read it.', lanes: ['standard', 'wildcard'] }),
     node('out', 'output')],
    [edge('in', 'prep'), edge('prep', 'fan'), edge('fan', 'out')]);
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flow, { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const lanePrompts = prompts.filter(p => p.includes('YOUR LANE'));
  assert.equal(lanePrompts.length, 2);
  for (const p of lanePrompts) {
    assert.match(p, /UPSTREAM-PAYLOAD-42/, 'every lane sees what fed the fan-out');
    assert.match(p, /--- Prep \(prep\) ---/, 'labelled by the node it came from');
  }
});

test('an edge into a fan-out keeps its port when it reaches the lanes', async () => {
  const store = makeStore();
  const prompts = [];
  setScript(({ system, prompt }) => {
    prompts.push(prompt);
    if (roleOf(system) === 'step-eval') {
      return 'The long report nobody wants.\n```json\n{ "verdict": "pass", "reason": "ok", "guidance": "" }\n```';
    }
    return 'work done';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('work', 'aiStep', { role: 'execute', title: 'Work' }),
     node('ev', 'aiStep', { role: 'step-eval', title: 'Eval' }),
     node('fan', 'fanout', { title: 'React', goal: 'React to the verdict.', lanes: ['standard'] }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'ev'),
     { id: 'e-ev-fan-verdict', source: 'ev', target: 'fan', sourceHandle: 'verdict' },
     edge('fan', 'out')]);
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flow, { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const lane = prompts.find(p => p.includes('YOUR LANE'));
  assert.match(lane, /"verdict": "pass"/, 'the chosen port reaches the lane');
  assert.ok(!lane.includes('The long report nobody wants'), 'and replaces the full output, as anywhere else');
});

test("lanes inherit the fan-out's tool grant when they declare none", async () => {
  const store = makeStore();
  setScript(() => 'ok');
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('fan', 'fanout', {
       title: 'Read it', goal: 'Read it.', tools: ['read_file'],
       lanes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', tools: ['search_references'] }]
     }),
     node('out', 'output')],
    [edge('in', 'fan'), edge('fan', 'out')]);
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flow, { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const f = store.readFlow(runId);
  // An aiStep gets NO tools without an explicit grant, so a lane that inherits
  // nothing cannot read the thing it was pointed at.
  assert.deepEqual(f.nodes.find(n => n.id === 'fan-a').data.tools, ['read_file'], 'inherited');
  assert.deepEqual(f.nodes.find(n => n.id === 'fan-b').data.tools, ['search_references'], 'its own wins');
});

test('a granted aiStep actually reaches its tools', async () => {
  // Regression: trackedRunAgent spread the worker flat while runAgent expects
  // it nested, so an aiStep with a read-only grant (DESIGN-SPEC.md §5) called
  // provider `undefined` and failed the node. Nothing exercised it until
  // fan-out lanes began inheriting a grant.
  const store = makeStore();
  let sawTools = null;
  setScript(({ system }) => {
    // The text tool protocol advertises the grant in the system prompt.
    sawTools = /read_file/.test(String(system));
    return 'done, no tool needed';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'analyze', title: 'Read', tools: ['read_file'] }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flow, { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');
  assert.equal(sawTools, true, 'the grant reached the model call');
});

// --- the lane planner, end to end (DECISIONS.md D37) -------------------------------
//
// The property under test throughout: the planner may CHOOSE and DUPLICATE
// presets, and nothing it says may change what a preset IS, or let two lanes of
// one preset run correlated on the same model.

const NEVER = () => new Promise(() => {});

// Three models the script provider can actually serve, so a planned roster has
// somewhere to staff same-preset lanes from.
const POOL_CONFIG = (over = {}) => testConfig({
  activeModels: [
    { id: 'm/one', enabled: true }, { id: 'm/two', enabled: true }, { id: 'm/three', enabled: true }
  ],
  resolveModelSource: model => ({ provider: 'script', model, apiKey: null }),
  ...over
});

const planJson = plan => '```json\n' + JSON.stringify(plan) + '\n```';
const laneNameOf = prompt => (prompt.match(/YOUR LANE: ([^\n—]+)/) ?? [])[1]?.trim() ?? '?';

// A script that answers the peek, the planner and the lanes distinctly.
function planningScript({ plan, onLane = () => {}, onPeek = () => {} }) {
  setScript(call => {
    const role = roleOf(call.system);
    if (role === 'subject-peek') { onPeek(call); return 'A small JavaScript repo, one package, tests under tests/.'; }
    if (role === 'lane-planner') return typeof plan === 'function' ? plan(call) : plan;
    onLane(call);
    return `findings from ${laneNameOf(call.prompt)}`;
  });
}

const planFlow = data => makeFlow(
  [node('in', 'input', { text: 'brief' }),
   node('fan', 'fanout', { title: 'Read it', goal: 'Read this repo.', ...data }),
   node('out', 'output')],
  [edge('in', 'fan'), edge('fan', 'out')]);

test('without "plan: auto" nothing peeks and nothing plans', async () => {
  // The whole feature is guarded by one key: every flow written before it
  // behaves exactly as it did.
  const store = makeStore();
  const roles = [];
  setScript(call => { roles.push(roleOf(call.system)); return 'ok'; });
  const runner = new FlowRunner(store, POOL_CONFIG());
  const runId = runner.start(planFlow({ lanes: ['standard', 'wildcard'] }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');

  assert.ok(!roles.includes('lane-planner'), 'no planning call');
  assert.ok(!roles.includes('subject-peek'), 'no peek');
  assert.ok(!store.readNodeOutput(runId, 'fan.brief'), 'no brief sidecar');
  assert.ok(!store.readNodeOutput(runId, 'fan.peek'), 'no peek sidecar');
  assert.ok(!store.readLog(runId).some(l => l.event === 'fanout_planned' || l.event === 'fanout_peek'));
});

test("a preset's role prompt reaches the lane, replacing the template's default", async () => {
  // P1.2: DEFAULT_SYSTEM.analyze otherwise imposes one report format on every
  // lane, which is the single biggest reason four lanes come back reading alike.
  const store = makeStore();
  const systems = new Map();
  setScript(call => { systems.set(roleOf(call.system), call.system); return 'ok'; });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(planFlow({ lanes: ['architecture', 'adversarial'] }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');

  assert.ok(systems.has('architecture'), 'the architecture lane runs its own role prompt');
  assert.ok(systems.has('adversarial'));
  assert.match(systems.get('architecture'), /## Load-bearing decisions/);
  assert.ok(!systems.has('analyze'), 'and not the generic analysis format');
});

test('a lane with no preset still falls through to its template role', async () => {
  const store = makeStore();
  const roles = [];
  setScript(call => { roles.push(roleOf(call.system)); return 'ok'; });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(planFlow({ lanes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');
  assert.deepEqual(roles, ['analyze', 'analyze'], 'the no-regression case');
});

test('a planned roster of three same-preset lanes runs on three different models', async () => {
  const store = makeStore();
  const laneModels = [];
  planningScript({
    plan: planJson({
      mission: 'explain how this repository is put together.',
      subject: 'the repository',
      focus: ['the architecture'],
      ignore: [],
      lanes: [
        { preset: 'architecture', id: 'arch-shape', label: 'Architecture — shape', intent: 'the parts', reason: 'they asked for architecture' },
        { preset: 'architecture', id: 'arch-data', label: 'Architecture — the data path', intent: 'what crosses', emphasis: 'Follow the data end to end.' },
        { preset: 'architecture', id: 'arch-edges', label: 'Architecture — the boundaries', intent: 'the seams' }
      ]
    }),
    onLane: call => laneModels.push(call.model)
  });
  const runner = new FlowRunner(store, POOL_CONFIG());
  const runId = runner.start(planFlow({
    plan: 'auto', maxLanes: 6, tools: ['read_file'], lanes: ['standard', 'wildcard']
  }), { userInput: 'Focus entirely on how it is put together.' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const meta = store.readMeta(runId);
  for (const id of ['fan-arch-shape', 'fan-arch-data', 'fan-arch-edges']) {
    assert.equal(meta.nodeStatus[id], 'done', `${id} ran`);
  }
  assert.ok(!('fan-standard' in meta.nodeStatus), 'the authored roster was replaced, not appended to');
  assert.equal(new Set(laneModels).size, 3,
    'three identical role prompts on one model is three correlated reads sold as coverage');

  const brief = store.readNodeOutput(runId, 'fan.brief');
  assert.match(brief, /# Why these lanes/);
  assert.match(brief, /Follow the data end to end\./);
  assert.match(brief, /they asked for architecture/);
  assert.ok(store.readNodeOutput(runId, 'fan.peek'), 'the peek is kept as its own artifact');
});

test('a roster larger than the pool is truncated, and every drop is logged', async () => {
  const store = makeStore();
  planningScript({
    plan: planJson({
      mission: 'find what breaks.', subject: 'the repository', focus: [], ignore: [],
      lanes: ['a1', 'a2', 'a3', 'a4'].map(id => ({ preset: 'adversarial', id, label: id, intent: id }))
    })
  });
  // Two models, four same-preset lanes.
  const runner = new FlowRunner(store, testConfig({
    activeModels: [{ id: 'm/one', enabled: true }, { id: 'm/two', enabled: true }],
    resolveModelSource: model => ({ provider: 'script', model, apiKey: null })
  }));
  const runId = runner.start(planFlow({ plan: 'auto', lanes: ['standard', 'wildcard'] }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const unstaffed = store.readLog(runId).filter(l => l.event === 'fanout_lane_unstaffed');
  assert.ok(unstaffed.length >= 1, 'truncating and saying so beats doubling up silently');
  assert.equal(unstaffed[0].preset, 'adversarial');
  const meta = store.readMeta(runId);
  assert.equal(meta.nodeStatus['fan-a1'], 'done');
  assert.equal(meta.nodeStatus['fan-a2'], 'done');
  assert.ok(!('fan-a4' in meta.nodeStatus));
});

test('an unusable plan falls back to the authored lanes and the run still completes', async () => {
  // P3.7: degrade, never fail. A fan-out that cannot reach its planner should
  // still read the repo.
  const store = makeStore();
  planningScript({ plan: 'I reckon about three lanes. Maybe four.' });
  const runner = new FlowRunner(store, POOL_CONFIG());
  const runId = runner.start(planFlow({
    plan: 'auto', tools: ['read_file'],
    lanes: [{ id: 'arch', preset: 'architecture', worker: 'm/one' }, { id: 'wild', preset: 'wildcard', worker: 'm/two' }]
  }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'done', meta.error ?? '');
  assert.equal(meta.nodeStatus['fan-arch'], 'done');
  assert.equal(meta.nodeStatus['fan-wild'], 'done');
  assert.ok(store.readLog(runId).some(l => l.event === 'fanout_plan_failed'));
  const brief = store.readNodeOutput(runId, 'fan.brief');
  assert.match(brief, /AUTHORED fallback/, 'the artifact says the roster was not planned');
  assert.match(brief, /Read this repo\./, 'with a mission derived mechanically from the goal');
});

test('the planner is staffed from the lanes, not from the app-wide default', async () => {
  // A fan-out names no worker of its own — the models live on its lanes, which
  // is how every authored flow in this repo is written. The planner used to
  // fall through to the global default worker, a provider chosen for the whole
  // app with nothing to do with this flow. Watched it cost a whole reading:
  // four lanes each naming a working model, planned on a subscription CLI that
  // could not start, so the planning call failed and the authored roster ran as
  // the fallback. The "read it four ways" was never shaped to the brief, and
  // the only evidence was one line at the bottom of a brief file.
  const store = makeStore();
  let plannedOn = null;
  setScript(call => {
    const role = roleOf(call.system);
    if (role === 'subject-peek') return 'A small JS repo.';
    if (role === 'lane-planner') {
      plannedOn = call.model;
      return planJson({
        mission: 'read it.', subject: 'the repository', focus: [], ignore: [],
        lanes: [{ preset: 'standard', id: 'main', label: 'Main', intent: 'the brief as written' }]
      });
    }
    return 'lane output';
  });

  const runner = new FlowRunner(store, POOL_CONFIG({
    workers: { ...testConfig().workers, executor: { provider: 'script', model: 'the-app-default' } }
  }));
  const runId = runner.start(planFlow({
    plan: 'auto', tools: ['read_file'],
    lanes: [{ id: 'arch', preset: 'architecture', worker: 'm/two' }, { id: 'wild', preset: 'wildcard', worker: 'm/three' }]
  }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(plannedOn, 'm/two', 'the first model the author staffed a lane with');
  assert.notEqual(plannedOn, 'the-app-default');
});

test('a resumed fan-out re-plans zero times and re-peeks zero times', async () => {
  const store = makeStore();
  const roles = [];
  let hang = true;
  setScript(call => {
    const role = roleOf(call.system);
    roles.push(role);
    if (role === 'subject-peek') return 'A small JS repo.';
    if (role === 'lane-planner') {
      return planJson({
        mission: 'read it.', subject: 'the repository', focus: [], ignore: [],
        lanes: [
          { preset: 'standard', id: 'main', label: 'Main', intent: 'the brief as written' },
          { preset: 'wildcard', id: 'odd', label: 'Odd', intent: 'the strange corners' }
        ]
      });
    }
    if (laneNameOf(call.prompt) === 'Odd' && hang) { hang = false; return NEVER(); }
    return 'lane output';
  });

  const runner = new FlowRunner(store, POOL_CONFIG());
  const runId = runner.start(planFlow({ plan: 'auto', tools: ['read_file'], lanes: ['standard'] }), { userInput: 'brief' });
  await waitFor(() => store.readMeta(runId).nodeStatus['fan-odd'] === 'active', { label: 'the odd lane in flight' });
  assert.equal(roles.filter(r => r === 'lane-planner').length, 1);
  assert.equal(roles.filter(r => r === 'subject-peek').length, 1);

  // --- app restart ---
  const restarted = new FlowRunner(store, POOL_CONFIG());
  restarted.reconcileInterrupted();
  restarted.resume(runId);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done', store.readMeta(runId).error ?? '');

  assert.equal(roles.filter(r => r === 'lane-planner').length, 1, 'the roster is not re-planned');
  assert.equal(roles.filter(r => r === 'subject-peek').length, 1, 'and the subject is not re-peeked');
  // The roster is rebuilt from the children, so the aggregate still labels each
  // section with the lane that produced it.
  assert.match(store.readNodeOutput(runId, 'fan'), /--- Odd \(fan-odd\) ---/);
  assert.match(store.readNodeOutput(runId, 'fan.lanes'), /Odd \(odd\)/);
});

test("the peek cannot reach past the fan-out's ceiling", async () => {
  const store = makeStore();
  let peekSystem = '';
  planningScript({
    plan: planJson({
      mission: 'read it.', subject: 'the repository', focus: [], ignore: [],
      lanes: [
        { preset: 'standard', id: 'main', label: 'Main', intent: 'x' },
        { preset: 'wildcard', id: 'odd', label: 'Odd', intent: 'y' }
      ]
    }),
    onPeek: call => { peekSystem = call.system; }
  });
  const runner = new FlowRunner(store, POOL_CONFIG());
  const runId = runner.start(planFlow({
    plan: 'auto',
    // A node that decides what other nodes may do must not be able to do more
    // than they may (§6.3) — and neither may the call that decides WHO they
    // are. The peek's grant is the INTERSECTION of PEEK_TOOLS with the node's
    // own, never a union: search_references is a legal peek tool, and this
    // fan-out still does not get it.
    tools: ['read_file'],
    toolCeiling: ['read_file'],
    lanes: ['standard', 'wildcard']
  }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const peek = store.readLog(runId).find(l => l.event === 'fanout_peek');
  assert.deepEqual(peek.tools, ['read_file'], 'the peek holds no tool the fan-out does not');
  // The protocol advertises one bullet per callable tool. (A substring check
  // would pass on read_file's own description, which name-drops the other.)
  const offered = peekSystem.split('\n').filter(l => /^- \w+: /.test(l)).map(l => l.slice(2).split(':')[0]);
  assert.deepEqual(offered, ['read_file'], 'a tool it may not use is never offered to it');
});

test('a fan-out with no tools to look with plans blind rather than not at all', async () => {
  const store = makeStore();
  planningScript({
    plan: planJson({
      mission: 'read it.', subject: 'the codebase', focus: [], ignore: [],
      lanes: [
        { preset: 'standard', id: 'main', label: 'Main', intent: 'x' },
        { preset: 'contrarian', id: 'against', label: 'Against', intent: 'y' }
      ]
    })
  });
  const runner = new FlowRunner(store, POOL_CONFIG());
  const runId = runner.start(planFlow({ plan: 'auto', lanes: ['standard'] }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  const skipped = store.readLog(runId).find(l => l.event === 'fanout_peek_skipped');
  assert.match(skipped.reason, /no read-only tool grant/);
  assert.equal(store.readMeta(runId).nodeStatus['fan-against'], 'done', 'a blind planner still plans');
});

test('an ignored area is advice in every lane, and costs no lane its place', async () => {
  // The §1.2 guarantee, asserted explicitly: the planner may shape the roster
  // around a FOCUS, but never drop a lane as a punishment for an ignore item,
  // and the wording a lane receives keeps its escape clause.
  const store = makeStore();
  const laneSystems = [];
  planningScript({
    plan: planJson({
      mission: 'explain how it retries.', subject: 'the repository',
      focus: ['the retry path'], ignore: ['test coverage'],
      lanes: [
        { preset: 'architecture', id: 'arch', label: 'Arch', intent: 'x' },
        { preset: 'adversarial', id: 'attack', label: 'Attack', intent: 'y' },
        // A lane whose whole method collides with the ignore item still runs.
        { preset: 'standard', id: 'tests-anyway', label: 'The tests', intent: 'z', emphasis: 'Read the test suite.' }
      ]
    }),
    onLane: call => laneSystems.push(call.system)
  });
  const runner = new FlowRunner(store, POOL_CONFIG());
  const runId = runner.start(planFlow({ plan: 'auto', tools: ['read_file'], lanes: ['standard'] }),
    { userInput: 'Focus on retries, ignore test coverage.' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  assert.equal(laneSystems.length, 3, 'no lane was dropped for colliding with an ignore item');
  for (const s of laneSystems) {
    assert.match(s, /TREAT AS CENTRAL:\n- the retry path/);
    assert.match(s, /LOW PRIORITY[\s\S]*- test coverage/);
    assert.match(s, /unless it is load-bearing for something they did ask for/);
  }
  assert.match(store.readNodeOutput(runId, 'fan.brief'), /Advisory only/);
});

test('a system prompt on the node wins outright, and skips the planner (P3.8)', async () => {
  // Until now `system:` was legal on a fanout and read by nothing: it lint-
  // cleaned and did nothing at all.
  const store = makeStore();
  const roles = [];
  const systems = [];
  setScript(call => { roles.push(roleOf(call.system)); systems.push(call.system); return 'ok'; });
  const runner = new FlowRunner(store, POOL_CONFIG());
  const runId = runner.start(planFlow({
    plan: 'auto', tools: ['read_file'],
    system: 'AUTHOR-PREAMBLE: you are two readers of one small repo.',
    lanes: ['standard', 'wildcard']
  }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  assert.ok(!roles.includes('lane-planner'), 'no planning call');
  assert.ok(!roles.includes('subject-peek'), 'no peek');
  assert.ok(store.readLog(runId).some(l => l.event === 'fanout_plan_inert'));
  for (const s of systems) {
    assert.ok(s.startsWith('AUTHOR-PREAMBLE:'), 'the author wrote the shared preamble by hand');
  }
  assert.match(systems.join('\n'), /ROLE: wildcard reader/, 'and the presets still own the method');
});
