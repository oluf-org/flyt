// Explicit live-provider authoring smoke. Uses a temporary draft and never
// publishes or starts a Goal. FLYT_VERIFY_SETTINGS supplies the existing settings
// file; credentials remain in memory and are never copied to the report.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { GoalController } from '../core/goalController.js';
import { GoalAuthoring } from '../core/goalAuthoring.js';
import { createAuthoringModelCaller } from '../core/goalAuthoringModel.js';
import { GOAL_RECIPE } from '../src/v2/goalDefaults.js';

if (!process.env.FLYT_VERIFY_SETTINGS) throw new Error('Set FLYT_VERIFY_SETTINGS explicitly to use a live provider');
const settings = JSON.parse(fs.readFileSync(process.env.FLYT_VERIFY_SETTINGS, 'utf8'));
const model = process.env.FLYT_VERIFY_MODEL || 'z-ai/glm-5.3-flash';
const apiKey = settings.providers?.openrouter?.apiKey;
if (!apiKey) throw new Error('No OpenRouter connection in the selected settings');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-author-live-'));
const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
const goals = new GoalController({ runs: {}, project: () => ({ id: 'verification', folder: workspace, store: { rootDir: path.join(root, 'runs') } }), worker: () => ({ provider: 'openrouter', model }) });
const call = createAuthoringModelCaller();
const deadline = AbortSignal.timeout(300000);
const author = new GoalAuthoring({ root: path.join(root, 'drafts'), goals,
  models: () => [{ id: model, provider: 'openrouter' }],
  call: ({ worker, signal, ...request }) => call({ target: { provider: 'openrouter', model, apiKey }, facts: settings.modelFacts?.[model] ?? {}, ...request, signal: AbortSignal.any([signal, deadline]) }),
});
try {
  const draft = await author.open({ projectId: 'verification', definition: { name: 'Security audit verification', recipe: GOAL_RECIPE, worker: { provider: 'openrouter', model } } });
  const args = { projectId: 'verification', draftId: draft.id };
  await author.author({ ...args, baseRevision: 1, requestId: 'live-smoke', scope: { type: 'loop' }, worker: { provider: 'openrouter', model },
    text: 'Design a loop for a structured security review of an authorized, locally cloned GitHub repository under repos. Investigate the repository step by step. Propose a workflow that writes one Markdown report per confirmed vulnerability in a findings folder. Each report should explain the vulnerability and give reproducible verification steps. Prefix filenames with low, medium, or high according to severity. Only design the loop now; do not execute an audit.' });
  const timer = setInterval(() => {
    const request = author.read(args).requests[0];
    console.log(JSON.stringify({ status: request.status, calls: request.calls, progress: request.progress }));
  }, 15000);
  try { await Promise.all([...author.deliveries]); } finally { clearInterval(timer); }
  const state = author.read(args), request = state.requests[0];
  const report = { model, status: request.status, response: request.response, error: request.error,
    calls: state.authoringCalls, knownUsd: state.knownUsd, unknownCostCalls: state.unknownCostCalls,
    attempts: request.attempts, toolCalls: request.toolCalls,
    proposals: state.proposals.map(item => ({ status: item.status, rationale: item.rationale, diff: item.diff })), goalId: state.goalId };
  const reportPath = path.resolve('docs/reviews/goal-authoring-live.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, responseType: report.response?.type, calls: report.calls, knownUsd: report.knownUsd, reportPath }));
  assert.equal(request.status, 'complete', request.error);
  assert(['proposal', 'question'].includes(request.response.type), 'Live author should propose a loop or ask a necessary clarification');
  if (request.response.type === 'proposal') assert.equal(request.response.validation.readyToStart, true, request.response.validation.readinessError);
  assert.equal(state.goalId, null); assert.deepEqual(fs.readdirSync(workspace), []);
} finally {
  await author.shutdown();
  const relative = path.relative(os.tmpdir(), root);
  if (relative.startsWith('flyt-author-live-') && !relative.includes(path.sep)) fs.rmSync(root, { recursive: true, force: true });
}
