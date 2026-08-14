// Fan-out lanes (BRICKS P2 / D36 B5–B6): lane normalization and the
// cross-lane brief as pure functions, then the node end to end — lanes
// materialized inside the box, run in parallel, aggregated per lane, with
// each lane told who its siblings are and none of them told what the others
// produced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner } from '../core/flowRunner.js';
import {
  normalizeLane, normalizeLaneWorker, resolveLanes, laneBrief, laneInventory,
  LANE_PRESETS, DEFAULT_LANE_TEMPLATE
} from '../core/nodes/fanout.js';
import { makeStore, setScript, roleOf, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

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
  // it nested, so an aiStep with a read-only grant (TOOLS-PLAN 6.4) called
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
