import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseListOutput } from '../kernel/dist/blocks/list-output.js';
import { bootRunKernel, startStackRun } from '../core/kernelHost.js';
import { RunStore } from '../core/state.js';
import { Backlog } from '../core/backlog.js';
import queueTasks from '../core/tools/queue_backlog_tasks.js';
import { desktopWorkflowCeiling } from '../core/kernelHost.js';

test('multiline Split JSON remains two complete foreach assignments', () => {
  const tasks = ['# Keyboard navigation\nGoal: support keyboard\nAcceptance: Enter opens', '# Export docs\nGoal: document JSON\nAcceptance: include example'];
  assert.deepEqual(parseListOutput(JSON.stringify(tasks, null, 2), 'parts'), tasks);
  assert.deepEqual(parseListOutput('```json\n' + JSON.stringify({ parts: tasks }) + '\n```', 'parts'), tasks);
});

test('legacy Markdown task details stay attached to their task headings', () => {
  const taskOne = '## Task 1: Test boundary\n\n**Goal:** Equal times\n- Context: schedule.js\n- Acceptance: now included';
  const taskTwo = '## Task 2: Document\n\n**Goal:** Describe null\n- Context: README.md\n- Acceptance: example';
  assert.deepEqual(parseListOutput('# Tasks\n\n' + taskOne + '\n\n' + taskTwo, 'tasks'), [taskOne, taskTwo]);
  assert.deepEqual(parseListOutput('# Tasks\n\n' + taskOne, 'tasks'), [taskOne]);
});

test('broken JSON cannot become a list of brackets and property lines', () => {
  assert.throws(() => parseListOutput('[\n{"title":"incomplete"}', 'tasks'), /valid JSON array/);
  assert.throws(() => parseListOutput('{"summary":"not tasks"}', 'tasks'), /JSON array/);
  assert.throws(() => parseListOutput('[null, 7]', 'tasks'), /non-empty strings or task objects/);
  assert.deepEqual(parseListOutput('[]', 'tasks'), []);
});

async function fixture(t, { source, call, askHuman, approvalMode = 'always', ceiling } = {}) {
  const events = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-block-regression-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const runsRoot = path.join(root, 'runs'); const backlog = new Backlog(path.join(workspace, '.flyt/backlog'));
  const host = await bootRunKernel({ runsRoot, workspaceDir: workspace, store: new RunStore(runsRoot), backlog,
    stackRoot: path.resolve('stacks'), stackSource: source, profile: 'flyt-desktop', approvalMode,
    sandboxMode: 'danger-full-access', worker: { provider: 'script', model: 'audit' },
    resolveModelSource: model => ({ provider: 'script', model }), call: call ?? (async () => { throw new Error('Unexpected model call'); }),
    onSessionEvent: (_id, event) => events.push(event),
    ...(askHuman ? { askHuman } : {}), ...(ceiling ? { ceiling } : {}),
  });
  t.after(async () => { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { host, backlog, workspace, events, async run(input, id) { return (await startStackRun({ host, stackId: 'audit', input, ...(id ? { id } : {}) })).run.settled(); } };
}

test('a real Split -> foreach run visits two tasks, including their complete criteria', async t => {
  const seen = [];
  const p = await fixture(t, { source: `version: 2
id: audit
blocks:
  - id: split
    use: flyt-blocks-core:split
    outputs:
      - name: parts
        type: list
  - id: each
    kind: foreach
    roster: split.parts
    max: 4
    body:
      - id: analyze
        use: flyt-blocks-core:general-analysis
`, call: async request => {
    seen.push(request);
    return { text: seen.length === 1 ? JSON.stringify([{ title: 'First task', acceptance: 'ALPHA' }, { title: 'Second task', acceptance: 'BETA' }], null, 2) : 'Completed the supplied task.', finishReason: 'stop', model: 'audit', provider: 'script' };
  } });
  assert.equal((await p.run('Split two tasks')).status, 'done');
  assert.equal(seen.length, 3, 'One split and exactly two workers');
  assert.match(JSON.stringify(seen[1].messages), /First task.*ALPHA/);
  assert.match(JSON.stringify(seen[2].messages), /Second task.*BETA/);
  assert.doesNotMatch(JSON.stringify(seen), /\[object Object\]/);
  const states = p.events.filter(event => event.type === 'block.status' && event.data.blockId === 'each').map(event => event.data.status);
  assert.equal(states[0], 'active'); assert.equal(states.at(-1), 'done');
});

test('a length-truncated list continues before it is parsed or marked complete', async t => {
  const seen = [];
  const p = await fixture(t, { source: `version: 2\nid: audit\nblocks:\n  - id: split\n    use: flyt-blocks-core:split\n`,
    call: async request => {
      seen.push(request);
      return { text: seen.length === 1 ? '["Complete task one",' : '"Complete task two"]',
        finishReason: seen.length === 1 ? 'length' : 'stop', model: 'audit', provider: 'script' };
    },
  });
  assert.equal((await p.run('Two tasks')).status, 'done');
  assert.equal(seen.length, 2);
  assert.match(JSON.stringify(seen[1].messages), /previous response reached the provider output limit/);
});

const handoff = `version: 2
id: audit
blocks:
  - id: handoff
    use: flyt-blocks-loop:loop-handoff
`;
const tasks = [{ title: 'Document boundary', goal: 'Explain the equal-time behavior in README.md', doneWhen: ['Example included'], blastRadius: ['README.md'], gates: ['npm test'] }];

test('Backlog handoff runs in a desktop workflow and queues real tasks without a model', async t => {
  const p = await fixture(t, { source: handoff });
  assert.equal((await p.run(JSON.stringify(tasks))).status, 'done');
  const queued = p.backlog.list(); assert.equal(queued.length, 1);
  assert.equal(queued[0].title, tasks[0].title); assert.deepEqual(queued[0].gates, ['npm test']);
  assert.match(queued[0].body, /Example included/);
  assert(!desktopWorkflowCeiling([{ ceiling: ['enqueue_task', 'write_file'] }]).includes('enqueue_task'), 'Ordinary work keeps its existing queue boundary');
});

test('handoff validates the entire batch before queuing anything', async t => {
  const p = await fixture(t, { source: handoff });
  const result = await p.run(JSON.stringify([...tasks, { title: 'Broken task' }]));
  assert.equal(result.status, 'failed'); assert.equal(p.backlog.list().length, 0);
});

test('handoff obeys a denied write approval and a narrowed tool ceiling', async t => {
  for (const config of [{ approvalMode: 'ask', askHuman: async () => false }, { ceiling: ['read_file'] }]) {
    const p = await fixture(t, { source: handoff, ...config });
    assert.equal((await p.run(JSON.stringify(tasks))).status, 'failed');
    assert.equal(p.backlog.list().length, 0);
  }
});

test('retrying the same durable handoff returns the same receipts without duplicate tasks', async t => {
  const p = await fixture(t, { source: handoff });
  const ctx = { backlog: p.backlog, runId: 'same-run', nodeId: 'handoff' };
  const first = queueTasks.run({ tasks }, ctx);
  assert.deepEqual(queueTasks.run({ tasks }, ctx), first);
  assert.equal(p.backlog.list().length, 1);
  assert.throws(() => queueTasks.run({ tasks: [...tasks, { ...tasks[0], dependsOn: ['missing-task'] }] }, ctx), /Unknown backlog dependency/);
  assert.equal(p.backlog.list().length, 1);
});

test('repository analysis and planning offer readers but no writers', async t => {
  for (const use of ['general-analysis', 'plan-start']) {
    let offered;
    const p = await fixture(t, { source: `version: 2\nid: audit\nblocks:\n  - id: inspect\n    use: flyt-blocks-core:${use}\n`,
      call: async request => { offered = request.tools; return { text: use === 'plan-start' ? '[]' : 'Grounded assessment.', provider: 'script', model: 'audit', finishReason: 'stop' }; },
    });
    assert.equal((await p.run('Read this repository')).status, 'done');
    const names = offered.map(tool => tool.function?.name ?? tool.name);
    assert(names.includes('read_file')); assert(!names.includes('write_file')); assert(!names.includes('bash'));
  }
});

test('a partial backlog storage failure keeps honest receipts and replay fills the remaining task', async t => {
  const p = await fixture(t, { source: handoff });
  const batch = [tasks[0], { ...tasks[0], title: 'Second document' }];
  const add = p.backlog.add.bind(p.backlog); let writes = 0;
  p.backlog.add = task => { if (++writes === 2) throw new Error('Disk full'); return add(task); };
  const ctx = { backlog: p.backlog, runId: 'partial', nodeId: 'handoff' };
  const partial = queueTasks.run({ tasks: batch }, ctx);
  assert.match(partial.refused, /1 of 2.*Disk full/); assert.equal(partial.queued.length, 1);
  p.backlog.add = add;
  const resumed = queueTasks.run({ tasks: batch }, ctx);
  assert.equal(resumed.refused, undefined); assert.equal(resumed.queued.length, 2);
  assert.deepEqual(resumed.queued[0], partial.queued[0]); assert.equal(p.backlog.list().length, 2);
});

test('AI step instructions enforce their explicit word ceiling', async t => {
  let calls = 0;
  const p = await fixture(t, { source: `version: 2\nid: audit\nblocks:\n  - id: combine\n    use: flyt-blocks-core:combine\n    config:\n      instructions: Under 5 words.\n`,
    call: async () => ({ text: ++calls === 1 ? 'This output has far too many words.' : 'Brief result.', provider: 'script', model: 'audit', finishReason: 'stop' }),
  });
  assert.equal((await p.run('Combine the notes')).status, 'done'); assert.equal(calls, 2);
});

test('input-only transformations offer no tools despite a reader-capable block ceiling', async t => {
  const p = await fixture(t, { source: `version: 2\nid: audit\nblocks:\n  - id: describe\n    use: flyt-blocks-core:general-analysis\n    config:\n      inputOnly: true\n`,
    call: async request => { assert.equal((request.tools ?? []).length, 0);return { text: 'The task preserves Unicode labels.', provider: 'script', model: 'audit', finishReason: 'stop' }; },
  });
  assert.equal((await p.run('{"title":"Preserve Unicode", "acceptance":"blåbær remains unchanged"}')).status,'done');
  assert.equal(p.events.filter(event=>event.type==='tool.call').length,0);
});

test('a failed parallel lane stops the containing sequence even when the last lane succeeds', async t => {
  const p = await fixture(t, { source: `version: 2
id: audit
blocks:
  - id: lanes
    kind: parallel
    maxParallel: 2
    lanes:
      - id: broken
        use: audit:fail
      - id: good
        use: audit:pass
  - id: downstream
    use: audit:pass
` });
  const seen = [];
  p.host.ctx.blocks.register({ use: 'audit:fail', title: 'Fail', category: 'utility', settings: {}, ceiling: [], outputs: [], execute: async run => {seen.push(run.blockId);return { status: 'failed', output: '', error: 'Intentional lane failure' };} });
  p.host.ctx.blocks.register({ use: 'audit:pass', title: 'Pass', category: 'utility', settings: {}, ceiling: [], outputs: [], execute: async run => {seen.push(run.blockId);return { status: 'done', output: 'OK' };} });
  // Both lanes must run in the same wave to reproduce a failed lane followed
  // by a successful one in the returned completion list.
  assert.equal((await p.run('Run the parallel failure fixture')).status, 'failed');
  assert(seen.includes('good'));
  assert(!seen.includes('downstream'));
  assert.equal(p.events.filter(event=>event.type==='block.status'&&event.data.blockId==='lanes').at(-1).data.status,'failed');
});
