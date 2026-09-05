import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';

const providers = {
  anthropic: { hasKey: false },
  'claude-code': { hasKey: true, subscription: { enabled: true, signedIn: true, cliFound: true } },
  openai: { hasKey: false },
  codex: { hasKey: false, subscription: { enabled: false, signedIn: false, cliFound: true } },
  kimi: { hasKey: false, keyKind: 'platform' },
  openrouter: { hasKey: false },
  mock: { hasKey: true },
};

test('model providers show connected routes, keep setup behind Add provider, and mark CLI harnesses', async () => {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { ModelProvidersSection } = await vite.ssrLoadModule('/src/Settings.jsx');
    const html = renderToStaticMarkup(React.createElement(ModelProvidersSection, {
      s: { providers, activeModels: [], providerPriority: ['claude-code', 'mock', 'anthropic', 'openai', 'codex', 'kimi', 'openrouter'] },
      usage: { byProvider: { 'claude-code': { calls: 7, tokens: 1234, successRate: 1, costUsd: 0 } }, totalCalls: 10 },
      save: async () => {},
    }));
    assert.match(html, /Model providers/);
    assert.match(html, /\+ Add provider/);
    assert.match(html, /data-provider="claude-code"/);
    assert.match(html, /CLI harness/);
    assert.doesNotMatch(html, />Anthropic</, 'an unauthenticated route is not in the connected list');
    assert.doesNotMatch(html, />Mock</);
    assert.doesNotMatch(html, /Automatic route order/);
    assert.match(html, /Minimize/);
    assert.match(html, /tokens · 100% success/);
    assert.doesNotMatch(html, /usage-ring/);
    assert.doesNotMatch(html, /No local activity recorded/);
  } finally {
    await vite.close();
  }
});

test('the model catalog drops entries with no authenticated route', async () => {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { connectedModelCatalog, providerUsageSummary } = await vite.ssrLoadModule('/src/connectedModelCatalog.js');
    const input = [{ id: 'claude-sonnet-5' }, { id: 'gpt-5.2' }, { id: 'vendor/stale' }];
    const result = connectedModelCatalog(input, [], { providers, providerPriority: ['claude-code', 'codex', 'openrouter', 'mock'] });
    assert.deepEqual(result.models.map(model => model.id), ['claude-sonnet-5']);
    assert.equal(result.routes.get('claude-sonnet-5'), 'claude-code');
    assert.equal(result.routes.get('gpt-5.2'), null);
    const usage = providerUsageSummary([
      { model: 'claude-sonnet-5', calls: 7, promptTokens: 100, completionTokens: 25, successRate: 6 / 7, costUsd: 0.2 },
      { model: 'vendor/stale', calls: 3, promptTokens: 50, completionTokens: 10, successRate: 1, costUsd: 0.1 },
    ], [], { providers, providerPriority: ['claude-code', 'codex', 'openrouter'] });
    assert.equal(usage.totalCalls, 10, 'the ring denominator includes all locally observed calls');
    assert.equal(usage.byProvider['claude-code'].calls, 7);
    assert.equal(Math.round(usage.byProvider['claude-code'].successRate * 100), 86);
  } finally {
    await vite.close();
  }
});

test('Settings has no Providers tab and Plugins owns web-search configuration', async () => {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { default: Settings } = await vite.ssrLoadModule('/src/Settings.jsx');
    const { default: LibraryPage } = await vite.ssrLoadModule('/src/v2/LibraryPage.jsx');
    const settingsHtml = renderToStaticMarkup(React.createElement(Settings, { onClose: () => {}, onOpenModels: () => {} }));
    assert.doesNotMatch(settingsHtml, /role="tab"[^>]*>Providers</);
    assert.match(settingsHtml, /role="tab"[^>]*>Repositories</);

    const pluginsHtml = renderToStaticMarkup(React.createElement(LibraryPage, {
      initialView: 'plugins', initialSettings: { searchProviders: { brave: { hasKey: false }, tavily: { hasKey: true } } },
    }));
    assert.match(pluginsHtml, /data-search-providers="true"/);
    assert.match(pluginsHtml, /Web search/);
    assert.match(pluginsHtml, /Brave Search/);
    assert.match(pluginsHtml, /Tavily/);
  } finally {
    await vite.close();
  }
});
