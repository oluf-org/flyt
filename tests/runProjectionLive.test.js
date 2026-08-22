// The run folder, written beside the log as the run goes (t-0069).
//
// `projectRun` and `materialise` already existed; what did not was anything
// calling them while a run was still happening. A folder materialised only at
// the end does not exist for the whole stretch somebody is watching, which is
// the stretch "open the run folder" belongs to.
//
// The test that carries the invariant is the third one: delete the whole
// projection, rebuild it from the log alone, and assert it is byte-identical.
// That can only pass while the folder stays a pure function of the log — an
// incremental writer would drift from `projectRun` the first time either
// changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createKernel, flytBlocks, flytStackRunner, flytRunProjection, sessionJsonl,
  parseStack, projectRun, materialise,
} from '#kernel';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-proj-'));

const STACK = `version: 2
id: demo
blocks:
  - id: one
    use: demo:work
  - id: two
    use: demo:work
`;

async function bootProjected(root, execute) {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin(flytRunProjection, { root });
  await kernel.ctx.plugin({
    name: 'demo-blocks', inject: ['blocks'],
    apply(ctx) {
      ctx.blocks.register({
        use: 'demo:work', title: 'W', description: '', category: 'work',
        settings: { type: 'object' }, ceiling: null,
        async execute(run) {
          return (await execute?.(run)) ?? { status: 'done', output: `# ${run.blockId}\n\nIt did the thing.\n` };
        },
      });
    },
  });
  const stack = parseStack(STACK);
  await kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => stack.root } });
  return kernel;
}

/** Every file under a directory, relative, with its bytes. */
function snapshot(dir) {
  const out = {};
  const walk = (d, prefix = '') => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, rel); continue; }
      out[rel] = fs.readFileSync(full);
    }
  };
  walk(dir);
  return out;
}

const settle = () => new Promise(r => setTimeout(r, 60));

test('the run folder exists while the run is still going', async () => {
  const root = tmp();
  let seen = null;
  const kernel = await bootProjected(root, async ({ runId, blockId }) => {
    if (blockId === 'two') {
      // Block one has finished, and this is what a person watching would find.
      await settle();
      const dir = path.join(root, runId);
      seen = {
        meta: fs.existsSync(path.join(dir, 'meta.json')),
        one: fs.existsSync(path.join(dir, 'blocks', 'one.md')),
        two: fs.existsSync(path.join(dir, 'blocks', 'two.md')),
      };
    }
    return { status: 'done', output: `# ${blockId}\n` };
  });

  await (await kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();
  assert.deepEqual(seen, { meta: true, one: true, two: false },
    'block one is on disk before block two has finished, and block two is not there yet');
  await kernel.dispose();
});

test('meta, blocks and tools are all projected by the end', async () => {
  const root = tmp();
  const kernel = await bootProjected(root);
  await (await kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();
  await settle();

  const dir = path.join(root, 'run-1');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.runId, 'run-1');
  assert.equal(meta.stage, 'done');
  assert.match(fs.readFileSync(path.join(dir, 'blocks', 'one.md'), 'utf8'), /It did the thing/);
  assert.match(fs.readFileSync(path.join(dir, 'blocks', 'two.md'), 'utf8'), /It did the thing/);
  // And the log is still beside them, because it is the record and they are not.
  assert.ok(fs.existsSync(path.join(dir, 'session.jsonl')));
  await kernel.dispose();
});

test('deleting the projection and rebuilding it from the log reproduces it exactly', async () => {
  const root = tmp();
  const kernel = await bootProjected(root);
  await (await kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();
  await settle();

  const dir = path.join(root, 'run-1');
  const before = snapshot(dir);
  assert.ok(Object.keys(before).length > 2, 'there is a projection to rebuild');

  // Throw away everything except the record.
  const log = fs.readFileSync(path.join(dir, 'session.jsonl'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), log);

  const events = fs.readFileSync(path.join(dir, 'session.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  materialise(dir, projectRun(events, 'run-1'));

  assert.deepEqual(snapshot(dir), before,
    'the folder is a function of the log — byte for byte, or it is a second source of truth');
  await kernel.dispose();
});

test('a tool result is projected in full, never a preview', async () => {
  const root = tmp();
  const kernel = createKernel();
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin(flytRunProjection, { root });

  const long = 'x'.repeat(50_000);
  const session = await kernel.ctx.sessions.open('run-2');
  await session.append({ type: 'run.created', data: { runId: 'run-2', stackId: 'demo' } });
  await session.append({ type: 'tool.call', data: { callId: 'c1', name: 'read_file', args: { path: 'big' } } });
  await session.append({ type: 'tool.result', data: { callId: 'c1', name: 'read_file', content: long } });
  await settle();

  const tools = fs.readdirSync(path.join(root, 'run-2', 'tools'));
  assert.equal(tools.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'run-2', 'tools', tools[0]), 'utf8'));
  assert.equal(String(record.result ?? record.content ?? '').length, long.length,
    'the one time a preview is not enough is the time somebody opened the file');
  await kernel.dispose();
});

test('a half-written log still projects rather than refusing to open', async () => {
  const root = tmp();
  const dir = path.join(root, 'run-3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'),
    `${JSON.stringify({ seq: 1, at: 't', type: 'run.created', data: { runId: 'run-3' } })}\n`
    + '{"seq":2,"at":"t","type":"block.st');  // died mid-append

  const kernel = createKernel();
  await kernel.ctx.plugin(sessionJsonl, { root });
  const session = await kernel.ctx.sessions.read('run-3');
  const events = [];
  for await (const e of session.read()) events.push(e);
  const projection = projectRun(events, 'run-3');
  assert.equal(projection.meta.runId, 'run-3');
  assert.ok(session.problems.length, 'and the torn line is reported rather than swallowed');
  await kernel.dispose();
});
