// Grants and ceilings (TOOLS-PLAN P3/§6). The invariant under test: no
// mechanism may grant a tool the authoring surface did not already permit —
// not a toolset, not an orchestrator, not a template default.
//
// The regression that matters most is the MIGRATION PROMISE: absent a ceiling,
// the ceiling is the static grant, so every flow authored before ceilings
// existed keeps exactly its envelope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, resolveGrant, narrowCeiling, expandRefs } from '../src/toolGrants.js';
import { normalizeToolset, SEED_TOOLSETS } from '../core/toolsets.js';
import { normalizeTool } from '../src/toolTypes.js';
import { builtinDefinitions } from '../core/tools/builtins.js';
import { lintFlow } from '../core/flowlang/lint.js';
import { SEED_NODE_TEMPLATES, normalizeTemplate, resolveInstance } from '../src/flowTypes.js';
import { runExecutorTask } from '../core/nodes/executor.js';
import { ToolStore } from '../core/toolstore.js';
import { makeStore, setScript, testConfig } from './helpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const library = builtinDefinitions().map(normalizeTool);
const sets = SEED_TOOLSETS.map(normalizeToolset);
const ctx = makeContext({ library, sets });
const ids = r => r.tools.slice().sort();

test('selectors resolve by what a tool IS, not by a list someone maintains', () => {
  // effects:read is a SUBSET test — a tool that also writes can never sneak in.
  const readOnly = [...expandRefs('effects:read', ctx).ids].sort();
  assert.deepEqual(readOnly, ['glob', 'list_tasks', 'read_file', 'read_run', 'read_task', 'read_tool_result', 'search_references', 'why_blocked']);
  assert.ok(!readOnly.includes('write_file'));

  // Trust follows the SOURCE, and for the two web tools the source of the
  // CONTENT is the public internet — so `trust:trusted` is now a real filter
  // rather than a synonym for the whole library.
  assert.deepEqual([...expandRefs('trust:trusted', ctx).ids].sort(),
    library.filter(t => t.trust === 'trusted').map(t => t.id).sort());
  assert.deepEqual([...expandRefs('trust:untrusted', ctx).ids].sort(), ['web_fetch', 'web_search']);
  assert.deepEqual([...expandRefs('provider:mcp', ctx).ids], []);
  assert.equal(expandRefs('*', ctx).ids.size, library.length);

  // `uses:` is the membership twin: "can reach the network" rather than
  // "reaches nothing beyond the network". Using the subset test here would
  // sweep in every read-only tool.
  assert.deepEqual([...expandRefs('uses:write', ctx).ids].sort(),
    ['ask_human', 'create_file', 'create_task', 'edit_file', 'enqueue_task', 'update_task', 'write_file', 'write_task_md']);
  // The web set was declared and empty for its whole life; LOOP-BOARD §A5
  // filled it, and the membership test is what picks its members out.
  assert.deepEqual([...expandRefs('uses:network', ctx).ids].sort(), ['web_fetch', 'web_search']);
  assert.deepEqual([...expandRefs('web', ctx).ids].sort(), ['web_fetch', 'web_search']);
  assert.ok(![...expandRefs('web', ctx).ids].includes('read_file'),
    'the web set is "anything that can reach the network", not "everything that only reads"');

  const bad = expandRefs('effects:teleport', ctx);
  assert.deepEqual([...bad.ids], []);
  assert.equal(bad.problems[0].kind, 'unknown-selector');
});

// The bug this pins: ToolStore handed the linter { library, sets } while the
// linter read { tools, sets }, so every ceiling rule ran against an EMPTY
// library and quietly found nothing wrong. A rule that can't see the library
// must skip loudly (the test below) — never pass silently.
test('the store\'s catalog is the shape the linter reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-catalog-'));
  const cat = new ToolStore(dir).catalog();
  assert.ok(Array.isArray(cat.tools) && cat.tools.length, 'catalog().tools');
  assert.ok(cat.sets.some(s => s.id === 'read-only'), 'catalog().sets');
  const r = lintFlow(flowWith([
    { id: 'w', templateId: 'work', overrides: { toolCeiling: 'read-only', tools: ['bash'] } }
  ]), { templates, library: cat });
  assert.ok(r.findings.some(f => f.rule === 'grant-exceeds-ceiling'),
    'the library the store hands over must actually be usable by the linter');
});

test('toolsets compose, exclude wins, and a cycle degrades instead of hanging', () => {
  assert.deepEqual([...expandRefs('read-only', ctx).ids].sort(), ['glob', 'list_tasks', 'read_file', 'read_run', 'read_task', 'read_tool_result', 'search_references', 'why_blocked']);
  // repo-write includes read-only and every write tool, minus bash.
  const repoWrite = [...expandRefs('repo-write', ctx).ids].sort();
  assert.ok(repoWrite.includes('write_file') && repoWrite.includes('read_file'));
  assert.ok(!repoWrite.includes('bash'), 'exclude is applied after include and wins');
  assert.ok([...expandRefs('repo-full', ctx).ids].includes('bash'));
  assert.deepEqual([...expandRefs('none', ctx).ids], []);

  const cyclic = makeContext({
    library,
    sets: [
      normalizeToolset({ id: 'a', includeSets: ['b'], include: ['read_file'] }),
      normalizeToolset({ id: 'b', includeSets: ['a'], include: ['bash'] })
    ]
  });
  const out = expandRefs('a', cyclic);
  assert.ok(out.problems.some(p => p.kind === 'cycle'));
  assert.ok([...out.ids].includes('read_file'), 'what it did reach still resolves');
});

test('the grant is intersected with the ceiling, and exceeding it is REFUSED, not merely absent', () => {
  const r = resolveGrant({ grant: ['read_file', 'bash'], ceiling: 'read-only', ctx });
  assert.deepEqual(ids(r), ['read_file']);
  assert.deepEqual(r.refused, [{ tool: 'bash', reason: 'ceiling' }]);
  assert.deepEqual(r.missing, []);
});

test('MIGRATION: absent a ceiling, the ceiling IS the static grant', () => {
  const r = resolveGrant({ grant: ['read_file', 'write_file'], ceiling: null, ctx });
  assert.deepEqual(ids(r), ['read_file', 'write_file']);
  assert.deepEqual(r.refused, []);
  // ...and a node with neither is bounded only by the library, exactly as
  // before ceilings existed.
  const all = resolveGrant({ grant: null, ceiling: null, ctx });
  assert.deepEqual(ids(all), library.map(t => t.id).sort());
});

test('an absent grant means everything the ceiling allows', () => {
  assert.deepEqual(ids(resolveGrant({ grant: null, ceiling: 'read-only', ctx })), ['glob', 'list_tasks', 'read_file', 'read_run', 'read_task', 'read_tool_result', 'search_references', 'why_blocked']);
  assert.deepEqual(ids(resolveGrant({ grant: null, ceiling: 'none', ctx })), []);
});

test('a missing or disabled tool degrades the node; it never fails the resolution', () => {
  const withDisabled = makeContext({
    library: library.map(t => (t.id === 'bash' ? { ...t, enabled: false } : t)),
    sets
  });
  const r = resolveGrant({ grant: ['read_file', 'bash', 'no_such_tool'], ctx: withDisabled });
  assert.deepEqual(ids(r), ['read_file']);
  assert.deepEqual(r.missing.sort((a, b) => a.tool.localeCompare(b.tool)), [
    { tool: 'bash', reason: 'disabled' },
    { tool: 'no_such_tool', reason: 'unknown' }
  ]);
  assert.deepEqual(r.refused, []);
});

test('an orchestrator child narrows its parent, and can never widen it', () => {
  // Declares nothing → inherits verbatim, so the canvas still reads "repo-write".
  assert.equal(narrowCeiling('repo-write', null, ctx), 'repo-write');
  // Narrows → keeps only what both allow.
  assert.deepEqual(narrowCeiling('repo-write', 'read-only', ctx).sort(), ['glob', 'list_tasks', 'read_file', 'read_run', 'read_task', 'read_tool_result', 'search_references', 'why_blocked']);
  // Tries to widen → the parent still wins; bash never appears.
  const widened = narrowCeiling('repo-write', 'repo-full', ctx);
  assert.ok(!widened.includes('bash'), 'a child cannot decide it may do more than its parent');
  assert.ok(widened.includes('write_file'));
  // No parent ceiling → the child's own stands.
  assert.equal(narrowCeiling(null, 'read-only', ctx), 'read-only');
});

// --- the lint rules ---------------------------------------------------------

const templates = SEED_NODE_TEMPLATES.map(normalizeTemplate);
const lintLibrary = { tools: library, sets };
const flowWith = nodes => ({
  id: 'p', name: 'P',
  nodes: [{ id: 'input', type: 'input', data: {} }, ...nodes, { id: 'output', type: 'output', data: {} }],
  edges: [
    ...nodes.map(n => ({ id: `e-in-${n.id}`, source: 'input', target: n.id })),
    ...nodes.map(n => ({ id: `e-out-${n.id}`, source: n.id, target: 'output' }))
  ]
});
const rulesOf = r => r.findings.map(f => f.rule);

test('lint: grant-exceeds-ceiling names the tool and the ceiling that refused it', () => {
  const r = lintFlow(flowWith([
    { id: 'w', templateId: 'work', overrides: { toolCeiling: 'read-only', tools: ['read_file', 'bash'] } }
  ]), { templates, library: lintLibrary });
  const hit = r.findings.find(f => f.rule === 'grant-exceeds-ceiling');
  assert.ok(hit, `expected grant-exceeds-ceiling in [${rulesOf(r)}]`);
  assert.match(hit.message, /bash/);
  assert.match(hit.message, /read-only/);
  assert.equal(r.ok, false);
});

test('lint: unknown-toolset, and broad-ceiling warns rather than blocks', () => {
  const unknown = lintFlow(flowWith([
    { id: 'w', templateId: 'work', overrides: { toolCeiling: 'no-such-set' } }
  ]), { templates, library: lintLibrary });
  assert.ok(unknown.findings.some(f => f.rule === 'unknown-toolset'));
  assert.equal(unknown.ok, false);

  const broad = lintFlow(flowWith([
    { id: 'w', templateId: 'work', overrides: { toolCeiling: '*' } }
  ]), { templates, library: lintLibrary });
  const warn = broad.findings.find(f => f.rule === 'broad-ceiling');
  assert.ok(warn);
  assert.equal(warn.severity, 'warning');
  assert.equal(broad.ok, true, 'a wide ceiling is legal — loud, but legal');
});

test('lint: a child inside an orchestrator cannot exceed its box', () => {
  const flow = {
    id: 'p', name: 'P',
    nodes: [
      { id: 'input', type: 'input', data: {} },
      { id: 'box', type: 'orchestrator', kind: 'ai', data: { toolCeiling: 'read-only' } },
      { id: 'child', templateId: 'work', parentId: 'box', overrides: { toolCeiling: 'repo-full' } },
      { id: 'output', type: 'output', data: {} }
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'box' },
      { id: 'e2', source: 'box', target: 'output' }
    ]
  };
  const r = lintFlow(flow, { templates, library: lintLibrary });
  const hit = r.findings.find(f => f.rule === 'child-exceeds-parent');
  assert.ok(hit, `expected child-exceeds-parent in [${rulesOf(r)}]`);
  assert.match(hit.message, /box/);
});

test('lint: an aiStep may hold read-effect tools, and only those', () => {
  const ok = lintFlow(flowWith([
    { id: 'p1', templateId: 'plan-start', overrides: { tools: ['read_file'] } }
  ]), { templates, library: lintLibrary });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));

  const bad = lintFlow(flowWith([
    { id: 'p1', templateId: 'plan-start', overrides: { tools: ['write_file'] } }
  ]), { templates, library: lintLibrary });
  const hit = bad.findings.find(f => f.rule === 'readonly-tools');
  assert.ok(hit, `expected readonly-tools in [${rulesOf(bad)}]`);
  assert.equal(bad.ok, false);
});

test('lint: the ceiling rules skip rather than guess when the library is unavailable', () => {
  const r = lintFlow(flowWith([
    { id: 'w', templateId: 'work', overrides: { toolCeiling: 'no-such-set', tools: ['bash'] } }
  ]), { templates });
  assert.ok(!rulesOf(r).some(rule => ['unknown-toolset', 'grant-exceeds-ceiling', 'readonly-tools'].includes(rule)));
});

// --- at run time -------------------------------------------------------------

test('a refused grant never reaches the model, and shows up as a problem, not an absence', async () => {
  const store = makeStore();
  const runId = store.createRun('narrow the envelope');
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Read something', goal: 'Read a file.',
    inputs: ['prompt.md'], constraints: [],
    tools: ['read_file', 'bash'], toolCeiling: 'read-only',
    worker: { provider: 'script', model: 'test-model' }, status: 'pending'
  }] });

  let offered = null;
  setScript(({ system }) => {
    offered = [...String(system).matchAll(/^- (\w+):/gm)].map(m => m[1]);
    return '## Done\nRead it.';
  });

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());
  assert.equal(retro.status, 'success');
  assert.ok(offered.includes('read_file'));
  assert.ok(!offered.includes('bash'), 'a refused tool is never even described to the model');

  const log = store.readLog(runId);
  const resolved = log.find(e => e.event === 'tool_resolved');
  assert.deepEqual(resolved.tools, ['read_file']);
  assert.deepEqual(log.filter(e => e.event === 'tool_grant_refused').map(e => e.tool), ['bash']);
  assert.ok(retro.problems.some(p => /bash/.test(p) && /refused/i.test(p)),
    `a refusal must be visible on the retrospective, got ${JSON.stringify(retro.problems)}`);
});

test('without a ceiling a task keeps its exact pre-P3 envelope', async () => {
  const store = makeStore();
  const runId = store.createRun('unchanged');
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Work', goal: 'Do it.', inputs: ['prompt.md'], constraints: [],
    tools: ['read_file', 'write_file', 'bash'],
    worker: { provider: 'script', model: 'test-model' }, status: 'pending'
  }] });
  setScript(() => '## Done');
  await runExecutorTask(store, runId, 'task-1', testConfig());
  const resolved = store.readLog(runId).find(e => e.event === 'tool_resolved');
  assert.deepEqual(resolved.tools.sort(), ['bash', 'read_file', 'write_file']);
  assert.deepEqual(store.readLog(runId).filter(e => e.event === 'tool_grant_refused'), []);
});

test('the ceiling reaches the resolved node, so the runner can carry it onto the task', () => {
  const work = templates.find(t => t.id === 'work');
  const node = resolveInstance({ id: 'w', templateId: 'work', overrides: { toolCeiling: 'repo-write' } }, work);
  assert.equal(node.data.toolCeiling, 'repo-write');
  // A template that declares none leaves it absent — the migration promise
  // lives in the ABSENCE, not in a materialized default.
  const plain = resolveInstance({ id: 'w2', templateId: 'work', overrides: {} }, work);
  assert.equal(plain.data.toolCeiling, undefined);
});
