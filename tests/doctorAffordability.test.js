// affordability: flyt doctor reports when balance cannot fund a normal request
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { effortBudget } from '../src/flowTypes.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpEngine() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-afford-'));
  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  engine.settings.providers = { openrouter: { apiKey: 'sk-test' } };
  // make openrouter connected for doctor
  engine.settings.providerPriority = ['openrouter'];
  engine.rebuildRuntimeConfig();
  return { engine, dataRoot };
}

async function withCredit({ limit, usage }, modelFacts, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { limit, usage, is_free_tier: false } })
  });
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('flyt doctor reports unaffordable balance in provider terms (requested vs afford)', async () => {
  const { engine, dataRoot } = tmpEngine();
  // Make default route expensive so $1.85 affords ~1411 tokens as in the 402
  const typical = effortBudget('medium');
  // pick price so 1.85 affords ~1411
  // pricePerM = left*1e6/afford
  const left = 1.85;
  const affordWant = 1411;
  const pricePerM = (left * 1e6) / affordWant;
  // inject into the model that planDefaultRoute will pick (openrouter code/medium)
  const { planDefaultRoute } = await import('../core/modelPriority.js');
  const route = planDefaultRoute({ type: 'agentTask', data: { role: 'execute', category: 'Code general', effort: 'medium' } }, engine.runtimeConfig);
  const modelId = route.model;
  engine.settings.modelFacts = { [modelId]: { outUsdPerM: pricePerM } };
  engine.rebuildRuntimeConfig();

  const { doctor } = await import('../core/diagnostics.js');
  const report = await withCredit({ limit: 10, usage: 10 - left }, engine.settings.modelFacts, () => doctor(engine));
  // ensure we used same facts (engine.settings updated)
  // re-run with engine containing facts
  const findings = report.findings.map(f => f.message).join('\n');
  const expectedTypical = String(typical);
  assert.match(findings, new RegExp(`requested up to ${expectedTypical} tokens`), 'must name tokens requested from effortBudget');
  assert.match(findings, /can only afford 14(10|11)/, 'must name tokens balance affords');
  assert.ok(report.findings.some(f => f.level === 'error' && /cannot fund a normal request/.test(f.message)));
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('flyt doctor is quiet when balance can fund a normal request', async () => {
  const { engine, dataRoot } = tmpEngine();
  const { planDefaultRoute } = await import('../core/modelPriority.js');
  const route = planDefaultRoute({ type: 'agentTask', data: { role: 'execute', category: 'Code general', effort: 'medium' } }, engine.runtimeConfig);
  const modelId = route.model;
  const pricePerM = 10; // cheap: $10 per million -> $20 affords 2M tokens
  engine.settings.modelFacts = { [modelId]: { outUsdPerM: pricePerM } };
  engine.rebuildRuntimeConfig();
  const { doctor } = await import('../core/diagnostics.js');
  const report = await withCredit({ limit: 50, usage: 30 }, engine.settings.modelFacts, () => doctor(engine)); // left 20 -> afford 2M
  assert.ok(!report.findings.some(f => /cannot fund a normal request/.test(f.message)), 'should be quiet when affordable');
  assert.ok(!report.findings.some(f => /can only afford/.test(f.message)));
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
