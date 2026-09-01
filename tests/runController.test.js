import test from 'node:test';
import assert from 'node:assert/strict';
import { RunController, runKey } from '../core/runController.js';

const deferredRun = runId => {
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  return { runId, settled: () => done, finish };
};

function harness() {
  const runs = new Map();
  const leases = new Map();
  const boots = [];
  let sequence = 0;
  const store = {
    writeLease: (runId, lease) => leases.set(runId, lease),
    readLease: runId => leases.get(runId) ?? null,
    clearLease: runId => leases.delete(runId),
  };
  const bootHost = async (_projectId, request) => {
    const state = { request, disposed: 0, stops: [], pauses: [], continues: [] };
    const host = {
      metadata: { profile: request.profile },
      kernelModule: {},
      ctx: { agents: {
        stop: async (id, reason) => {
          state.stops.push([id, reason]);
          runs.get(id)?.finish({ state: 'cancelled' });
          return runs.has(id);
        },
        pause: async (id, reason) => { state.pauses.push([id, reason]); return false; },
        continue: async id => { state.continues.push(id); return false; },
      } },
      dispose: async () => { state.disposed += 1; },
    };
    boots.push({ state, host });
    return host;
  };
  const controller = new RunController({
    bootHost,
    runsRootForProject: projectId => `/runs/${projectId}`,
    storeForProject: () => store,
    startRun: async ({ id }) => {
      const run = deferredRun(id ?? `run-${++sequence}`);
      runs.set(run.runId, run);
      return { runId: run.runId, run };
    },
    snapshotLive: async () => ({}),
    snapshotStored: async () => ({}),
    metadataStored: () => null,
  });
  const launch = (runId, overrides = {}) => controller.start({
    projectId: 'project-a', runId, stackId: 'research', input: 'question',
    host: {
      runsRoot: '/runs/project-a', workspace: '/workspace', profile: 'flyt-desktop',
      approvalMode: 'always', worker: { provider: 'mock', model: 'mock-large' },
      ...overrides,
    },
  });
  return { controller, launch, runs, leases, boots };
}

test('run keys keep project and run identity unambiguous', () => {
  assert.notEqual(runKey('ab', 'c'), runKey('a', 'bc'));
});

test('equivalent launches share one host and dispose it only after the last owner settles', async () => {
  const { controller, launch, runs, boots } = harness();
  await Promise.all([launch('run-a'), launch('run-b')]);
  assert.equal(boots.length, 1, 'concurrent equivalent composition is booted once');
  assert.deepEqual(controller.list('project-a').sort(), ['run-a', 'run-b']);

  runs.get('run-a').finish({ state: 'done' });
  await controller.get('project-a', 'run-a').settlement;
  assert.equal(boots[0].state.disposed, 0, 'the second owner still needs the host');
  assert.equal(controller.isLive('project-a', 'run-b'), true);

  runs.get('run-b').finish({ state: 'done' });
  await controller.get('project-a', 'run-b').settlement;
  assert.equal(boots[0].state.disposed, 1);
  assert.deepEqual(controller.list('project-a'), []);
});

test('different composition authority never shares a host', async () => {
  const { controller, launch, runs, boots } = harness();
  await launch('run-a');
  await launch('run-b', { approvalMode: 'smart' });
  assert.equal(boots.length, 2);
  runs.get('run-a').finish({ state: 'done' });
  runs.get('run-b').finish({ state: 'done' });
  await Promise.all(controller.list().map(id => controller.get('project-a', id).settlement));
  assert.deepEqual(boots.map(row => row.state.disposed), [1, 1]);
});

test('controls return explicit negative results and resume does not invent success', async () => {
  const { controller, launch, runs } = harness();
  assert.deepEqual(await controller.stop('project-a', 'missing'), {
    ok: false, code: 'run_not_live', error: 'not-live',
    message: 'Run missing is not live in this process.',
  });
  await launch('run-a');
  const paused = await controller.pause('project-a', 'run-a');
  assert.equal(paused.ok, false);
  assert.equal(paused.code, 'run_control_failed');
  const resumed = await controller.resume({ projectId: 'project-a', runId: 'run-a' });
  assert.equal(resumed.control.ok, false);
  assert.equal(resumed.control.error, 'not-paused');
  runs.get('run-a').finish({ state: 'done' });
  await controller.get('project-a', 'run-a').settlement;
});

test('shutdown stops and awaits every owned run before returning', async () => {
  const { controller, launch, boots, leases } = harness();
  await Promise.all([launch('run-a'), launch('run-b')]);
  const result = await controller.shutdown('test shutdown');
  assert.equal(result.stopped, 2);
  assert.deepEqual(boots[0].state.stops.map(([id]) => id).sort(), ['run-a', 'run-b']);
  assert.equal(boots[0].state.disposed, 1);
  assert.equal(leases.size, 0);
  assert.deepEqual(controller.list(), []);
});
