import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoalController } from '../core/goalController.js';
import { GoalAuthoring, semanticFields } from '../core/goalAuthoring.js';
import { GOAL_RECIPE } from '../src/v2/goalDefaults.js';
import { loopNodes, circlePositions, goalNodeStatus } from '../src/v2/goalCanvasData.js';
import { authoringCapabilities, conversationContext, selectProjectFiles, readSelectedFile } from '../core/goalAuthoringContext.js';
import { decodeAuthoringResponse, responseProblem, authoringEditContract, authoringResponseFormat } from '../core/goalAuthoringProtocol.js';

async function fixture(t, call = async () => ({ text: '{}' })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-author-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const goals = new GoalController({ runs: {}, project: () => ({ id: 'project', folder: workspace, store: { rootDir: path.join(root, 'runs') } }), worker: () => ({ provider: 'mock', model: 'model' }) });
  const author = new GoalAuthoring({ root: path.join(root, 'host'), goals, call });
  const definition = { name: 'A loop', objective: 'Produce ALPHA', constraints: '', recipe: GOAL_RECIPE, setup: null, folder: workspace, limits: { iterations: 3, calls: 10, minutes: 2 }, criteria: [{ type: 'output_contains', value: 'ALPHA' }], tools: [], worker: { provider: 'mock', model: 'model' } };
  const state = await author.open({ projectId: 'project', definition });
  const args = { projectId: 'project', draftId: state.id };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const address = 'recipe/improve/config/instructions';
  const parse = await author.parser();
  const value = semanticFields(definition, parse).get(address);
  const grant = (quotes = [{ address, value }]) => author.grant({ ...args, baseRevision: author.read(args).revision, quotes });
  const propose = async (operations, quotes) => author.propose({ ...args, grantId: (await grant(quotes)).id, operations });
  return { author, goals, args, state, address, value, grant, propose, workspace, root };
}
const replace = (address, value) => ({ op: 'replace', address, value });
const reply = (value, cost = 0.001) => ({ text: JSON.stringify(value), usage: { cost } });
async function message(f, text, extra = {}) {
  const requestId = `request-${f.author.read(f.args).requests.length}`;
  await f.author.author({ ...f.args, baseRevision: f.author.read(f.args).revision, requestId, text, scope: { type: 'loop' }, ...extra });
  await Promise.all([...f.author.deliveries]);
  return f.author.read(f.args).requests.find(item => item.id === requestId);
}

test('messages and questions persist without proposals; follow-ups receive both sides and decisions', async t => {
  const contexts = [];
  const answers = [{ type: 'message', text: 'The first approach uses a review step.' }, { type: 'question', text: 'Which artifact should be reviewed?' }];
  const f = await fixture(t, ({ prompt }) => { contexts.push(JSON.parse(prompt)); return reply(answers.shift()); });
  const proposal = await f.propose([replace(f.address, 'Try a reviewer')]);
  await f.author.review({ ...f.args, proposalId: proposal.id, decision: 'reject' });
  assert.equal((await message(f, 'What are my options?')).response.type, 'message');
  assert.equal((await message(f, 'Use the first approach')).response.type, 'question');
  const state = f.author.read(f.args);
  assert.equal(state.hash, f.state.hash); assert.equal(state.revision, 1); assert.equal(state.proposals.length, 1);
  assert.equal(contexts[1].conversation.turns[0].assistant.text, 'The first approach uses a review step.');
  assert.equal(contexts[1].conversation.decisions[0].status, 'rejected');
  assert.equal(contexts[1].conversation.turns.length, 1, 'current request is not duplicated as history');
  const reopened = new GoalAuthoring({ root: f.author.root, goals: f.goals, call: f.author.call });
  assert.equal(reopened.read(f.args).requests[1].response.text, 'Which artifact should be reviewed?');
});

test('authoring capabilities contain installed schemas, ceilings and valid examples', async t => {
  const f = await fixture(t);
  const context = await authoringCapabilities(f.goals, [{ id: 'chosen-model', provider: 'test' }]);
  const block = context.blocks.find(item => item.use === 'flyt-blocks-core:general-analysis');
  assert.ok(block.settings.properties.instructions); assert.ok(Object.hasOwn(block, 'ceiling')); assert.equal(block.execute, undefined);
  assert.equal(context.blocks.some(item => item.use === 'flyt-blocks-loop:loop-handoff'), false);
  assert.equal(context.models[0].id, 'chosen-model');
  for (const example of context.examples) await f.goals.validateSource(example, { maxParallel: 4 });
});

test('step grants and preview enforce scope, locks and revisions without applying changes', async t => {
  const f = await fixture(t);
  const grant = await f.author.grant({ ...f.args, baseRevision: 1, scope: { type: 'step', address: 'recipe/improve' } });
  const args = { ...f.args, grantId: grant.id };
  const preview = await f.author.preview({ ...args, operations: [replace(f.address, 'Scoped improvement')] });
  assert.equal(preview.valid, true); assert.equal(preview.runtimeVerified, false); assert.equal(preview.readyToStart, true);
  for (const operation of [replace('goal/worker', { provider: 'other', model: 'other' }), replace('recipe', GOAL_RECIPE), replace('recipe/improve-other/title', 'Outside')]) {
    await assert.rejects(f.author.preview({ ...args, operations: [operation] }), /EDIT_OUT_OF_SCOPE|STALE_QUOTE/);
  }
  assert.equal(f.author.read(f.args).proposals.length, 0); assert.equal(f.author.read(f.args).hash, f.state.hash);
  await f.author.setLock({ ...f.args, baseRevision: 1, address: f.address, locked: true });
  await assert.rejects(f.author.propose({ ...args, operations: [replace(f.address, 'Stale')] }), /STALE_REVISION/);
  const locked = await f.author.grant({ ...f.args, baseRevision: 1, scope: { type: 'step', address: 'recipe/improve' } });
  await assert.rejects(f.author.preview({ ...args, grantId: locked.id, operations: [replace(f.address, 'Locked')] }), /LOCKED_FIELD/);
  await assert.rejects(f.author.grant({ ...f.args, baseRevision: 1, scope: { type: 'fields' } }), /EDIT_OUT_OF_SCOPE/);
  await assert.rejects(f.author.grant({ ...f.args, baseRevision: 1, scope: { type: 'loop' }, quotes: [{ address: f.address, value: f.value }] }), /EDIT_OUT_OF_SCOPE/);
});

test('read-only tools inspect selected files and contracts, validate, then produce a reviewed proposal', async t => {
  let calls = 0, f;
  f = await fixture(t, ({ prompt }) => {
    const context = JSON.parse(prompt); calls++;
    if (calls === 1) return reply({ type: 'tool', name: 'read_project_file', arguments: { path: 'notes.md' } });
    if (calls === 2) {
      assert.equal(context.exchanges.at(-1).tool.result.text, 'Artifact requirements');
      return reply({ type: 'tool', name: 'inspect_block', arguments: { use: 'flyt-blocks-core:general-analysis' } });
    }
    if (calls === 3) return reply({ type: 'tool', name: 'validate_proposal', arguments: { operations: [replace(f.address, 'Use the requirements')] } });
    assert.equal(context.exchanges.at(-1).tool.result.runtimeVerified, false);
    return reply({ type: 'proposal', operations: [replace(f.address, 'Use the requirements')], rationale: 'Uses the selected requirements.' });
  });
  fs.writeFileSync(path.join(f.workspace, 'notes.md'), 'Artifact requirements');
  const result = await message(f, 'Update this step using notes.md', { selectedFiles: ['notes.md'], scope: { type: 'step', address: 'recipe/improve' } });
  assert.equal(result.status, 'complete'); assert.equal(result.toolCalls.length, 3); assert.equal(result.calls, 4);
  const state = f.author.read(f.args);
  assert.equal(state.authoringCalls, 4); assert.equal(state.knownUsd, 0.004); assert.equal(state.proposals[0].status, 'pending');
  assert.equal(state.hash, f.state.hash); assert.equal(fs.readFileSync(path.join(f.workspace, 'notes.md'), 'utf8'), 'Artifact requirements');
});

test('file inspection rejects unselected paths, traversal and escaping junctions; reads are bounded', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'notes.md'), 'A'.repeat(40000));
  fs.writeFileSync(path.join(f.root, 'outside.md'), 'outside');
  const selected = selectProjectFiles({ folder: f.workspace }, ['notes.md']);
  assert.equal(readSelectedFile(selected, 'notes.md').text.length, 32768);
  assert.equal(readSelectedFile(selected, 'notes.md').truncated, true);
  assert.throws(() => readSelectedFile(selected, '../outside.md'), /READ_OUT_OF_SCOPE/);
  assert.throws(() => selectProjectFiles({ folder: f.workspace }, ['../outside.md']), /READ_OUT_OF_SCOPE/);
  assert.throws(() => selectProjectFiles({ folder: f.workspace }, [path.join(f.root, 'outside.md')]), /READ_OUT_OF_SCOPE/);
  fs.symlinkSync(f.root, path.join(f.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => selectProjectFiles({ folder: f.workspace }, ['escape/outside.md']), /READ_OUT_OF_SCOPE/);
  fs.unlinkSync(path.join(f.workspace, 'escape'));
});

test('unknown tools and unselected reads cannot execute; denied requests are visible to the model', async t => {
  let calls = 0;
  const f = await fixture(t, ({ prompt }) => {
    const context = JSON.parse(prompt); calls++;
    if (calls === 1) return reply({ type: 'tool', name: 'read_project_file', arguments: { path: 'private.md' } });
    assert.equal(context.exchanges.at(-1).tool.ok, false);
    if (calls === 2) return reply({ type: 'tool', name: 'bash', arguments: { command: 'write something' } });
    return reply({ type: 'message', text: 'Select a requirements file to provide context.' });
  });
  const request = await message(f, 'Inspect the requirements');
  assert.equal(request.status, 'complete'); assert.equal(request.toolCalls.length, 2);
  assert.match(request.toolCalls[0].error, /not selected/); assert.match(request.toolCalls[1].error, /Unknown authoring tool/);
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});

test('one correction receives validation errors while preserving the grant and accounting for each call', async t => {
  let calls = 0, f;
  f = await fixture(t, ({ prompt }) => {
    const context = JSON.parse(prompt); calls++;
    if (calls === 1) return reply({ type: 'proposal', operations: [replace('goal/name', 'Out of scope')], rationale: 'Wrong scope' });
    assert.match(context.failure.error, /EDIT_OUT_OF_SCOPE/);
    assert.equal(context.capabilities, undefined, 'correction omits the full catalogue and examples');
    assert.equal(context.toolsAvailable, false);
    assert.equal(context.grant.scope.type, 'fields');
    return reply({ type: 'proposal', operations: [replace(f.address, 'Corrected')], rationale: 'Only the selected field' });
  });
  const request = await message(f, 'Improve the instructions', { scope: { type: 'fields' }, quotes: [{ address: f.address, value: f.value }] });
  assert.equal(request.status, 'complete'); assert.equal(request.calls, 2); assert.equal(request.toolCalls[0].ok, false);
  assert.equal(f.author.read(f.args).proposals.length, 1); assert.equal(f.author.read(f.args).definition.name, 'A loop');
});

test('repeated invalid replies and tool requests have bounded costs', async t => {
  const f = await fixture(t, () => reply({ type: 'proposal', operations: [replace('goal/limits', null)] }));
  const invalid = await message(f, 'Change the limits');
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.calls, 2); assert.equal(f.author.read(f.args).proposals.length, 0);
  f.author.call = async () => reply({ type: 'tool', name: 'inspect_block', arguments: { use: 'flyt-blocks-core:general-analysis' } });
  const endless = await message(f, 'Inspect blocks');
  assert.equal(endless.status, 'failed'); assert.equal(endless.calls, 6); assert.equal(endless.toolCalls.filter(item => item.name === 'inspect_block').length, 5);
  assert.equal(f.author.read(f.args).authoringCalls, 8);
});

test('cancellation prevents proposals even if the model ignores abort and returns an edit', async t => {
  let release, called;
  const started = new Promise(resolve => { called = resolve; });
  const f = await fixture(t, () => { called(); return new Promise(resolve => { release = resolve; }); });
  const requestId = 'cancel-late';
  await f.author.author({ ...f.args, baseRevision: 1, requestId, text: 'Rename' });
  await started;
  f.author.cancel({ ...f.args, requestId });
  release(reply({ type: 'proposal', operations: [replace('goal/name', 'Too late')] }));
  await Promise.all([...f.author.deliveries]);
  const state = f.author.read(f.args);
  assert.equal(state.requests[0].status, 'failed'); assert.equal(state.proposals.length, 0); assert.equal(state.knownUsd, 0.001);
});

test('chat scope and file selections persist; conversation context stays bounded', async t => {
  const f = await fixture(t);
  const scope = { type: 'step', address: 'recipe/improve' };
  await f.author.ui({ ...f.args, ui: { composer: 'Continue', quotes: [], scope, selectedFiles: 'README.md' } });
  assert.deepEqual(f.author.read(f.args).ui.scope, scope); assert.equal(f.author.read(f.args).ui.selectedFiles, 'README.md');
  const state = f.author.read(f.args);
  state.requests = Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: 'Question', response: { type: 'message', text: 'A'.repeat(8000) }, status: 'complete' }));
  const context = conversationContext(state, 'current');
  assert(JSON.stringify(context.turns).length <= 32000); assert.equal(context.turns.at(-1).id, '99');
});

test('malformed reply then timeout preserves both attempts, partial answer and usage without reasoning text', async t => {
  let calls = 0;
  const f = await fixture(t, ({ onText, onCall, correction, prompt }) => {
    calls++;
    if (calls === 1) return { text: 'Here is a broken { reply', finishReason: 'stop', reasoning: 'private reasoning', usage: { cost: 0.006 } };
    assert.equal(correction, true);
    assert.equal(JSON.parse(prompt).failure.response, 'Here is a broken { reply');
    onText('ignored rendering', { content: '{"type":"proposal",', reasoning: 'private thoughts', telemetry: { contentChars: 19, reasoningChars: 16 } });
    onCall({ httpStatus: 200, firstByteMs: 10, error: 'hard timeout', provider: 'openrouter', responseMode: 'json_schema' });
    throw new Error('openrouter call exceeded its 90s ceiling (hard timeout)');
  });
  const request = await message(f, 'Create a security audit loop');
  assert.equal(request.status, 'failed'); assert.equal(request.attempts.length, 2);
  assert.equal(request.attempts[0].rawResponse, 'Here is a broken { reply');
  assert.match(request.attempts[0].validationError, /JSON response object/);
  assert.equal(request.attempts[1].rawResponse, '{"type":"proposal",');
  assert.equal(request.attempts[1].httpStatus, 200); assert.equal(request.attempts[1].responseMode, 'json_schema');
  assert.equal(request.attempts[1].status, 'failed'); assert.equal(request.attempts[1].reasoningChars, 16);
  assert.equal(JSON.stringify(request).includes('private thoughts'), false); assert.equal(JSON.stringify(request).includes('private reasoning'), false);
  assert.equal(f.author.read(f.args).knownUsd, 0.006); assert.equal(f.author.read(f.args).unknownCostCalls, 1);
  assert.equal(f.author.read(f.args).proposals.length, 0);
});

test('reasoning budget exhaustion and truncation get focused correction, never acceptance', async t => {
  let calls = 0;
  const f = await fixture(t, ({ correction, prompt }) => {
    calls++;
    if (calls === 1) return { text: '', reasoning: 'hidden', finishReason: 'length', usage: { cost: 0.001 } };
    assert.equal(correction, true); assert.equal(JSON.parse(prompt).failure.code, 'REASONING_BUDGET_EXHAUSTED');
    return reply({ type: 'question', text: 'Which repository should this loop review?' });
  });
  const request = await message(f, 'Design an audit loop');
  assert.equal(request.response.type, 'question'); assert.equal(request.attempts[0].completionProblem, 'REASONING_BUDGET_EXHAUSTED');
  assert.equal(request.attempts[1].maxTokens, 4096);
  assert.equal(responseProblem({ text: '{"type":"message","text":"Looks valid"}', finishReason: 'length' }).code, 'TRUNCATED_RESPONSE');
});

test('stream progress is persisted before completion and survives UI writes', async t => {
  let release, streamed;
  const started = new Promise(resolve => { streamed = resolve; });
  const f = await fixture(t, ({ onText }) => {
    onText('hidden', { content: '', reasoning: 'private reasoning', telemetry: { contentChars: 0, reasoningChars: 17 } });
    streamed(); return new Promise(resolve => { release = resolve; });
  });
  await f.author.author({ ...f.args, baseRevision: 1, requestId: 'streaming', text: 'Explain' }); await started;
  await f.author.ui({ ...f.args, ui: { composer: 'Next question' } });
  const during = f.author.read(f.args).requests[0];
  assert.equal(during.status, 'working'); assert.equal(during.progress.phase, 'thinking'); assert.equal(during.progress.reasoningChars, 17);
  assert.equal(during.attempts[0].status, 'working'); assert.equal(JSON.stringify(during).includes('private reasoning'), false);
  release(reply({ type: 'message', text: 'Ready.' })); await Promise.all([...f.author.deliveries]);
  assert.equal(f.author.read(f.args).requests[0].attempts[0].rawResponse, '{"type":"message","text":"Ready."}');
  assert.equal(f.author.read(f.args).ui.composer, 'Next question');
});

test('strict-schema encoded replacements use the normal scope validator', async t => {
  const f = await fixture(t, () => reply({ type: 'proposal', text: null, rationale: 'Scoped', name: null, arguments: null,
    operations: [{ op: 'replace', address: 'recipe/improve/config/instructions', valueText: 'New instructions', valueJson: null }] }));
  const request = await message(f, 'Improve the instruction', { scope: { type: 'step', address: 'recipe/improve' } });
  assert.equal(request.status, 'complete'); assert.equal(f.author.read(f.args).proposals[0].diff[0].after, 'New instructions');
  assert.equal(decodeAuthoringResponse({ operations: [{ valueJson: JSON.stringify('Older encoded string') }] }).operations[0].value, 'Older encoded string');
  assert.throws(() => decodeAuthoringResponse({ operations: [{ value: 'a', valueJson: '"b"' }] }), /Ambiguous/);
  assert.throws(() => decodeAuthoringResponse({ operations: [{ valueJson: '{broken' }] }), /JSON|property/);
});

test('only writable edit addresses are advertised, and the strict schema excludes internal graph fields', async t => {
  const f = await fixture(t);
  const grant = await f.author.grant({ ...f.args, baseRevision: 1, scope: { type: 'loop' } });
  const { definitions } = await f.goals.blocks();
  const contract = authoringEditContract(f.state.definition, grant, [], semanticFields(f.state.definition, await f.author.parser()), definitions, false);
  assert(contract.addresses.includes('recipe')); assert(contract.addresses.includes('goal/criteria'));
  assert(!contract.addresses.some(address => address.endsWith('/structure') || address.endsWith('/config') || address === 'recipe/goal-recipe/title'));
  assert.deepEqual(contract.values['goal/criteria'].examples[0], { type: 'output_contains', value: 'Audit summary' });
  const schema = authoringResponseFormat(contract.addresses).schema;
  assert.deepEqual(schema.properties.operations.items.properties.address.enum, contract.addresses);
  assert.deepEqual(schema.properties.arguments.properties.operations.items.properties.address.enum, contract.addresses);
  const scoped = authoringEditContract(f.state.definition, { ...grant, scope: { type: 'step', address: 'recipe/improve' } }, [f.address], semanticFields(f.state.definition, await f.author.parser()), definitions, false);
  assert(!scoped.addresses.includes('recipe')); assert(!scoped.addresses.includes(f.address));
  assert(scoped.addresses.every(address => address.startsWith('recipe/improve/')));
});

test('unavailable Goal tools fail draft validation so correction happens before proposal review', async t => {
  const f = await fixture(t);
  await assert.rejects(f.propose([replace('goal/tools', ['read_file', 'search_references'])], []), /Remove unavailable tools: search_references/);
  assert.equal(f.author.read(f.args).proposals.length, 0);
});

test('unsupported-format fallback is explicit, charged, and happens only once', async t => {
  let calls = 0;
  const f = await fixture(t, ({ disableStructuredOutput }) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('API 400 unsupported response_format'), { authoringFormatUnsupported: true });
    assert.equal(disableStructuredOutput, true);
    return reply({ type: 'message', text: 'Fallback answer' });
  });
  const request = await message(f, 'Explain');
  assert.equal(request.status, 'complete'); assert.equal(request.calls, 2);
  assert.match(request.attempts[0].error, /unsupported response_format/);
  assert.equal(f.author.read(f.args).unknownCostCalls, 1);
});

test('quoted A plus B is rejected atomically, including no-op parent replacement', async t => {
  const f = await fixture(t);
  const before = f.author.read(f.args);
  await assert.rejects(f.propose([replace(f.address, 'Better'), replace('goal/objective', 'Other')]), /EDIT_OUT_OF_SCOPE/);
  await assert.rejects(f.propose([replace('recipe', GOAL_RECIPE)]), /EDIT_OUT_OF_SCOPE/);
  const after = f.author.read(f.args);
  assert.equal(after.hash, before.hash); assert.equal(after.revision, before.revision); assert.equal(after.proposals.length, 0);
});
test('exact range preserves every surrounding character and stale quotes fail closed', async t => {
  const f = await fixture(t);
  const quote = { address: f.address, value: f.value, range: { start: 0, end: 4, text: 'Work' } };
  const proposal = await f.propose([replace(f.address, `Strive${f.value.slice(4)}`)], [quote]);
  assert.equal(proposal.diff.length, 1);
  await assert.rejects(f.propose([replace(f.address, `Strive${f.value.slice(4)} extra`)], [quote]), /EDIT_OUT_OF_SCOPE/);
  await assert.rejects(f.grant([{ ...quote, value: 'stale' }]), /STALE_QUOTE/);
  await assert.rejects(f.grant([{ ...quote, range: { start: 1, end: 5, text: 'Work' } }]), /STALE_QUOTE/);
});
test('locks reject whole-source, inherited binding and structural bypasses', async t => {
  const f = await fixture(t);
  await f.author.setLock({ ...f.args, baseRevision: 1, address: f.address, locked: true });
  await assert.rejects(f.propose([replace('recipe', GOAL_RECIPE.replace('Work toward', 'Proceed toward'))], []), /LOCKED_FIELD/);
  await assert.rejects(f.propose([replace('goal/worker', { provider: 'mock', model: 'another' })], []), /LOCKED_FIELD/);
  await assert.rejects(f.propose([replace('recipe', GOAL_RECIPE.replace('id: improve', 'id: replacement'))], []), /LOCKED_FIELD/);
  assert.equal(f.author.read(f.args).hash, f.state.hash);
});
test('acceptance is atomic, idempotent, persistent and stale approvals fail', async t => {
  const f = await fixture(t);
  const proposal = await f.propose([replace(f.address, 'Improve with evidence')]);
  assert.equal(f.author.read(f.args).definition.recipe, GOAL_RECIPE);
  assert.equal(f.author.read(f.args).proposals[0].status, 'pending');
  const args = { ...f.args, proposalId: proposal.id, decision: 'accept' };
  const accepted = await f.author.review(args);
  const repeated = await f.author.review(args);
  assert.equal(accepted.revision, 2); assert.deepEqual(repeated, accepted);
  const next = await f.propose([replace('goal/name', 'AI rename')], []);
  await f.author.edit({ ...f.args, baseRevision: 2, operations: [replace('goal/objective', 'Human change')] });
  await assert.rejects(f.author.review({ ...f.args, proposalId: next.id, decision: 'accept' }), /STALE_REVISION/);
  assert.equal(f.author.read(f.args).definition.name, 'A loop');
});
test('policy changes and expired grants invalidate proposals', async t => {
  const f = await fixture(t), grant = await f.grant();
  await f.author.setLock({ ...f.args, baseRevision: 1, address: 'goal/name', locked: true });
  await assert.rejects(f.author.propose({ ...f.args, grantId: grant.id, operations: [replace(f.address, 'changed')] }), /STALE_REVISION/);
  const state = f.author.read(f.args); state.grants[0].expires = 0; f.author.save(state);
  await assert.rejects(f.author.propose({ ...f.args, grantId: grant.id, operations: [replace(f.address, 'changed')] }), /GRANT_EXPIRED/);
});
test('parallel human writes compare the revision after acquiring the transaction', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled(['a', 'b'].map(value => f.author.edit({ ...f.args, baseRevision: 1, operations: [replace('goal/name', value)] })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /STALE_REVISION/);
});
test('authoring has no workspace side effects; submitted request survives UI saves', async t => {
  let release; const answer = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, () => answer);
  await f.author.author({ ...f.args, baseRevision: 1, requestId: 'request-1', text: 'Improve the instruction', quotes: [{ address: f.address, value: f.value }], worker: { model: 'mock' } });
  await f.author.ui({ ...f.args, ui: { composer: 'Next thought', quotes: [] } });
  assert.deepEqual(fs.readdirSync(f.workspace), []);
  release({ text: JSON.stringify({ operations: [replace(f.address, 'Better')], rationale: 'More precise' }), usage: { cost: 0.001 } });
  while (f.author.requests.size) await new Promise(resolve => setTimeout(resolve, 10));
  const state = f.author.read(f.args);
  assert.equal(state.requests[0].status, 'complete'); assert.equal(state.proposals[0].status, 'pending');
  assert.equal(state.ui.composer, 'Next thought'); assert.equal(state.authoringCalls, 1); assert.equal(state.knownUsd, 0.001);
  assert.equal(state.definition.recipe, GOAL_RECIPE);
});
test('publishing requires complete checks and resolved proposals, preserves pinned model', async t => {
  const f = await fixture(t);
  const proposal = await f.propose([replace(f.address, 'Do the task')]);
  await assert.rejects(f.author.publish({ ...f.args, baseRevision: 1 }), /REVIEW_REQUIRED/);
  await f.author.review({ ...f.args, proposalId: proposal.id, decision: 'accept' });
  const published = await f.author.publish({ ...f.args, baseRevision: 2 });
  const again = await f.author.publish({ ...f.args, baseRevision: 2 });
  assert.equal(published.goalId, again.goalId);
  const goal = f.goals.get('project', published.goalId);
  assert.equal(goal.contract.reviewAi, true); assert.equal(goal.contract.worker.model, 'model');
  assert.equal(fs.readdirSync(f.workspace).length, 0);
  await assert.rejects(f.author.edit({ ...f.args, baseRevision: 2, operations: [replace('goal/objective', 'bypass')] }), /LOCKED_FIELD/);
});
test('circle keeps parallel groups collapsed and exact canonical order', () => {
  const root = { children: [{ id: 'a', kind: 'block' }, { id: 'parallel', kind: 'parallel', children: [{ id: 'b' }, { id: 'c' }] }, { id: 'd', kind: 'block' }] };
  assert.deepEqual(loopNodes(root).map(node => node.id), ['a', 'parallel', 'd', '$verify']);
  assert.equal(loopNodes(root)[1].childCount, 2);
  assert.deepEqual(circlePositions(4), circlePositions(4));
  assert.equal(circlePositions(4)[0].y, 15);
  assert.equal(goalNodeStatus({ meta: { nodeStatus: { improve: 'done' } } }, { setupDone: true }, 'recipe', 'improve'), 'Done');
  assert.equal(goalNodeStatus({ meta: { blockStatus: { improve: 'active' } } }, {}, 'recipe', 'improve'), 'Running');
  assert.equal(goalNodeStatus({ meta: { nodeStatus: { improve: 'done' } } }, { activeChild: { phase: 'setup' } }, 'recipe', 'improve'), 'Not run in this view');
});

test('invalid field types never become renderable proposals or human drafts', async t => {
  const f = await fixture(t);
  for (const operation of [replace('goal/name', {}), replace('goal/criteria', null), replace('goal/tools', 'bash'), replace('goal/worker', []), replace('goal/limits', { iterations: -1 })]) {
    await assert.rejects(f.propose([operation], []), /INVALID_WORKFLOW/);
    await assert.rejects(f.author.edit({ ...f.args, baseRevision: 1, operations: [operation] }), /INVALID_WORKFLOW/);
  }
  assert.equal(f.author.read(f.args).revision, 1);
});
test('duplicate request submission invokes the model once and cancellation is explicit', async t => {
  let calls = 0;
  const f = await fixture(t, ({ signal }) => new Promise((resolve, reject) => { calls++; signal.addEventListener('abort', () => reject(new Error('Cancelled by user')), { once: true }); }));
  const args = { ...f.args, baseRevision: 1, requestId: 'same-request', text: 'Improve the instruction', quotes: [{ address: f.address, value: f.value }], worker: { model: 'mock' } };
  await Promise.all([f.author.author(args), f.author.author(args)]);
  while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
  f.author.cancel(args);
  while (f.author.requests.size) await new Promise(resolve => setTimeout(resolve, 5));
  const state = f.author.read(f.args);
  assert.equal(calls, 1); assert.equal(state.authoringCalls, 1); assert.equal(state.requests.length, 1);
  assert.match(state.requests[0].error, /Cancelled/); assert.equal(state.proposals.length, 0);
});
test('rejected proposals preserve baseline and no-op proposals create no badges', async t => {
  const f = await fixture(t);
  const noop = await f.propose([replace(f.address, f.value)]);
  assert.equal(noop.status, 'no_change'); assert.deepEqual(noop.diff, []);
  const changed = await f.propose([replace(f.address, 'Different')]);
  await f.author.review({ ...f.args, proposalId: changed.id, decision: 'reject' });
  assert.equal(f.author.read(f.args).hash, f.state.hash);
});
test('project identities containing punctuation are safely scoped on disk', async t => {
  const f = await fixture(t);
  f.goals.project = () => ({ id: 'project:windows/path', folder: f.workspace });
  const file = f.author.file('project:windows/path', f.state.id);
  assert.equal(path.dirname(path.dirname(file)), path.join(f.root, 'host'));
  await assert.rejects(f.author.open({ projectId: 'p', goalId: '../escape' }), /INVALID_ID/);
});

// --- deleting and renaming a draft -----------------------------------------
//
// The picker used to be a native select: every row read "My goal", nothing said
// which one you were on, and a draft once made could not be removed, so the list
// only grew. Renaming is an ordinary field edit and needed no new action;
// deleting is destructive and needed one, with the two refusals below.

test('a draft that never started can be deleted, and stops being listed', async t => {
  const f = await fixture(t);
  const { removed, name } = await f.author.remove(f.args);

  assert.equal(removed, f.args.draftId);
  assert.equal(name, 'A loop', 'the caller can say what it deleted, not just that it did');
  assert.deepEqual(f.author.list({ projectId: 'project' }).map(item => item.id), []);
  assert.throws(() => f.author.read(f.args), /ENOENT/, 'and the record is gone, not merely hidden');
});

test('the record of a started Goal is never deleted with its draft', async t => {
  // The contract, the history and the revision it is running live in here, and
  // the Goal has no second copy of them.
  const f = await fixture(t);
  const state = f.author.read(f.args);
  state.goalId = 'goal-1'; f.author.save(state);

  await assert.rejects(f.author.remove(f.args), /LOCKED_RECORD/);
  assert.ok(f.author.read(f.args), 'the draft is still there');
});

test('a draft with an AI request in flight refuses to be deleted', async t => {
  // Deleting under a working request turns a call somebody is paying for into
  // an error nobody asked for.
  const f = await fixture(t);
  const state = f.author.read(f.args);
  state.requests.push({ id: 'r1', status: 'working', pid: process.pid });
  f.author.save(state);
  // A 'working' request whose process is gone is downgraded on read, which is
  // right — a stale flag must not make a draft undeletable forever. So the live
  // one is registered the way an actual in-flight call registers itself.
  f.author.requests.set(`${state.id}:r1`, new AbortController());

  await assert.rejects(f.author.remove(f.args), /DRAFT_BUSY/);
  assert.ok(f.author.read(f.args));
});

test('renaming is the same edit the name field makes, and keeps its history', async t => {
  const f = await fixture(t);
  const before = f.author.read(f.args);
  const after = await f.author.edit({
    ...f.args, baseRevision: before.revision,
    operations: [replace('goal/name', 'Ship the parser')]
  });

  assert.equal(after.definition.name, 'Ship the parser');
  assert.equal(after.revision, before.revision + 1, 'a rename is a revision like any other edit');
  assert.equal(after.history.at(-1).author, 'human');
  assert.equal(f.author.list({ projectId: 'project' })[0].name, 'Ship the parser',
    'and the picker sees it without reopening the draft');
});

test('a started instance refuses a rename, which is why the button is not offered', async t => {
  const f = await fixture(t);
  const state = f.author.read(f.args);
  state.goalId = 'goal-1'; f.author.save(state);

  await assert.rejects(f.author.edit({
    ...f.args, baseRevision: f.author.read(f.args).revision,
    operations: [replace('goal/name', 'Too late')]
  }), /LOCKED_FIELD/);
});
