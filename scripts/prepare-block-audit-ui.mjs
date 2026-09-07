// Prepare an isolated desktop profile for the live block acceptance audit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
const model = 'z-ai/glm-5.3-flash';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-block-ui-'));
const profile = path.join(root, 'profile'), data = path.join(root, 'data'), workspace = path.join(root, 'workspace');
for (const dir of [profile, data, workspace]) fs.mkdirSync(dir, { recursive: true });
const original = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'flyt/settings.json'), 'utf8'));
const worker = { provider: 'openrouter', model };
// Only the requested provider/model is available in this disposable profile.
const settings = { providers: { openrouter: original.providers.openrouter }, activeModels: [{ id: model, source: 'openrouter', enabled: true }],
  modelFacts: { [model]: original.modelFacts[model] }, workflowModelTiers: Object.fromEntries(['free', 'economy', 'standard', 'frontier'].map(tier => [tier, [worker]])),
  workers: { executor: worker, supervisor: worker, reviewer: worker },
};
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
fs.writeFileSync(path.join(workspace, 'README.md'), '# Block audit desktop fixture\nThis project verifies the block editor and live run display.\n');
const engine = createEngine({ projectRoot: path.resolve('.'), dataRoot: data, userDataDir: profile });
const api = createApi(engine);
const project = await api.invoke('project:open', { folder: workspace });
await api.shutdown();
const metadata = { root, profile, data, workspace, projectId: project.id, model };
fs.writeFileSync('docs/reviews/block-audit/ui-profile.json', JSON.stringify(metadata, null, 2));
console.log(JSON.stringify(metadata));
