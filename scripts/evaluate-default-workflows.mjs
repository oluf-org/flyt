// Explicit opt-in model evaluation, using the production host and isolated fixtures.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DEFAULT_WORKFLOW_CASES } from '../benchmark/default-workflows/cases.js';
import { bootRunKernel, startStackRun } from '../core/kernelHost.js';
import { RunStore } from '../core/state.js';
import { parseStack } from '#kernel';
import { serializeStack } from '../core/stackstore.js';
import { workflowMeasurements } from '../core/workflowMeasurements.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) { const key = process.argv[i]; if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`); args.set(key.slice(2), process.argv[i + 1]?.startsWith('--') || !process.argv[i + 1] ? true : process.argv[++i]); }
const root = path.resolve(import.meta.dirname, '..');
if (!args.has('live')) {
  console.log('Explicit live evaluation: --live --case make-basic --model <id> [--provider openrouter] [--repetitions 3] [--baseline] [--legacy] [--settings <file>]');
  console.log(DEFAULT_WORKFLOW_CASES.map(item => `${item.id}\t${item.workflow}`).join('\n'));
  process.exit(0);
}
const ids = String(args.get('case') ?? 'make-basic').split(',');
const cases = ids.includes('all') ? DEFAULT_WORKFLOW_CASES : DEFAULT_WORKFLOW_CASES.filter(item => ids.includes(item.id));
if (!cases.length || !ids.includes('all') && cases.length !== ids.length) throw new Error('Unknown evaluation case');
const repeats = Number(args.get('repetitions') ?? 3);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('Repetitions must be 1–10');
const minutes = Number(args.get('minutes') ?? 10);
if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error('Minutes must be 1–120');
const settingsPath = path.resolve(String(args.get('settings') ?? path.join(process.env.APPDATA ?? os.homedir(), 'Flyt', 'settings.json')));
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const tier = settings.workflowModelTiers?.standard;
const model = String(args.get('model') ?? (Array.isArray(tier) ? tier[0]?.model : tier?.model) ?? '');
const provider = String(args.get('provider') ?? 'openrouter');
const account = settings.providers?.[provider];
if (!model || !account?.apiKey) throw new Error('Select a model and a connected API provider in the settings file. Credentials are never printed or copied to fixtures.');
const output = path.resolve(String(args.get('output') ?? path.join(root, '.flyt', 'default-workflow-evaluation', new Date().toISOString().replace(/[:.]/g, '-'))));
fs.mkdirSync(output, { recursive: true });
const results = [];
const legacy = { 'make-change': 'pipeline', 'fix-bug': 'pipeline', 'review-change': 'fable-at-home', 'research-question': 'research', 'plan-idea': 'spec-an-idea', 'deliver-complex-task': 'fable-at-home' };
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ model, provider, repetitions: repeats, minutes, results }, null, 2));
for (const item of cases) for (let repeat = 0; repeat < repeats; repeat++) {
  const variants = ['candidate', ...(args.has('baseline') ? ['baseline'] : []), ...(args.has('legacy') ? ['legacy'] : [])];
  // Alternate presentation order to avoid always testing one version first.
  if (repeat % 2) variants.reverse();
  for (const variant of variants) {
    const dir = path.join(output, `${item.id}-${repeat + 1}-${variant}`), workspace = path.join(dir, 'workspace'), stacks = path.join(dir, 'stacks'), runsRoot = path.join(dir, 'runs');
    fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(stacks);
    for (const [name, content] of Object.entries(item.files)) { const file = path.join(workspace, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
    if (item.after) {
      const git = argv => execFileSync('git', argv, { cwd: workspace, windowsHide: true, stdio: 'pipe' });
      git(['init']); git(['add', '.']); git(['-c', 'user.name=Evaluation', '-c', 'user.email=evaluation@example.com', 'commit', '-m', 'fixed starting state']);
      for (const [name, content] of Object.entries(item.after)) fs.writeFileSync(path.join(workspace, name), content);
    }
    const stackId = variant === 'legacy' ? legacy[item.workflow] : item.workflow;
    const stack = parseStack(fs.readFileSync(path.join(root, 'stacks', `${stackId}.stack.yaml`), 'utf8'));
    if (variant === 'baseline') {
      const readOnly = ['research-question', 'plan-idea', 'review-change'].includes(item.workflow);
      stack.root.children = [{ kind: 'block', id: 'baseline', use: readOnly ? 'flyt-blocks-core:general-analysis' : 'flyt-blocks-core:work', config: { model, modelTier: 'standard', ...(!readOnly ? { hardMaxSteps: 30 } : {}),
        systemPrompt: 'Complete the original request directly with the tools provided. Preserve scope, use real evidence and report blockers honestly. Do not merge, publish or enqueue work.' } }];
      stack.presets = {};
    } else for (const block of stack.root.children) if (block.kind === 'block') block.config = { ...block.config, model, ...item.config,
      ...(variant === 'candidate' ? { maxCalls: 30, maxMinutes: minutes, maxUsd: 0.5 } : {}) };
    if (variant === 'candidate' && item.workflow === 'research-question' && item.config?.evidenceMode) stack.presets = {};
    fs.writeFileSync(path.join(stacks, `${stack.id}.stack.yaml`), serializeStack(stack));
    const store = new RunStore(runsRoot);
    const host = await bootRunKernel({ workspaceDir: workspace, runsRoot, store, stackRoot: stacks,
      sandboxMode: 'workspace-write', approvalMode: 'always', profile: 'flyt-cli',
      worker: { provider, model }, settings: {}, runtimeConfig: { providerKeys: { [provider]: account.apiKey }, retry: { attempts: 2, baseMs: 1000, maxMs: 2000 } },
      resolveModelSource: selected => ({ provider, model: selected, apiKey: account.apiKey, ...(account.keyKind ? { keyKind: account.keyKind } : {}) }),
      askBlock: async () => 'Use the fixed fixture constraints. Do not assume unavailable permissions, facts or external access.',
    });
    const began = Date.now(); let timer;
    try {
      const started = await startStackRun({ host, stackId: stack.id, input: item.input });
      timer = setTimeout(() => { void host.ctx.agents.stop(started.runId, 'Evaluation time limit'); }, minutes * 60_000);
      const outcome = await started.run.settled();
      const events = []; for await (const event of (await host.ctx.sessions.open(started.runId)).read()) events.push(event);
      const result = events.filter(e => e.type === 'block.output' && e.data.blockId === stack.root.children.at(-1).id && !e.data.port).at(-1)?.data.content ?? '';
      const mismatches = Object.entries(item.expected).filter(([name, expected]) => !fs.existsSync(path.join(workspace, name)) || fs.readFileSync(path.join(workspace, name), 'utf8') !== expected).map(([name]) => name);
      const missingText = (item.expectedText ?? []).filter(value => !result.toLowerCase().includes(value.toLowerCase()));
      let semantic = true;
      if (item.verify) {
        try { const expression = item.verify === 'zero-value' ? 'f(0)===0&&f(2)===2' : 'f(-2)===-4&&f(2)===4';
          execFileSync(process.execPath, ['-e', `const f=require('./module.cjs');if(!(${expression}))process.exit(1)`], { cwd: workspace, windowsHide: true, timeout: 5000, stdio: 'pipe' });
        } catch { semantic = false; }
      }
      const measurements = workflowMeasurements(store, started.runId);
      const accepted = item.expectedIncomplete ? outcome.status !== 'done' && !mismatches.length
        : outcome.status === 'done' && !mismatches.length && !missingText.length && semantic;
      const row = { case: item.id, variant, repeat: repeat + 1, runId: started.runId, status: outcome.status,
        accepted, falseSuccess: outcome.status === 'done' && !accepted, mismatches, missingText, semantic,
        durationMs: Date.now() - began, calls: Math.max(events.filter(e => e.type === 'workflow.call').length, measurements.modelCalls),
        tokens: measurements.tokens, knownUsd: measurements.knownUsd, sessions: measurements.evidence,
        error: outcome.error ?? null };
      results.push(row); save(); console.log(JSON.stringify(row));
    } finally { clearTimeout(timer); await host.dispose(); }
  }
}
console.log(`Saved ${results.length} matched trial records to ${path.join(output, 'results.json')}`);
if (results.some(item => item.variant === 'candidate' && !item.accepted)) process.exitCode = 1;
