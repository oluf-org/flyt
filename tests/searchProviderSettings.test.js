import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('Settings exposes secret-safe Brave and Tavily fields in the real renderer', async () => {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { SearchProvidersSection, searchProviderKeyPatch } = await vite.ssrLoadModule('/src/Settings.jsx');
    const html = renderToStaticMarkup(React.createElement(SearchProvidersSection, {
      searchProviders: { brave: { hasKey: true }, tavily: { hasKey: false } },
      save: async () => {},
    }));
    assert.match(html, /data-search-providers="true"/);
    assert.match(html, /Brave Search/);
    assert.match(html, /Tavily/);
    assert.match(html, /Brave Search API key/);
    assert.match(html, /Tavily API key/);
    assert.match(html, /configured/);
    assert.match(html, /keyless DuckDuckGo fallback/);
    assert.equal((html.match(/type="password"/g) ?? []).length, 2);
    assert.deepEqual(searchProviderKeyPatch('tavily', '  tvly-secret  '), {
      providerKeys: { tavily: 'tvly-secret' },
    });
    assert.equal(searchProviderKeyPatch('unknown', 'secret'), null);
    assert.equal(searchProviderKeyPatch('brave', '  '), null);
  } finally {
    await vite.close();
  }
});

test('Electron and the browser harness both route providerKeys into search-provider state', () => {
  const read = relative => fs.readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
  const main = read('electron/main.js');
  const mock = read('src/devMock.js');
  assert.match(main, /applySearchProviderKeys\(settings, patch\.providerKeys\)/);
  assert.match(mock, /mockSettings\.searchProviders\[p\]/);
});
