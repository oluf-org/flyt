// Typed run inputs (DECISIONS.md D36). A flow could always take one free-text
// prompt; that is useless for "read THIS repository, looking for THAT", because
// a link pasted into prose is just prose.
//
// The design under test: a declared input is a NODE with one output port per
// input, so `inputs.repo -> clone` is an ordinary ported edge and nothing
// downstream has to know run inputs exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FlowRunner } from '../core/flowRunner.js';
import { ReferenceLibrary } from '../core/references.js';
import { parseFlow } from '../core/flowlang/parse.js';
import { serializeFlow } from '../core/flowlang/serialize.js';
import {
  INPUT_TYPES, INPUTS_NODE_ID, normalizeInputSpec, normalizeInputs,
  validateInputValues, renderInputValue, inputsNode, InputError
} from '../core/nodes/runInputs.js';
import { nodePorts } from '../src/flowTypes.js';
import { makeStore, setScript, testConfig, waitForStage } from './helpers.js';

const run = promisify(execFile);
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function makeRepo(name = 'subject') {
  const dir = path.join(tmp('flyt-src-'), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# subject\n\nthe distinctive-token lives here\n');
  const git = args => run('git', args, { cwd: dir });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['add', '-A']);
  await git(['commit', '-qm', 'first']);
  return dir;
}

// --- the spec ---------------------------------------------------------------

test('a spec carries its type, label and requiredness', () => {
  const s = normalizeInputSpec('repo', { type: 'repo', label: 'Repository', required: true });
  assert.deepEqual(s, { name: 'repo', type: 'repo', label: 'Repository', required: true });
  // A bare type string is the short form.
  assert.equal(normalizeInputSpec('goal', 'text').type, 'text');
  // The label falls back to the name, so a one-word input needs no ceremony.
  assert.equal(normalizeInputSpec('goal', { type: 'text' }).label, 'goal');
});

test('a type the app cannot render is refused at parse time, not at run time', () => {
  assert.throws(() => normalizeInputSpec('x', { type: 'spreadsheet' }), InputError);
  assert.throws(() => normalizeInputSpec('bad name!', { type: 'text' }), /letters, digits/);
  // Every declared type has a control.
  assert.deepEqual(INPUT_TYPES, ['text', 'url', 'repo', 'choice', 'file', 'model', 'modelSet']);
});

test('a choice input needs options, and its default must be one of them', () => {
  assert.throws(() => normalizeInputSpec('d', { type: 'choice' }), /needs "options/);
  assert.throws(() => normalizeInputSpec('d', { type: 'choice', options: ['a'], default: 'z' }),
    /default "z" is not one of its options/);
  assert.deepEqual(normalizeInputSpec('d', { type: 'choice', options: ['a', 'b'], default: 'b' }).options, ['a', 'b']);
});

test('the inputs node exposes one output port per declared input', () => {
  const node = inputsNode(normalizeInputs({ repo: { type: 'repo', label: 'Repository' }, goal: 'text' }));
  assert.equal(node.id, INPUTS_NODE_ID);
  assert.equal(node.type, 'inputs');
  // nodePorts honours data.outputs ahead of everything else, so `inputs.repo`
  // resolves through the machinery every other ported edge already uses.
  assert.deepEqual(nodePorts(node).map(p => p.id), ['repo', 'goal']);
  assert.equal(nodePorts(node)[0].label, 'Repository');
});

// --- values -----------------------------------------------------------------

const SPECS = normalizeInputs({
  repo: { type: 'repo', label: 'Repository', required: true },
  depth: { type: 'choice', options: ['quick', 'thorough'], default: 'quick' },
  goal: { type: 'text', label: 'Goal' }
});

test('defaults fill in, requirements are enforced, and every problem is reported at once', () => {
  const ok = validateInputValues(SPECS, { repo: 'https://example.com/a/b' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.values.depth, 'quick', 'the default applies');
  assert.equal(ok.values.goal, undefined, 'an optional input with no value stays absent');

  const bad = validateInputValues(SPECS, { depth: 'exhaustive', nonsense: 1 });
  assert.equal(bad.errors.length, 3, 'missing repo, bad choice, unknown key — all at once');
  assert.ok(bad.errors.some(e => /"Repository" is required/.test(e)));
  assert.ok(bad.errors.some(e => /not one of quick, thorough/.test(e)));
  assert.ok(bad.errors.some(e => /"nonsense" is not an input of this flow/.test(e)),
    'silently dropping it means the run quietly ignores what you typed');
});

test('a repo input renders as the REFERENCE, not the URL', () => {
  const spec = SPECS.find(s => s.name === 'repo');
  const text = renderInputValue(spec, 'https://example.com/a/b',
    { reference: { name: 'b', url: 'https://example.com/a/b', commit: 'abcdef1234' } });
  assert.match(text, /reference:b/);
  assert.match(text, /abcdef12/);
  assert.match(text, /search_references/, 'and says how to read it');
});

// --- the DSL ----------------------------------------------------------------

const DSL = [
  'version: 1',
  'id: reader',
  'name: Reader',
  'inputs:',
  '  repo:',
  '    type: repo',
  '    label: Repository',
  '    required: true',
  '  depth:',
  '    type: choice',
  '    options: [quick, thorough]',
  '    default: quick',
  'nodes:',
  '  look:',
  '    use: general-analysis',
  'flow:',
  '  - inputs.repo -> look',
  '  - inputs.depth -> look',
  '  - look -> output',
  ''
].join('\n');

test('inputs: parses into a node addressable as inputs.<name>', () => {
  const flow = parseFlow(DSL);
  const node = flow.nodes.find(n => n.id === 'inputs');
  assert.equal(node.type, 'inputs');
  assert.deepEqual(node.data.declared.map(d => d.name), ['repo', 'depth']);
  // The edges are ordinary ported edges.
  const edges = flow.edges.filter(e => e.source === 'inputs');
  assert.deepEqual(edges.map(e => e.sourceHandle), ['repo', 'depth']);
});

test('a flow with no inputs: block is unchanged in every respect', () => {
  const plain = parseFlow('version: 1\nid: p\nname: P\nnodes:\n  a:\n    use: general-analysis\nflow:\n  - input -> a -> output\n');
  assert.ok(!plain.nodes.some(n => n.type === 'inputs'));
  assert.ok(plain.nodes.some(n => n.id === 'input' && n.type === 'input'), 'the free-text prompt node stays');
});

test('a node called "inputs" collides, and says so rather than being shadowed', () => {
  const clash = DSL.replace('  look:\n    use: general-analysis', '  inputs:\n    use: general-analysis');
  assert.throws(() => parseFlow(clash), /collides with this flow's declared inputs/);
});

// --- end to end -------------------------------------------------------------

function runnerWith(store, references = null) {
  const runner = new FlowRunner(store, testConfig());
  if (references) runner.references = references;
  return runner;
}

test('a required input missing refuses the START — no run folder, no wasted call', () => {
  const store = makeStore();
  setScript(() => 'ok');
  const before = store.listRuns().length;
  assert.throws(() => runnerWith(store).start(parseFlow(DSL), { userInput: 'go' }),
    /missing run inputs[\s\S]*"Repository" is required/);
  assert.equal(store.listRuns().length, before, 'nothing was created');
});

test('a repo input clones, pins, and hands downstream a reference it can actually read', async () => {
  const store = makeStore();
  const src = await makeRepo('subject');
  const lib = new ReferenceLibrary(tmp('flyt-lib-'), { repos: [] });
  let prompt = null;
  let system = null;
  setScript(call => { prompt = call.prompt; system = call.system; return 'read it'; });

  const runner = runnerWith(store, lib);
  const runId = runner.start(parseFlow(DSL), { userInput: 'go', inputs: { repo: src, depth: 'thorough' } });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', store.readMeta(runId).error ?? '');

  // The repository is in the library, pinned.
  const entry = lib.list().find(r => r.name === 'subject');
  assert.equal(entry.cloned, true);
  assert.match(entry.commit, /^[0-9a-f]{7,40}$/);

  // The port artifacts exist and carry the right things.
  assert.match(store.readNodeOutput(runId, 'inputs.repo'), /reference:subject/);
  assert.equal(store.readNodeOutput(runId, 'inputs.depth'), 'thorough');

  // The downstream node received them as ordinary upstream context…
  assert.match(prompt, /reference:subject/);
  assert.match(prompt, /thorough/);
  // …and was granted the read-only tools it needs to open the thing (P1.5).
  // Without this it gets a reference name and no way to read it.
  assert.match(system, /search_references/);
  assert.match(system, /read_file/);

  const flow = store.readFlow(runId);
  assert.deepEqual(flow.nodes.find(n => n.id === 'look').data.tools.sort(), ['read_file', 'search_references']);
  assert.equal(store.readMeta(runId).runInputs.depth, 'thorough', 'the run records what it was given');
});

test('a run input the composer left blank falls back to the declared default', async () => {
  const store = makeStore();
  const src = await makeRepo('defaulted');
  const lib = new ReferenceLibrary(tmp('flyt-lib-'), { repos: [] });
  setScript(() => 'ok');
  const runner = runnerWith(store, lib);
  const runId = runner.start(parseFlow(DSL), { userInput: 'go', inputs: { repo: src } });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');
  assert.equal(store.readNodeOutput(runId, 'inputs.depth'), 'quick');
});

test('a repo input that cannot be cloned fails the run with the reason', async () => {
  const store = makeStore();
  const lib = new ReferenceLibrary(tmp('flyt-lib-'), { repos: [] });
  setScript(() => 'ok');
  const runner = runnerWith(store, lib);
  const runId = runner.start(parseFlow(DSL), { userInput: 'go', inputs: { repo: 'https://example.invalid/no/such.git' } });
  await waitForStage(store, runId, ['failed', 'done']);
  assert.equal(store.readMeta(runId).stage, 'failed');
  assert.ok(store.readMeta(runId).error, 'and says why');
});
