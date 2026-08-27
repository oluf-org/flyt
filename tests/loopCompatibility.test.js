// The one internal v1-shaped asset retained after the product cutover.
// Loop still executes through this projection until t-0117 moves supervision
// onto the kernel runner; fresh startup must not recreate any product flows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlowStore, LOOP_TASK_ID } from '../core/flowstore.js';
import { NodeStore } from '../core/nodestore.js';
import { ToolStore } from '../core/toolstore.js';
import { lintFlow } from '../core/stacklang/lint.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-loop-compat-'));

test('a fresh compatibility store seeds only the Loop execution projection', () => {
  const store = new FlowStore(tmp());
  const nodes = new NodeStore(tmp());
  const tools = new ToolStore(tmp());

  assert.equal(store.ensureLoopTask(), true);
  assert.equal(store.ensureLoopTask(), false, 'seeding never overwrites the projection');
  assert.deepEqual(store.list(), [{ id: LOOP_TASK_ID, name: 'Work one backlog task' }]);

  const flow = store.load(LOOP_TASK_ID);
  const work = flow.nodes.find(node => node.id === 'work');
  assert.deepEqual(work.overrides.tools, ['loop']);
  assert.equal(work.overrides.toolCeiling, 'loop');
  assert.equal(work.overrides.effect, 'workspace-change');
  assert.equal(lintFlow(flow, { templates: nodes.listFull(), library: tools.catalog() }).ok, true);
});
