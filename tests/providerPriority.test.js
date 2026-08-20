// One routing policy (WR-04).
//
// The production defect: `createResolver` walked the user's
// `settings.providerPriority` when resolving an auto source, while
// `pickDefaultWorker` started from its own hard-coded `PROVIDER_ORDER` tables.
// Reordering providers in Settings therefore changed the renderer's preview and
// some calls, but left every unpinned default worker on the built-in order —
// two silent winners for one question, and a Settings page that lied.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickDefaultWorker, planDefaultRoute } from '../core/modelPriority.js';
import { resolveWorker, resolveWorkerRoute } from '../core/flowRunner.js';
import { routeFor } from '../src/providerMirror.js';
import { createEngine } from '../core/engine.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-priority-'));

const codeNode = { type: 'agentTask', data: { role: 'execute', category: 'Code general', effort: 'medium' } };
const allKeys = { anthropic: 'k', openai: 'k', kimi: 'k', openrouter: 'k' };

test('the user\'s Settings order decides which connected provider is tried first', () => {
  const withOrder = order => pickDefaultWorker(codeNode, { providerKeys: allKeys, providerPriority: order });

  assert.equal(withOrder(['openrouter', 'anthropic', 'openai', 'kimi']).provider, 'openrouter');
  assert.equal(withOrder(['kimi', 'anthropic', 'openai', 'openrouter']).provider, 'kimi');
  assert.equal(withOrder(['anthropic', 'openai', 'kimi', 'openrouter']).provider, 'anthropic');
});

test('the provider order chooses the provider; that provider\'s ranking chooses the model', () => {
  // Moving OpenRouter first must not change which of OPENROUTER's models is
  // best for this kind and effort — the two concerns compose in one direction.
  const r = planDefaultRoute(codeNode, { providerKeys: allKeys, providerPriority: ['openrouter', 'anthropic'] });
  assert.equal(r.provider, 'openrouter');
  assert.equal(r.model, '~deepseek/deepseek-v4-flash-latest'); // OpenRouter's cheap code/medium pick
  assert.equal(r.order, 'settings-priority');
});

test('a disconnected or incapable provider is skipped WITH a recorded reason', () => {
  const r = planDefaultRoute(codeNode, {
    providerKeys: { openrouter: 'k' },
    providerPriority: ['anthropic', 'codex', 'openrouter']
  });
  assert.equal(r.provider, 'openrouter');
  const skipped = Object.fromEntries(r.candidates.filter(c => c.skipped).map(c => [c.provider, c.skipped]));
  assert.equal(skipped.anthropic, 'not connected');
  assert.equal(skipped.codex, 'not connected');
  assert.ok(r.reason.includes('Settings order'));
});

test('subscription providers participate in the same order as keyed ones', () => {
  const r = planDefaultRoute(codeNode, {
    // The engine marks a connected subscription with a sentinel in providerKeys.
    providerKeys: { 'claude-code': 'subscription', openrouter: 'k' },
    providerPriority: ['anthropic', 'claude-code', 'openai', 'codex', 'openrouter']
  });
  assert.equal(r.provider, 'claude-code');
  assert.ok(r.model.startsWith('claude-'));
});

test('with no Settings order the built-in per-kind table still applies', () => {
  const r = planDefaultRoute(codeNode, { providerKeys: allKeys });
  assert.equal(r.order, 'default-order');
  assert.equal(r.provider, 'openrouter');
});

test('the OpenRouter value ladder uses free, cheap, then stronger shortlisted models', () => {
  const at = effort => planDefaultRoute(
    { type: 'agentTask', data: { role: 'execute', category: 'Code general', effort } },
    { providerKeys: { openrouter: 'k' } }
  ).model;
  assert.equal(at('low'), 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free');
  assert.equal(at('medium'), '~deepseek/deepseek-v4-flash-latest');
  assert.equal(at('high'), 'deepseek/deepseek-v4-pro-0813');
});

test('explicit node/category/level precedence survives the unification', () => {
  const config = {
    providerKeys: allKeys, providerPriority: ['openrouter', 'anthropic'],
    categoryWorkers: { 'Code general': { provider: 'kimi', model: 'kimi-k2.6' } },
    workers: { executor: { provider: 'mock', model: 'mock-large' } }
  };
  // A node that names its worker beats everything.
  assert.deepEqual(
    resolveWorker({ type: 'agentTask', data: { worker: { provider: 'openai', model: 'gpt-5' }, category: 'Code general' } }, config),
    { provider: 'openai', model: 'gpt-5' });
  // A level/pin beats a category.
  assert.deepEqual(
    resolveWorker(codeNode, { ...config, levelWorker: { provider: 'openai', model: 'o4' } }),
    { provider: 'openai', model: 'o4' });
  // A category beats the priority walk.
  assert.deepEqual(resolveWorker(codeNode, config), { provider: 'kimi', model: 'kimi-k2.6' });
  // …and without a category, the user's order wins.
  assert.equal(resolveWorker({ type: 'agentTask', data: { role: 'execute' } }, config).provider, 'openrouter');
});

test('the route record names how the worker was chosen, and carries no key', () => {
  const config = {
    providerKeys: allKeys, providerPriority: ['openrouter', 'anthropic'],
    categoryWorkers: {}, workers: { executor: { provider: 'mock', model: 'mock-large' } }
  };
  const explicit = resolveWorkerRoute({ type: 'aiStep', data: { worker: { provider: 'openai', model: 'gpt-5' } } }, config);
  assert.equal(explicit.via, 'node');

  const walked = resolveWorkerRoute(codeNode, config);
  assert.equal(walked.via, 'settings-priority');
  assert.equal(walked.worker.provider, 'openrouter');
  assert.ok(walked.candidates.length);
  assert.doesNotMatch(JSON.stringify(walked), /\bk\b.*apiKey|apiKey/);
});

test('a pinned source stays pinned no matter what the priority says', () => {
  // The renderer's preview and the engine's resolver answer this the same way:
  // a pin is a pin, and priority never overrides it.
  const providers = { anthropic: { hasKey: true }, openrouter: { hasKey: true } };
  assert.equal(
    routeFor('claude-sonnet-5', { providers, providerPriority: ['openrouter', 'anthropic'], source: 'anthropic' }),
    'anthropic');
  // A pin to a provider that cannot serve the id is unrouted, not silently rerouted.
  assert.equal(
    routeFor('claude-sonnet-5', { providers, providerPriority: ['openrouter'], source: 'openrouter' }),
    null);
});

test('reordering providers in Settings changes the next node without a restart', () => {
  const dataRoot = tmp();
  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  engine.settings.providers = { anthropic: { apiKey: 'k' }, openrouter: { apiKey: 'k' } };

  engine.settings.providerPriority = ['anthropic', 'openrouter'];
  engine.rebuildRuntimeConfig();
  assert.equal(pickDefaultWorker(codeNode, engine.runtimeConfig).provider, 'anthropic');

  // The user drags OpenRouter to the top. No restart, no new engine.
  engine.settings.providerPriority = ['openrouter', 'anthropic'];
  engine.rebuildRuntimeConfig();
  assert.equal(pickDefaultWorker(codeNode, engine.runtimeConfig).provider, 'openrouter');
  assert.deepEqual(engine.runtimeConfig.providerPriority.slice(0, 2), ['openrouter', 'anthropic']);
});

test('doctor previews the same default route the runner would take', async () => {
  const dataRoot = tmp();
  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  engine.settings.providers = { anthropic: { apiKey: 'k' }, openrouter: { apiKey: 'k' } };
  engine.settings.providerPriority = ['openrouter', 'anthropic'];
  engine.rebuildRuntimeConfig();

  const { doctor } = await import('../core/diagnostics.js');
  const report = await doctor(engine);
  const code = report.routes.find(r => r.kind === 'code');
  assert.equal(code.provider, 'openrouter');
  // The claim and the actual resolution are the same computation.
  assert.equal(code.provider, pickDefaultWorker(codeNode, engine.runtimeConfig).provider);
  assert.equal(code.model, pickDefaultWorker(codeNode, engine.runtimeConfig).model);
  assert.equal(code.order, 'settings-priority');
});
