// Real engine records, deterministic provider, isolated desktop profile.
// Run after build:kernel, then launch Electron with the two paths in the manifest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { registerProvider } from '../core/adapters/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-history-ui-'));
const profile = path.join(root, 'profile'), data = path.join(root, 'data'), workspace = path.join(root, 'History verification');
for (const directory of [profile, data, workspace]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ mock: true,
  activeModels: [{ id: 'mock-history', source: 'mock', enabled: true }],
  workers: { executor: { provider: 'mock', model: 'mock-history' }, planner: { provider: 'mock', model: 'mock-history' } },
  supervisor: { terminalSummary: false }, retry: { maxAttempts: 1 }, sandbox: { mode: 'danger-full-access' },
}));
let calls = 0, mode = 'achieved';
const adapter = async () => {
  calls++;
  const text = mode === 'workflow' ? 'The review is complete. The implementation is ready for a final check.'
    : JSON.stringify({ candidate: { text: calls === 1 || mode === 'plateau' ? 'ALPHA — initial draft' : 'ALPHA BETA — both checks passed.\n\nThe report is ready.' } });
  return { text, finishReason: 'stop', usage: { prompt_tokens: 1250, completion_tokens: 320,
    completion_tokens_details: { reasoning_tokens: 80 }, prompt_tokens_details: { cached_tokens: 200 },
    ...(mode === 'unpriced' ? {} : { cost: .0125 }) } };
};
adapter.canServe = model => model === 'mock-history'; registerProvider('mock', adapter);
const engine = createEngine({ projectRoot, dataRoot: data, userDataDir: profile });
const api = createApi(engine);
const project = await api.invoke('project:open', { folder: workspace });
const recipe = `version: 2
id: history-verification
name: Review report
launchable: true
blocks:
  - id: improve
    use: flyt-blocks-core:general-analysis
    config: {}
`;
const wait = async fn => {
  for (let n = 0; n < 1200; n++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Verification run did not settle');
};
const goalIds = [];
try {
  for (const [name, kind] of [['Polish the weekly report', 'achieved'], ['Compare the draft variants', 'plateau'], ['Finish the release checklist', 'unpriced']]) {
    mode = kind; calls = 0;
    const goal = await api.invoke('goal:create', { projectId: project.id, definition: { name,
      objective: 'Produce a report containing ALPHA and BETA.', constraints: 'Preserve the acceptance checks.', recipe,
      criteria: [{ type: 'output_contains', value: 'ALPHA' }, { type: 'output_contains', value: 'BETA' }],
      limits: { iterations: 5, calls: 10, minutes: 3 }, plateau: 2, worker: { provider: 'mock', model: 'mock-history' },
    } });
    goalIds.push(goal.id);
    await api.invoke('goal:start', { projectId: project.id, goalId: goal.id });
    await wait(async () => { const state = await api.invoke('goal:get', { projectId: project.id, goalId: goal.id }); return !state.live && state.status !== 'ready' ? state : null; });
  }
  fs.writeFileSync(path.join(data, 'stacks', 'history-verification.stack.yaml'), recipe);
  mode = 'workflow';
  const workflow = await api.invoke('workflow:run', { projectId: project.id, workflowId: 'history-verification', input: 'Review the release notes',
    modelSelection: { defaultWorker: { provider: 'mock', model: 'mock-history' } } });
  await wait(async () => { const snapshot = await api.invoke('run:snapshot', { projectId: project.id, runId: workflow.runId }); return snapshot.meta.stage === 'done'; });
  const manifest = { root, profile, data, workspace, projectId: project.id, goalIds, workflowId: workflow.runId };
  fs.writeFileSync(path.join(projectRoot, '.flyt', 'history-verification.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest));
} finally { await api.shutdown('verification preparation complete'); engine.telemetry.close(); }
