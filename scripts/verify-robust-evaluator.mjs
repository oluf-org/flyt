// Reproducible, explicitly synthetic canonical execution. No credentials used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.FLYT_TEST_MOCK_PROVIDER = '1';
process.env.FLYT_SANDBOX_MODE = 'danger-full-access';
const { createEngine } = await import('../core/engine.js');
const { createApi } = await import('../core/api.js');
const { registerProvider } = await import('../core/adapters/index.js');
const { fixtureDefinition, syntheticProvider } = await import('../tests/fixtures/robustEvaluator.js');
registerProvider('mock', syntheticProvider);
const desktop = process.argv.includes('--prepare-desktop');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-evaluator-acceptance-'));
const profile = path.join(root, 'profile'), data = path.join(root, 'data'), workspace = path.join(root, 'workspace');
fs.mkdirSync(profile); fs.mkdirSync(workspace);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ mock: true, activeModels: [{ id: 'mock-evaluator', source: 'mock', enabled: true }], sandbox: { mode: 'danger-full-access', minimumEnforcement: 'partial' } }));
const engine = createEngine({ projectRoot: path.resolve('.'), dataRoot: data, userDataDir: profile });
const api = createApi(engine), project = await api.invoke('project:open', { folder: workspace });
const results = [];
try {
  for (const kind of ['data', 'writing', 'planning']) {
    const definition = fixtureDefinition(kind), args = { projectId: project.id };
    const draft = await api.invoke('goal:author-open', { ...args, definition });
    const published = await api.invoke('goal:author-publish', { ...args, draftId: draft.id, baseRevision: draft.revision });
    if (desktop) { results.push({ kind, goalId: published.goalId, draftId: draft.id }); continue; }
    await api.invoke('goal:start', { ...args, goalId: published.goalId });
    let state;
    const deadline = Date.now() + 60000;
    do { await new Promise(resolve => setTimeout(resolve, 100)); state = await api.invoke('goal:get', { ...args, goalId: published.goalId }); } while (state.live && Date.now() < deadline);
    assert.equal(state.status, 'achieved', state.reason); assert.equal(state.benchmark.version, 2);
    results.push({ kind, state, iterations: state.history.map(item => api.invoke('goal:inspect', { ...args, goalId: state.id, record: item.artifact })) });
    results.at(-1).iterations = await Promise.all(results.at(-1).iterations);
  }
} finally { await api.shutdown('fixture complete'); engine.telemetry.close(); }
const report = { label: 'SYNTHETIC acceptance fixture. No measured live-model reliability.', at: new Date().toISOString(), root, profile, data, workspace, projectId: project.id, results };
fs.mkdirSync('docs/reviews/robust-evaluator', { recursive: true });
const file = desktop ? '.flyt/robust-desktop.json' : 'docs/reviews/robust-evaluator/synthetic-report.json';
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`${desktop ? 'Prepared desktop cases' : 'Passed all three synthetic loops'}: ${path.resolve(file)}`);
