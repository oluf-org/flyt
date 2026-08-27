// A contributed tool's classification, inferred (t-0111, D57).
//
// A plugin's tools arrive unclassified and ungranted, in no toolset, reachable
// by no ceiling. Before a human can confirm or edit a classification there has
// to BE one to show them, and this is where it comes from.
//
// The direction of doubt is the whole design: every unknown resolves UPWARD.
// The symptom of a wrong guess must be a tool that refuses and a person who
// notices, never a tool that runs and nobody does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyContributedTool, atLeastAsStrict, widerEffect } from '#kernel/plugins/classify.js';
import { SEAM_NAMES } from '#kernel/seams/index.js';
import { createKernel } from '#kernel';
import * as flytTools from '#kernel/plugins/tools.js';
import * as flytApprovals from '#kernel/plugins/approvals.js';

const read = { effect: 'read', destructive: false, untrustedInput: false, source: 'inferred' };

test('a tool holding no seam and saying nothing is read-only', () => {
  assert.deepEqual(classifyContributedTool(), read);
  assert.deepEqual(classifyContributedTool({ name: 'count_lines' }, []), read);
});

test('a seam is read as its ceiling, not as what the plugin means to call', () => {
  // `fs` is write because an injected FsSeam HAS write() on it, whether or not
  // this tool calls it. The alternative is trusting a plugin's account of which
  // methods it intends to use.
  assert.equal(classifyContributedTool({}, ['fs']).effect, 'write');
  assert.equal(classifyContributedTool({}, ['fs']).destructive, false);

  const shell = classifyContributedTool({}, ['shell']);
  assert.equal(shell.effect, 'shell');
  assert.equal(shell.destructive, true);

  // An LLM response is text from outside the workspace, by definition.
  assert.equal(classifyContributedTool({}, ['llm']).untrustedInput, true);
  assert.equal(classifyContributedTool({}, ['llm']).effect, 'read', 'but it writes nothing');
});

test('every seam the kernel has is accounted for, and an unknown one is the widest', () => {
  // The check that stops this module going stale. A seam added to SEAM_NAMES
  // and not taught here still classifies — as the worst thing there is — so the
  // failure mode of forgetting is a tool nobody can use rather than one nobody
  // checked.
  for (const seam of SEAM_NAMES) {
    const c = classifyContributedTool({}, [seam]);
    assert.ok(['read', 'write', 'shell'].includes(c.effect), seam);
    assert.equal(c.source, 'inferred');
  }
  const unknown = classifyContributedTool({}, ['a-seam-from-the-future']);
  assert.deepEqual(unknown,
    { effect: 'shell', destructive: true, untrustedInput: true, source: 'inferred' });
});

test('a plugin\'s own claim is a floor and never a ceiling', () => {
  // A plugin claiming `read` on a tool holding the fs seam gets no benefit from
  // the claim — the same rule v1 applies to an untrusted MCP server's
  // readOnlyHint on a tool named delete_everything.
  const lying = classifyContributedTool(
    { classification: { effect: 'read', destructive: false, untrustedInput: false } }, ['shell']);
  assert.equal(lying.effect, 'shell');
  assert.equal(lying.destructive, true);

  // Claiming MORE than the seams imply is believed, because it is stricter.
  const honest = classifyContributedTool({ classification: { destructive: true } }, []);
  assert.equal(honest.destructive, true);
  assert.equal(honest.effect, 'write', 'destroying something is at least writing');
});

test('what a tool calls itself can only ever add', () => {
  // Reading a plugin's own prose is safe precisely because it is one-way: the
  // worst a lie can do is under-claim, and under-claiming changes nothing.
  const named = classifyContributedTool({ name: 'delete_branch', description: 'Removes a branch.' }, []);
  assert.equal(named.destructive, true);
  assert.equal(named.effect, 'write');

  const fetches = classifyContributedTool({ name: 'fetch_page', description: 'Downloads a URL.' }, []);
  assert.equal(fetches.untrustedInput, true);

  // And a harmless name does not talk a seam down.
  const quiet = classifyContributedTool({ name: 'peek', description: 'Just looks.' }, ['shell']);
  assert.equal(quiet.effect, 'shell');
  assert.equal(quiet.destructive, true);
});

test('it never resolves downward — enumerated, not sampled', () => {
  // The property the module exists to have. Over every subset of seams up to
  // size two, adding ANY seam or ANY claim may only make the result stricter.
  const subsets = [[]];
  for (const a of SEAM_NAMES) {
    subsets.push([a]);
    for (const b of SEAM_NAMES) if (a !== b) subsets.push([a, b]);
  }

  for (const seams of subsets) {
    const base = classifyContributedTool({}, seams);
    for (const extra of SEAM_NAMES) {
      const more = classifyContributedTool({}, [...seams, extra]);
      assert.ok(atLeastAsStrict(more, base),
        `adding "${extra}" to [${seams}] made it looser: ${JSON.stringify(more)} vs ${JSON.stringify(base)}`);
    }
    for (const claim of [
      { effect: 'read' }, { effect: 'write' }, { effect: 'shell' },
      { destructive: true }, { destructive: false },
      { untrustedInput: true }, { untrustedInput: false }
    ]) {
      const claimed = classifyContributedTool({ classification: claim }, seams);
      assert.ok(atLeastAsStrict(claimed, base),
        `claiming ${JSON.stringify(claim)} on [${seams}] made it looser`);
    }
    for (const said of ['delete everything', 'fetch a url', 'nothing in particular']) {
      assert.ok(atLeastAsStrict(classifyContributedTool({ description: said }, seams), base),
        `saying "${said}" on [${seams}] made it looser`);
    }
  }
});

test('classification is not a grant', () => {
  // Everything this module produces is `inferred`, and an inferred tool is in
  // no toolset and reachable by no ceiling. Only a person produces
  // `confirmed`, in the pass this feeds (t-0112).
  for (const seams of [[], ['fs'], ['shell'], ['llm', 'agents']]) {
    assert.equal(classifyContributedTool({}, seams).source, 'inferred');
  }
  assert.equal(
    classifyContributedTool({ classification: { source: 'confirmed' } }, []).source,
    'inferred',
    'a plugin cannot confirm itself');
});

test('atLeastAsStrict is the comparison the confirm pass will need', () => {
  const strict = { effect: 'shell', destructive: true, untrustedInput: true };
  const loose = { effect: 'read', destructive: false, untrustedInput: false };
  assert.ok(atLeastAsStrict(strict, loose));
  assert.ok(!atLeastAsStrict(loose, strict));
  assert.ok(atLeastAsStrict(loose, loose), 'equal counts as at least as strict');

  assert.equal(widerEffect('read', 'shell'), 'shell');
  assert.equal(widerEffect('write', 'read'), 'write');
});

// --- proposing is not applying ----------------------------------------------
//
// The invariant this must not break, and nearly did: absence of a
// classification is what the permission bridge REFUSES on. A first version
// classified on register(), so no tool was ever unclassified, and the gate that
// exists to catch exactly that could never fire. The suite caught it.
//
// So the inference produces a PROPOSAL. The tool stays unclassified and
// unreachable until a person confirms, which is the only step that was ever
// going to involve one.

const withTool = async (tool, run) => {
  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(flytTools);
    kernel.ctx.tools.register({
      description: '', parameters: {}, async execute() { return { content: 'ran' }; }, ...tool
    });
    return await run(kernel.ctx.tools);
  } finally { await kernel.dispose(); }
};

test('a proposal leaves the tool unclassified, and therefore unreachable', async () => {
  await withTool({ name: 'mystery' }, tools => {
    const proposed = tools.propose('mystery', ['shell']);
    assert.equal(proposed.effect, 'shell');
    assert.equal(proposed.source, 'inferred');
    assert.equal(tools.get('mystery').classification, undefined,
      'proposing must not classify — the gate refuses on the absence');
  });
});

test('there is nothing to propose about a decision already taken', async () => {
  await withTool(
    { name: 'settled', classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' } },
    tools => assert.equal(tools.propose('settled', ['shell']), null));
  await withTool({ name: 'x' }, tools => assert.equal(tools.propose('nobody', []), null));
});

test('confirming applies it, and says a human did', async () => {
  await withTool({ name: 'writer' }, tools => {
    const proposed = tools.propose('writer', ['fs']);
    tools.classify('writer', proposed, ['fs']);
    const applied = tools.get('writer').classification;
    assert.equal(applied.effect, 'write');
    assert.equal(applied.source, 'confirmed', 'inferred is not confirmation');
  });
});

test('an edit may make it stricter and never looser', async () => {
  // Without this, "edit" is a way to grant by hand exactly what the inference
  // declined to grant — which is the whole thing D57 is guarding.
  await withTool({ name: 'runner' }, tools => {
    const stricter = { effect: 'shell', destructive: true, untrustedInput: true, source: 'confirmed' };
    tools.classify('runner', stricter, ['fs']);
    assert.equal(tools.get('runner').classification.effect, 'shell');
  });

  await withTool({ name: 'sneaky' }, tools => {
    assert.throws(
      () => tools.classify('sneaky',
        { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
        ['shell']),
      /cannot be classified more loosely than it was inferred/);
    assert.equal(tools.get('sneaky').classification, undefined, 'and it stays unreachable');
  });
});

test('classifying a tool nobody registered is an error, not a silent no-op', async () => {
  await withTool({ name: 'real' }, tools => {
    assert.throws(
      () => tools.classify('imaginary', { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' }),
      /No tool named "imaginary" is registered/);
  });
});

// --- the attended installation boundary (t-0112) ---------------------------

const contributedPlugin = (ran, tools = [{
  name: 'package_tool', description: 'A tool from a package.', parameters: {},
  async execute() { ran.push('tool'); return { content: 'ran' }; },
}]) => ({
  name: 'third-party-package', inject: ['tools'],
  apply(ctx) { ran.push('plugin'); for (const tool of tools) ctx.tools.register(tool); },
});

test('an unattended plugin install refuses before plugin code executes', async () => {
  const kernel = createKernel();
  const ran = [];
  try {
    await kernel.ctx.plugin(flytTools);
    await assert.rejects(
      () => flytTools.installPlugin(kernel.ctx, contributedPlugin(ran)),
      /requires an attended human classification review/);
    assert.deepEqual(ran, [], 'refusal happens before apply(), not after an untrusted side effect');
    assert.equal(kernel.ctx.tools.get('package_tool'), undefined);
  } finally { await kernel.dispose(); }
});

test('declining keeps the plugin installed but its tools unclassified and unreachable', async () => {
  const kernel = createKernel();
  const ran = [];
  let shown;
  try {
    await kernel.ctx.plugin(flytTools);
    await kernel.ctx.plugin(flytApprovals, { mode: 'always' });
    await flytTools.installPlugin(kernel.ctx, contributedPlugin(ran), {
      attended: true,
      decide(proposals) {
        shown = proposals;
        return Object.fromEntries(proposals.map(p => [p.name, null]));
      },
    });

    assert.deepEqual(ran, ['plugin'], 'the installed plugin remains active');
    assert.equal(shown.length, 1, 'all contributed tools are shown in one pass');
    assert.deepEqual(shown[0].requested, ['tools'], 'what the plugin asked for is visible');
    assert.deepEqual(shown[0].inferredFrom.seams, ['tools'], 'the exact inference evidence is visible');
    assert.match(shown[0].permits, /eligible for a later, explicit ceiling grant/);
    assert.match(shown[0].doesNotPermit, /execution.*toolset.*ceiling/);
    assert.equal(kernel.ctx.tools.get('package_tool').classification, undefined);

    const result = await kernel.ctx.tools.execute({
      runId: 'r', blockId: 'b', step: 1,
      call: { id: 'c', name: 'package_tool', args: {} }, ceiling: ['package_tool'],
    });
    assert.match(result.error, /unclassified/);
    assert.deepEqual(ran, ['plugin'], 'declining never calls the tool');
  } finally { await kernel.dispose(); }
});

test('the install pass rejects a looser edit atomically', async () => {
  const kernel = createKernel();
  const ran = [];
  const claimedShell = name => ({
    name, description: '', parameters: {},
    classification: { effect: 'shell', destructive: true, untrustedInput: false, source: 'confirmed' },
    async execute() { return { content: 'ran' }; },
  });
  try {
    await kernel.ctx.plugin(flytTools);
    await assert.rejects(
      () => flytTools.installPlugin(kernel.ctx,
        contributedPlugin(ran, [claimedShell('first'), claimedShell('second')]), {
          attended: true,
          decide: proposals => ({
            first: proposals[0],
            second: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
          }),
        }),
      /"second" cannot be classified more loosely/);
    assert.equal(kernel.ctx.tools.get('first').classification, undefined,
      'validation finishes before any decision is applied');
    assert.equal(kernel.ctx.tools.get('second').classification, undefined);
  } finally { await kernel.dispose(); }
});

test('a confirmed tool still leaves when its plugin is disposed', async () => {
  const kernel = createKernel();
  const ran = [];
  try {
    await kernel.ctx.plugin(flytTools);
    const fiber = await flytTools.installPlugin(kernel.ctx, contributedPlugin(ran), {
      attended: true,
      decide: proposals => ({ package_tool: proposals[0] }),
    });
    assert.equal(kernel.ctx.tools.get('package_tool').classification.source, 'confirmed');
    await fiber.dispose();
    assert.equal(kernel.ctx.tools.get('package_tool'), undefined,
      'classification must not sever the registry disposer from its plugin');
  } finally { await kernel.dispose(); }
});
