// The shipped Node Library must be able to do the coding loop (V1 task 12).
// V1 tasks 2/3 built read_file/create_file/write_file/bash and wired them into
// the agent loop, but no shipped template granted them and the "work" templates
// were toolless aiSteps — so out of the box the coding agent could neither read
// a repo nor run a test. These pin the library's shape and its safety defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SEED_NODE_TEMPLATES, AGENT_TOOLS } from '../src/flowTypes.js';
import { DESTRUCTIVE_TOOLS } from '../core/tools/index.js';

const seed = id => SEED_NODE_TEMPLATES.find(t => t.id === id);
const onDisk = id => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'nodes', `${id}.json`), 'utf8'));

// An aiStep calls the model directly and never enters the agent loop, so it can
// never hold a tool. A work template that cannot touch files cannot do the work.
test('every work template is an agentTask that can reach the project', () => {
  for (const id of ['code-general-step', 'code-design-step', 'documentation-step', 'test-creation-step']) {
    const t = seed(id);
    assert.equal(t.baseType, 'agentTask', `${id} must be an agentTask: an aiStep cannot hold tools`);
    assert.ok(t.tools?.includes('read_file'), `${id} must be able to read the project`);
  }
});

// The trap this closes: code-design-step shipped read-only, the planner handed
// it "Implement and export tag filtering", and the node — holding no write tool
// — produced a spec, reported success, and the feature was never written. A work
// template that cannot do the work it is handed fails silently and totally, so
// no work template may be unable to write.
test('every work template can write: a node that cannot do its job fails silently', () => {
  for (const id of ['code-general-step', 'code-design-step', 'documentation-step', 'test-creation-step']) {
    const t = seed(id);
    assert.ok(t.tools.includes('write_file'), `${id} is handed work; it must be able to write it`);
  }
});

// The node that owns the test suite must not report success over a red one.
test('test-creation-step is instructed not to finish on a failing suite', () => {
  const t = seed('test-creation-step');
  assert.match(t.instructions, /non-zero exit/i);
  assert.match(t.instructions, /[Nn]ever report the task complete while the suite is failing/);
});

test('the library can write code and run a command somewhere', () => {
  const granted = new Set(SEED_NODE_TEMPLATES.flatMap(t => t.tools ?? []));
  assert.ok(granted.has('write_file'), 'nothing could write to the project');
  assert.ok(granted.has('bash'), 'nothing could run tests or a build');
  for (const t of granted) assert.ok(AGENT_TOOLS.includes(t), `unknown tool granted: ${t}`);
});

// bash only STARTS in the workspace and can cd out (core/tools/bash.js says so);
// the approval gate is its only guard. Writes, by contrast, resolve through
// Workspace.resolve() and genuinely cannot escape.
test('every template granting bash ships gated', () => {
  for (const t of SEED_NODE_TEMPLATES) {
    if (t.tools?.includes('bash')) {
      assert.equal(t.approveToolCalls, true,
        `${t.id} grants bash, which is not path-confined — it must ask before running commands`);
    }
  }
});

// Writes go through Workspace.resolve() and cannot escape the project, so a
// write-only template needs no gate and keeps fanning out in parallel — only
// bash, which is not confined, serializes behind approvals.
test('templates that write but cannot run commands stay ungated and parallel-safe', () => {
  for (const id of ['code-general-step', 'code-design-step', 'documentation-step']) {
    const t = seed(id);
    assert.ok(!t.tools.includes('bash'), `${id} should not need a shell`);
    assert.equal(t.approveToolCalls, false, `${id} writes are confined; gating it would serialize work for nothing`);
  }
});

// nodes/*.json is the live source of truth; the seed only writes them on a fresh
// install. They had drifted apart — the seed granted test-creation-step every
// tool (bash included, ungated) while the on-disk file granted three.
test('the shipped template files match the seed they came from', () => {
  for (const t of SEED_NODE_TEMPLATES) {
    const f = onDisk(t.id);
    assert.equal(f.baseType, t.baseType, `${t.id}: baseType drifted`);
    assert.deepEqual(f.tools, t.tools, `${t.id}: tools drifted`);
    assert.equal(f.approveToolCalls, t.approveToolCalls, `${t.id}: approval default drifted`);
  }
});
