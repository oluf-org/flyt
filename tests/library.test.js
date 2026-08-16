// The shipped Node Library must be able to do the coding loop (V1 task 12).
// V1 tasks 2/3 built read_file/create_file/write_file/bash and wired them into
// the agent loop, but no shipped template granted them and the "work" templates
// were toolless aiSteps — so out of the box the coding agent could neither read
// a repo nor run a test. After the node rework the work templates are ONE
// combined Work node whose task type (category) derives the tool grant
// (WORK_TOOLS in src/flowTypes.js) — these pin that shape and its safety
// defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SEED_NODE_TEMPLATES, AGENT_TOOLS, WORK_CATEGORIES, WORK_TOOLS, resolveInstance
} from '../src/flowTypes.js';

const seed = id => SEED_NODE_TEMPLATES.find(t => t.id === id);
const onDisk = id => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'nodes', `${id}.json`), 'utf8'));

// A Work node resolved to one task type — the shape the runner executes.
const workNode = category =>
  resolveInstance({ id: 'w', templateId: 'work', position: { x: 0, y: 0 }, overrides: { category } }, seed('work'));

// An aiStep calls the model directly and never enters the agent loop, so it can
// never hold a tool. The work node must be an agentTask, and every task type
// must be able to read AND write — a work node that cannot do the work it is
// handed fails silently and totally (the code-design-step lesson).
test('the Work node is an agentTask; every task type can read and write the project', () => {
  assert.equal(seed('work').baseType, 'agentTask', 'work must be an agentTask: an aiStep cannot hold tools');
  for (const c of WORK_CATEGORIES) {
    const n = workNode(c);
    assert.ok(n.data.tools?.includes('read_file'), `${c} must be able to read the project`);
    assert.ok(n.data.tools?.includes('write_file'), `${c} is handed work; it must be able to write it`);
  }
});

// The task type that owns the test suite must not report success over a red one.
test('the Work node is instructed not to finish on a failing suite', () => {
  const t = seed('work');
  assert.match(t.instructions, /non-zero exit/i);
  assert.match(t.instructions, /[Nn]ever report the task complete/);
});

test('the library can write code and run a command somewhere', () => {
  const testType = workNode('Test-creation');
  assert.ok(testType.data.tools.includes('bash'), 'nothing could run tests or a build');
  for (const tools of Object.values(WORK_TOOLS)) {
    for (const t of tools) assert.ok(AGENT_TOOLS.includes(t), `unknown tool granted: ${t}`);
  }
});

test('every work node can find out what is here before reading it', () => {
  // `glob` was built and granted to nobody, so a work node had `read_file` and
  // no way to know what to read. Watched live: an agent looking for one file
  // tried the repository root, src/, backend/, lib/, packages/ and python/ one
  // read at a time, then invented a `list_files` tool that does not exist. The
  // tool's own header says why it exists — "a model that cannot list guesses
  // paths" — and a guessed path that happens to exist is indistinguishable from
  // a read one.
  for (const category of WORK_CATEGORIES) {
    assert.ok(workNode(category).data.tools.includes('glob'), `${category} cannot list files`);
  }
});

// bash only STARTS in the workspace and can cd out (core/tools/bash.js says so);
// the approval gate is its only guard. Writes, by contrast, resolve through
// Workspace.resolve() and genuinely cannot escape — so write-only task types
// stay ungated and keep fanning out in parallel.
test('bash implies the tool gate; write-only task types stay ungated and parallel-safe', () => {
  assert.ok(workNode('Test-creation').data.tools.includes('bash'));
  for (const c of WORK_CATEGORIES) {
    const n = workNode(c);
    if (n.data.tools.includes('bash')) {
      assert.equal(n.data.approveToolCalls, true,
        `${c} grants bash, which is not path-confined — it must ask before running commands`);
    } else {
      assert.equal(n.data.approveToolCalls, false,
        `${c} writes are confined; gating it would serialize work for nothing`);
    }
  }
});

// nodes/*.json is the live source of truth; the seed only writes them on a fresh
// install (or the rework migration). They must not drift apart.
test('the shipped template files match the seed they came from', () => {
  for (const t of SEED_NODE_TEMPLATES) {
    const f = onDisk(t.id);
    assert.equal(f.baseType, t.baseType, `${t.id}: baseType drifted`);
    assert.deepEqual(f.tools, t.tools, `${t.id}: tools drifted`);
    assert.equal(f.approveToolCalls, t.approveToolCalls, `${t.id}: approval default drifted`);
  }
});
