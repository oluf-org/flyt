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

test('a read-only template holds no destructive tool, so it stays ungated and parallel-safe', () => {
  const design = seed('code-design-step');
  assert.equal(design.approveToolCalls, false);
  for (const tool of design.tools) {
    assert.ok(!DESTRUCTIVE_TOOLS.has(tool), `code-design-step must stay read-only, got ${tool}`);
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
