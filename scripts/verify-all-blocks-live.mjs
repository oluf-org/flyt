// Explicit, opt-in live acceptance audit. Real adapters, tools, kernel runner,
// permissions, session log and projections; all writes use disposable fixtures.
// FLYT_VERIFY_SETTINGS names an existing settings file. No credentials are copied.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { bootRunKernel, startStackRun } from '../core/kernelHost.js';
import { snapshotStackRun } from '../core/runProjection.js';
import { RunStore } from '../core/state.js';
import { Backlog } from '../core/backlog.js';
import { getTools } from '../core/tools/index.js';
import { callModel } from '../core/adapters/index.js';

assert(process.env.FLYT_VERIFY_SETTINGS, 'Set FLYT_VERIFY_SETTINGS to explicitly authorize live provider use');
assert(!process.env.FLYT_TEST_MOCK_PROVIDER, 'This audit must use a real model');
const settings = JSON.parse(fs.readFileSync(process.env.FLYT_VERIFY_SETTINGS, 'utf8'));
const model = process.env.FLYT_VERIFY_MODEL || 'z-ai/glm-5.3-flash';
assert(model === 'z-ai/glm-5.3-flash' || model.endsWith(':free') || model === 'openrouter/free', 'Only the requested GLM Flash or free models are allowed');
const apiKey = settings.providers?.openrouter?.apiKey;
assert(apiKey, 'The selected settings need an OpenRouter connection');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pass = process.argv.find(x => x.startsWith('--pass='))?.split('=')[1] || 'first';
const only = process.argv.find(x => x.startsWith('--only='))?.split('=')[1]?.split(',');
const recheck = process.argv.find(x => x.startsWith('--recheck='))?.slice('--recheck='.length);
const root = fs.mkdtempSync(path.join(os.tmpdir(), `flyt-block-audit-${pass}-`));
const reportDir = path.join(repo, 'docs/reviews/block-audit'); fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `${pass}${only ? '-' + only.join('-') : ''}.json`);
const report = { pass, model, startedAt: new Date().toISOString(), root, results: [] };
const second = pass.startsWith('second');
const block = (id, use, config = {}) => ({ id, use, config });
const core = (id, config) => block(id, `flyt-blocks-core:${id}`, config);
const judge = (id, config) => block(id, `flyt-blocks-judgement:${id}`, config);
const inquiry = (id, config) => block(id, `flyt-blocks-inquiry:${id}`, config);
const loop = (id, config) => block(id, `flyt-blocks-loop:${id}`, config);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const output = result => Object.values(result.outputs ?? {}).join('\n');
const has = (result, pattern) => check(pattern.test(output(result)), `Output did not match ${pattern}`);
const list = (result, id, field) => result.blockOutputs.filter(x => x.blockId === id).at(-1)?.structured?.[field];
const fixture = second ? {
  'README.md': '# Orchard inventory\nAn offline fruit stock calculator. npm test runs the local arithmetic checks.\n',
  'inventory.js': 'export function total(items) { return items.reduce((sum, item) => sum + item.quantity, 0); }\n',
  'requirements.md': 'Keep zero quantities. Reject negative quantities. Preserve Unicode labels like blåbær.\n',
} : {
  'README.md': '# Harbor scheduling\nA local departure board, stored in JSON. npm test checks schedules. No database or network.\n',
  'schedule.js': 'export function nextDeparture(times, now) { return times.find(time => time >= now) ?? null; }\n',
  'requirements.md': 'Times use 24-hour HH:MM. Include a departure equal to the current time. No remaining departures returns null.\n',
};
const target = second ? 'inventory.js' : 'schedule.js';
const topic = second ? 'fruit inventory' : 'departure schedule';
const cases = [
  { id: 'general-analysis', blocks: [core('general-analysis')], input: second ? 'Analyze these counts: apples 12, pears 8, plums 0. Give the total and say why zero must remain meaningful. Under 100 words.' : 'Analyze: 40 jobs attempted, 30 succeeded, 6 failed, 4 pending. Compute success percentage out of attempted, identify the main limitation, and recommend one next step. Under 100 words.', verify(r) { has(r, second ? /20/ : /75\s*%/); } },
  { id: 'combine', blocks: [core('combine')], input: second ? 'Merge these notes into a single accurate short paragraph. A: Offline stock counter supports apples and pears. B: Must preserve zero quantities and Unicode labels. Keep both requirements.' : 'Merge these two independent review notes, keeping their facts: A: Cache reduces latency from 200 ms to 80 ms. B: Cache must invalidate after updates and never serve stale private data. Under 100 words.', verify(r) { has(r, second ? /zero|\b0\b/i : /80/); has(r, second ? /Unicode|blåbær/i : /invalidat|stale/i); } },
  { id: 'split', blocks: [core('split')], input: second ? 'Split into exactly two complete independent tasks: preserve zero fruit counts; support Unicode fruit labels. Each task needs a goal and acceptance criteria.' : 'Split into exactly two independent tasks: add accessible keyboard navigation to a menu; document the JSON export format. Give each task a title, goal, and acceptance criteria.', verify(r) { const items = list(r, 'split', 'parts'); check(items?.length === 2, `Expected 2 complete parts, got ${items?.length}`); } },
  { id: 'plan-start', blocks: [core('plan-start')], input: `Plan exactly two separately verifiable improvements for ${topic}. Known files: README.md, ${target}, requirements.md. ${second ? 'One task validates nonnegative quantities; one documents Unicode labels.' : 'One task tests equal-time departures; one documents the no-departures case.'} Do not claim to have changed files.`, verify(r) { const items = list(r, 'plan-start', 'tasks'); check(items?.length === 2, `Expected 2 complete tasks, got ${items?.length}`); has(r, new RegExp(target.replace('.', '\\.'))); } },
  { id: 'evaluation', blocks: [judge('evaluation')], input: second ? 'Fixed requirement: candidate must contain both ALPHA and BETA. Actual candidate: ALPHA. Evidence: literal inspection shows BETA missing. Evaluate.' : 'Fixed requirement: sum 2 and 3 correctly. Candidate: 5. Evidence: 2 + 3 = 5. Evaluate.', verify(r) { const s = r.blockOutputs.at(-1)?.structured; check(s?.verdict === (second ? 'retry' : 'pass'), 'Wrong verdict'); check(s?.success === !second, 'Wrong success boolean'); } },
  { id: 'compare', blocks: [judge('compare')], input: second ? 'Compare A: keep zero in stock totals, preserve original labels. B: omit zero rows, lowercase labels. Requirements: zeros and Unicode labels must be preserved. Recommend one.' : 'Compare A: 80 ms latency, 20 MB memory. B: 200 ms latency, 4 MB memory. Hard limit: memory below 8 MB. Recommend a valid option and explain.', verify(r) { has(r, second ? /\bA\b/ : /\bB\b/); } },
  { id: 'prompt-refiner', blocks: [judge('prompt-refiner')], input: `Refine this fully specified request: add tests for ${target} in this repository using node:test, keep production behavior unchanged, and provide the test results. No clarification is needed.`, verify(r) { has(r, /node:test/); has(r, /test/i); check(!r.questions.length, 'Asked unnecessary clarification'); } },
  { id: 'human-checkpoint', blocks: [judge('human-checkpoint')], input: `Approved test artifact: ${topic}.`, answer: second ? 'Stop this workflow' : 'Approve and continue', expected: second ? 'failed' : 'done', verify(r) { check(r.questions.length === 1, 'Checkpoint did not ask exactly once'); has(r, new RegExp(topic)); check(r.blockOutputs.at(-1)?.structured?.approved === !second, 'Wrong approval value'); } },
  { id: 'interrogate', blocks: [inquiry('interrogate', { instructions: 'Use ask_human for one consequential clarification, then deliver the specification. Do not output an unanswered question.' })], input: `Specify a ${topic} export feature. The key missing decision is whether the format should be CSV or JSON. Ask once; use the answer.`, answer: second ? 'CSV. Include zero values and retain Unicode labels.' : 'JSON. Use an array of departures with 24-hour HH:MM timestamps.', verify(r) { check(r.questions.length >= 1, 'Never asked the necessary clarification'); has(r, second ? /CSV/ : /JSON/); } },
  { id: 'orient', blocks: [inquiry('orient')], input: `Read README.md and ${target}. Explain how this actual workspace relates to ${second ? 'an online grocery marketplace' : 'a distributed airline reservation system'}. Under 150 words.`, verify(r) { check(r.tools.some(t => t.name === 'read_file'), 'Orientation did not read files'); has(r, second ? /offline|local/i : /local|JSON/); } },
  { id: 'backlog-plan', blocks: [loop('backlog-plan')], input: `Read README.md, ${target}, requirements.md. Propose exactly two independent backlog tasks for ${topic}: ${second ? 'test zero quantities; document Unicode handling' : 'test the equal-time boundary; document the empty result'}. Include grounded blastRadius, doneWhen, and existing gates.`, verify(r) { const tasks = list(r, 'backlog-plan', 'tasks'); check(tasks?.length === 2, `Expected 2 claimable tasks, got ${tasks?.length}`); check(r.tools.some(t => t.name === 'read_file'), 'Planner did not ground paths'); check(tasks.some(task => task.blastRadius?.some(file => /(?:test|spec)/.test(file))), 'Required new test file is missing from the allowed write paths'); } },
  { id: 'loop-handoff', blocks: [loop('loop-handoff')], input: JSON.stringify([{ title: `Document ${topic}`, goal: `Document the behavior of ${target} in README.md.`, doneWhen: ['README.md describes the behavior'], blastRadius: ['README.md'] }]), verify(r) { check(list(r, 'loop-handoff', 'queued')?.length === 1, 'No durable queue receipt'); check(r.backlog.length === 1, 'No task actually queued'); } },
  { id: 'work', blocks: [core('work', { hardMaxSteps: 12 })], input: second ? 'Read inventory.js. Add a node:test test in inventory.test.js proving total returns 0 for an empty list and retains zero-quantity items. Run node --test inventory.test.js. Do not alter inventory.js. Report results.' : 'Read schedule.js. Add a node:test test in schedule.test.js proving equal-time departures are returned and no future departure returns null. Run node --test schedule.test.js. Do not alter schedule.js. Report results.', verify(r) { check(fs.existsSync(path.join(r.workspace, second ? 'inventory.test.js' : 'schedule.test.js')), 'Work did not create tests'); check(r.tools.some(t => t.name === 'bash'), 'Work did not execute verification'); } },
  { id: 'research', blocks: [core('research', { hardMaxSteps: 10 })], input: second ? 'Open https://www.rfc-editor.org/rfc/rfc8259 and explain whether JSON object member names are strings and whether arrays may be empty. Cite the opened source. Under 130 words.' : 'Open https://nodejs.org/api/test.html and explain the simplest way to import node:test and execute a test file with Node. Cite the opened source. Under 130 words.', verify(r) { check(r.tools.some(t => /web_fetch|scrape_page|extract_page/.test(t.name)), 'Research did not open a source'); has(r, second ? /rfc-editor\.org/ : /nodejs\.org/); } },
  { id: 'task-graph', blocks: [core('task-graph', { minTasks: 2, maxTasks: 2, maxParallel: 2, workerMaxSteps: 10, workerMaxOutputWords: 180 })], input: `Use exactly two independent read-only tasks: inspect README.md to describe this project's purpose, and inspect ${target} to explain its behavior on ${second ? 'an empty array' : 'a time equal to now'}. Do not edit files. Return both conclusions.`, verify(r) { check(r.generated.length >= 2, 'No generated child tasks'); has(r, second ? /\b0\b|zero/i : /equal|>=/); } },
  { id: 'analysis-files', blocks: [core('general-analysis')], input: `Open ${target} and requirements.md. Explain the actual function and its ${second ? 'zero-quantity' : 'equal-time'} behavior. Cite the opened file. Under 120 words.`, verify(r) { check(r.tools.some(t => t.name === 'read_file'), 'Repository analysis could not open evidence'); has(r, second ? /total|reduce/ : /nextDeparture|>=/); } },
  { id: 'foreach', blocks: [
    { ...core('split', { instructions: 'Return each part as a JSON object with title and acceptance fields. Preserve the two supplied acceptance requirements.' }), outputs: [{ name: 'parts', type: 'list' }] },
    { id: 'each', kind: 'foreach', roster: 'split.parts', max: 2, body: [block('describe', 'flyt-blocks-core:general-analysis', { inputOnly: true, instructions: 'Describe only the single supplied part in one short sentence, including its title and acceptance requirement.' })] },
  ], input: second ? 'Make exactly two independent parts: preserve zero counts (acceptance: zero is displayed); preserve Unicode labels (acceptance: blåbær stays unchanged).' : 'Make exactly two independent parts: keyboard navigation (acceptance: Enter opens menu); JSON documentation (acceptance: schema example included).', verify(r) { check(list(r, 'split', 'parts')?.length === 2, 'Split did not produce exactly two parts'); const children = r.blockOutputs.filter(x => x.blockId === 'describe'); check(children.length === 2, 'Foreach did not execute both parts'); check((second ? /zero|\b0\b/i : /Enter/).test(children[0].structured.analysis), 'First child lost its task object'); check((second ? /blåbær/i : /schema/i).test(children[1].structured.analysis), 'Second child lost its acceptance requirement'); check(r.nodeStatus.each === 'done', 'Foreach remained active after completing'); } },
  { id: 'parallel-sequence', blocks: [
    { id: 'options', kind: 'parallel', maxParallel: 2, lanes: [
      block('speed', 'flyt-blocks-core:general-analysis', { instructions: 'Assess option A only. Preserve the original requirements and exact figures. Under 60 words.' }),
      block('memory', 'flyt-blocks-core:general-analysis', { instructions: 'Assess option B only. Preserve the original requirements and exact figures. Under 60 words.' }),
    ] }, judge('compare', { instructions: 'Compare both supplied lanes against the original hard requirement, and recommend a feasible option. Under 100 words.' }), core('combine', { instructions: 'Keep the chosen option and its reason in one concise final recommendation.' }),
  ], input: second ? 'Hard requirement: must retain zero quantities. Option A retains zeros, takes 30 ms. Option B removes zeros, takes 10 ms.' : 'Hard requirement: memory below 8 MB. Option A takes 80 ms and 20 MB. Option B takes 200 ms and 4 MB.', verify(r) { for (const id of ['speed', 'memory', 'compare', 'combine']) check(r.nodeStatus[id] === 'done', `${id} did not finish`); check(new RegExp(second ? '\\bA\\b' : '\\bB\\b').test(r.outputs.combine), 'Joined recommendation violates hard requirement'); } },
  { id: 'repeat', blocks: [{ id: 'repeat-counter', kind: 'repeat', count: second ? 3 : 2, body: [block('increment', 'flyt-blocks-core:general-analysis', { instructions: 'Read the integer supplied as input. Add exactly 1. Return ONLY the resulting integer, without explanation.' })] }], input: second ? '10' : '0', verify(r) { check(r.outputs.increment?.trim() === (second ? '13' : '2'), 'Repeat lost its carried value'); check(r.blockOutputs.length === (second ? 3 : 2), 'Wrong repeat count'); } },
  { id: 'until', blocks: [{ id: 'converge', kind: 'until', max: 3, condition: { source: 'increment.analysis', operator: 'is', literal: second ? '12' : '2' }, body: [
    { ...block('increment', 'flyt-blocks-core:general-analysis', { instructions: 'Read the integer supplied as input. Add exactly 1. Return ONLY the resulting integer, without explanation.' }), outputs: [{ name: 'analysis', type: 'string' }] },
  ] }], input: second ? '10' : '0', verify(r) { check(r.blockOutputs.length === 2, 'Until did not stop at the matching second iteration'); check(r.outputs.increment?.trim() === (second ? '12' : '2'), 'Wrong Until result'); } },
  { id: 'if', blocks: [
    { ...judge('evaluation'), outputs: [{ name: 'success', type: 'boolean' }] },
    { id: 'branch', kind: 'if', predicate: { source: 'evaluation.success', operator: 'is', literal: true }, body: [block('accepted', 'flyt-blocks-core:general-analysis', { instructions: 'Return exactly ACCEPTED.' })], else: [block('revision', 'flyt-blocks-core:general-analysis', { instructions: 'Return exactly REVISE.' })] },
  ], input: second ? 'Requirement: contains ALPHA and BETA. Candidate: ALPHA. Evidence: BETA is absent.' : 'Requirement: correctly compute 2 + 3. Candidate: 5. Evidence: arithmetic confirms 5.', verify(r) { check(r.nodeStatus[second ? 'revision' : 'accepted'] === 'done', 'Wrong If branch'); check(r.nodeStatus[second ? 'accepted' : 'revision'] !== 'done', 'Both branches executed'); } },
  { id: 'plan-handoff', blocks: [loop('backlog-plan'), loop('loop-handoff')], input: `Read ${target} and README.md. Plan exactly two independent backlog tasks: add a boundary test for ${second ? 'empty input' : 'equal-time departure'}; document ${second ? 'zero quantities' : 'null result'}. Ground paths in this workspace and include acceptance criteria.`, verify(r) { check(r.backlog.length === 2, 'Plan did not queue exactly two complete tasks'); check(list(r, 'loop-handoff', 'queued')?.length === 2, 'Missing joined handoff receipts'); } },
  { id: 'parallel-failure', expected: 'failed', answer: 'Stop this workflow', blocks: [
    { id: 'lanes', kind: 'parallel', maxParallel: 2, lanes: [judge('human-checkpoint'), block('other', 'flyt-blocks-core:general-analysis', { instructions: 'Return exactly OTHER LANE FINISHED.' })] },
    block('after', 'flyt-blocks-core:general-analysis', { instructions: 'This must not execute after a rejected lane.' }),
  ], input: 'A human must approve this artifact.', verify(r) { check(r.nodeStatus.other === 'done', 'The companion lane did not finish'); check(r.nodeStatus.lanes === 'failed', 'Parallel hid the failed lane'); check(!r.nodeStatus.after, 'Downstream work ran after rejection'); } },
  { id: 'until-exhausted', expected: 'failed', blocks: [
    { id: 'bounded', kind: 'until', max: 2, condition: { source: 'counter.analysis', operator: 'is', literal: '99' }, body: [{ ...block('counter', 'flyt-blocks-core:general-analysis', { instructions: 'Add exactly 1 to the integer input. Return only the new integer.' }), outputs: [{ name: 'analysis', type: 'string' }] }] },
    block('after', 'flyt-blocks-core:general-analysis'),
  ], input: '0', verify(r) { check(r.blockOutputs.length === 2, 'Until exceeded its bound'); check(r.outputs.counter?.trim() === '2', 'Wrong carried result'); check(r.nodeStatus.bounded === 'failed', 'Exhausted Until not marked failed'); check(!r.nodeStatus.after, 'Downstream work ran after failed Until'); } },
];

async function runCase(testCase) {
  const workspace = path.join(root, testCase.id); fs.mkdirSync(workspace);
  for (const [name, content] of Object.entries({ ...fixture, 'package.json': JSON.stringify({ name: 'block-audit-fixture', type: 'module', scripts: { test: 'node --test' } }) })) fs.writeFileSync(path.join(workspace, name), content);
  const runsRoot = path.join(workspace, '.flyt/runs'); const store = new RunStore(runsRoot);
  const backlog = new Backlog(path.join(workspace, '.flyt/backlog'));
  const result = { id: testCase.id, workspace, status: 'starting', calls: [], questions: [], tools: [], warnings: [], blockOutputs: [], generated: [] };
  report.results.push(result); save();
  const startedAt = Date.now(); console.log(`START ${pass}/${testCase.id}`);
  let host, started, timer;
  try {
    host = await bootRunKernel({ workspaceDir: workspace, runsRoot, store, stackRoot: path.join(repo, 'stacks'),
      stackSource: yaml.dump({ version: 2, id: `audit-${testCase.id}`, launchable: true, blocks: testCase.blocks }, { noRefs: true, lineWidth: -1 }),
      worker: { provider: 'openrouter', model }, profile: 'flyt-desktop',
      approvalMode: 'always', sandboxMode: 'danger-full-access',
      ceiling: getTools().map(t => t.name), backlog, settings: {},
      runtimeConfig: { modelFacts: settings.modelFacts, retry: { attempts: 1 }, timeout: { firstByteMs: 60000, idleMs: 60000, totalMs: 120000 } },
      resolveModelSource: requested => { assert.equal(requested, model); return { provider: 'openrouter', model, apiKey }; },
      askBlock: async question => { result.questions.push(question); return testCase.answer || 'Use the specified fixture requirements and proceed with a reversible assumption.'; },
      call: async request => { assert.equal(request.model, model); const start = Date.now(); const response = await callModel(request); result.calls.push({ model: response.model, provider: response.provider, durationMs: Date.now() - start, usage: response.usage, finishReason: response.finishReason }); save(); return response; },
      onSessionEvent: (_id, event) => {
        if (event.type === 'tool.result') result.tools.push(event.data);
        if (event.type === 'block.warning') result.warnings.push(event.data);
        if (event.type === 'block.status' && event.data.structured !== undefined) result.blockOutputs.push(event.data);
        if (event.type === 'block.status' && event.data.parentId && event.data.status === 'pending' && event.data.attempt === 0) result.generated.push(event.data);
      },
    });
    if (!report.inventory) { report.inventory = host.ctx.blocks.list().map(({ use, title, outputs, ceiling }) => ({ use, title, outputs, ceiling })); save(); }
    started = await startStackRun({ host, stackId: testCase.id, input: testCase.input });
    result.runId = started.runId;
    timer = setTimeout(() => { result.timedOut = true; void started.run.stop('Audit case exceeded four minutes'); }, 240000);
    const outcome = await started.run.settled(); result.status = outcome.status; result.error = outcome.error;
    const snapshot = await snapshotStackRun(host.ctx, started.runId, host.kernelModule);
    result.outputs = snapshot.nodeOutputs; result.nodeStatus = snapshot.meta.nodeStatus;
    result.backlog = backlog.list();
    check(result.status === (testCase.expected || 'done'), `Expected ${testCase.expected || 'done'}, got ${result.status}: ${result.error}`);
    testCase.verify?.(result); result.quality = 'pass';
  } catch (error) { result.quality = 'fail'; result.finding = error.message; console.error(`FAIL ${testCase.id}: ${error.message}`); }
  finally { clearTimeout(timer); if (host) await host.dispose(); result.durationMs = Date.now() - startedAt; save(); }
  console.log(`END ${testCase.id}: ${result.status}/${result.quality}, ${result.calls.length} calls, ${Math.round(result.durationMs / 1000)}s`);
}
function save() { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
if (recheck) {
  const previous = JSON.parse(fs.readFileSync(recheck, 'utf8'));
  for (const result of previous.results) {
    const testCase = cases.find(c => c.id === result.id); if (!testCase || !result.runId) continue;
    const events = fs.readFileSync(path.join(result.workspace, '.flyt/runs', result.runId, 'session.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    result.blockOutputs = events.filter(e => e.type === 'block.status' && e.data.structured !== undefined).map(e => e.data);
    result.generated = events.filter(e => e.type === 'block.status' && e.data.parentId && e.data.status === 'pending' && e.data.attempt === 0).map(e => e.data);
    try { check(result.status === (testCase.expected || 'done'), `Expected ${testCase.expected || 'done'}, got ${result.status}: ${result.error}`); testCase.verify?.(result); result.quality = 'pass'; delete result.finding; }
    catch (error) { result.quality = 'fail'; result.finding = error.message; }
  }
  previous.collectorCorrection = 'Structured outputs and generated children were re-read from their canonical block.status events; no model calls were repeated.';
  fs.writeFileSync(recheck, JSON.stringify(previous, null, 2));
  console.log(previous.results.map(x => `${x.id}: ${x.quality} ${x.finding ?? ''}`).join('\n'));
  process.exit(0);
}
for (const testCase of cases.filter(c => !only || only.includes(c.id))) await runCase(testCase);
report.completedAt = new Date().toISOString(); save();
console.log(`Report: ${reportPath}`);
if (report.results.some(r => r.quality !== 'pass')) process.exitCode = 1;
