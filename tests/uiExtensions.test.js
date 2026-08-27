import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';
import { createKernel, flytUiExtensions, parseStack } from '#kernel';
import { bootKernel } from '../core/v2.js';
import { createV2HostBridge } from '../core/v2Host.js';
import { buildSurface } from '../src/v2/buildSurface.js';

const noEnv = {};
const blockConfiguration = {
  point: 'block-configuration', id: 'example.work.config', block: 'example:work',
  schema: { type: 'object', properties: {
    prompt: { type: 'string', title: 'Plugin prompt', description: 'What should happen?' },
    careful: { type: 'boolean', title: 'Careful', default: true },
    mode: { type: 'select', title: 'Mode', options: ['fast', 'thorough'] },
  }, required: ['prompt'] },
};
const toolView = {
  point: 'tool-view', id: 'example.search.result', tool: 'example_search',
  view: { component: 'stack', children: [
    { component: 'badge', tone: 'success', text: 'Found by plugin' },
    { component: 'key-value', label: 'Source', value: 'workspace' },
  ] },
};

const contribute = (ctx, contribution) => ctx.uiExtensions.invoke({
  method: 'ui.contribute', params: { contribution },
});

test('an installed plugin owns typed declarations and unload removes them', async () => {
  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(flytUiExtensions);
    const fiber = await kernel.ctx.plugin({
      name: 'example.plugin', inject: ['uiExtensions'],
      apply(ctx) {
        assert.deepEqual(contribute(ctx, blockConfiguration), {
          ok: true, result: { accepted: true, pluginId: 'example.plugin' },
        });
        assert.equal(contribute(ctx, toolView).ok, true);
      },
    });
    const listed = kernel.ctx.uiExtensions.invoke({ method: 'ui.list', params: {} });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.result.map(row => [row.pluginId, row.contribution.point]), [
      ['example.plugin', 'block-configuration'], ['example.plugin', 'tool-view'],
    ]);
    await fiber.dispose();
    assert.deepEqual(kernel.ctx.uiExtensions.invoke({ method: 'ui.list', params: {} }).result, [],
      'host data cannot outlive the plugin that declared it');
  } finally { await kernel.dispose(); }
});

test('unknown components and executable renderer payloads are refused before listing', async () => {
  const kernel = createKernel();
  const responses = [];
  let accessorRuns = 0;
  let requestAccessorRuns = 0;
  try {
    await kernel.ctx.plugin(flytUiExtensions);
    await kernel.ctx.plugin({
      name: 'bad.plugin', inject: ['uiExtensions'],
      apply(ctx) {
        responses.push(contribute(ctx, {
          point: 'tool-view', id: 'bad.component', tool: 'search',
          view: { component: 'plugin-react-component', text: 'own chrome' },
        }));
        for (const view of [
          { component: 'text', text: 'click', onClick() {} },
          { component: 'text', text: 'styled', style: { position: 'fixed' } },
          { component: 'text', text: 'renderer', renderer: '() => document.body' },
        ]) responses.push(contribute(ctx, { point: 'tool-view', id: 'bad.code', tool: 'search', view }));
        const accessorView = {};
        Object.defineProperty(accessorView, 'component', {
          enumerable: true,
          get() { accessorRuns += 1; return 'text'; },
        });
        responses.push(contribute(ctx, {
          point: 'tool-view', id: 'bad.accessor', tool: 'search', view: accessorView,
        }));
      },
    });
    assert.equal(responses.every(response => !response.ok), true);
    assert.match(responses[0].error.message, /unknown component/);
    assert.match(responses[1].error.message, /executable|renderer code|DOM access|styling/);
    assert.match(responses.at(-1).error.message, /executable accessor/);
    assert.equal(accessorRuns, 0, 'refusing an accessor must not execute it');
    const accessorRequest = { method: 'ui.list' };
    Object.defineProperty(accessorRequest, 'params', {
      enumerable: true,
      get() { requestAccessorRuns += 1; return {}; },
    });
    const requestRefusal = kernel.ctx.uiExtensions.invoke(accessorRequest);
    assert.equal(requestRefusal.ok, false);
    assert.match(requestRefusal.error.message, /executable accessor/);
    assert.equal(requestAccessorRuns, 0, 'RPC envelope accessors are refused before any property read');
    assert.deepEqual(kernel.ctx.uiExtensions.invoke({ method: 'ui.list', params: {} }).result, [],
      'refused declarations never become renderer input');
  } finally { await kernel.dispose(); }
});

test('trace, settings and library extension points use the same closed boundary', async () => {
  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(flytUiExtensions);
    await kernel.ctx.plugin({
      name: 'future.plugin', inject: ['uiExtensions'],
      apply(ctx) {
        for (const contribution of [
          { point: 'trace-decoration', id: 'example.trace', event: 'tool.call', view: { component: 'badge', text: 'External' } },
          { point: 'settings-section', id: 'example.settings', title: 'Example', view: { component: 'notice', text: 'Managed by the plugin.' } },
          { point: 'library-entry', id: 'example.library', title: 'Example block', description: 'An installed contribution.' },
        ]) assert.equal(contribute(ctx, contribution).ok, true);
      },
    });
    assert.deepEqual(kernel.ctx.uiExtensions.invoke({ method: 'ui.list', params: {} }).result
      .map(row => row.contribution.point), ['trace-decoration', 'settings-section', 'library-entry']);
  } finally { await kernel.dispose(); }
});

test('an external plugin crosses kernel host RPC and reaches Build and Trace Flyt renderers', async () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-ui-rpc-'));
  const booted = await bootKernel({ call: true, env: noEnv, profile: 'flyt-desktop', runsRoot });
  const detachReviewSurface = booted.pluginReviews.subscribe(() => {});
  const emptyBridge = createV2HostBridge(booted);
  const emptySurface = await buildSurface({ v2Build: () => emptyBridge.build() });
  const stack = parseStack(`version: 2
id: ui-proof
name: UI proof
blocks:
  - id: work
    use: example:work
    title: Example work
    config:
      prompt: Ship it
`).root;
  const productionBridge = createV2HostBridge(booted, { build: () => ({
    stack: { id: 'ui-proof', root: stack },
    blocks: { resolve: use => use === 'example:work' ? { use } : undefined },
    library: {},
  }) });
  const surface = await buildSurface({
    v2Build: () => productionBridge.build(),
    onV2UiExtensionsChange: listener => productionBridge.subscribe(listener),
  });
  let uiRevisions = 0;
  const detachUiSurface = surface.subscribeUiExtensions(() => { uiRevisions += 1; });
  let vite;
  try {
    assert.deepEqual(surface.uiExtensions, [], 'the production bridge starts from the host registry');
    await booted.install([{ id: 'example-ui', name: 'example-ui-package' }], {
      import: async () => ({
        name: 'example.ui.plugin', inject: ['uiExtensions'],
        apply(ctx) {
          assert.equal(contribute(ctx, blockConfiguration).ok, true);
          assert.equal(contribute(ctx, toolView).ok, true);
        },
      }),
    });

    assert.deepEqual(surface.uiExtensions.map(row => row.pluginId),
      ['example.ui.plugin', 'example.ui.plugin'], 'the renderer receives only host-pushed listed clones');
    assert.ok(uiRevisions >= 2, 'each accepted contribution refreshes an already-mounted surface');

    vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    const [{ default: Shell }, { ToolCall }] = await Promise.all([
      vite.ssrLoadModule('/src/v2/Shell.jsx'),
      vite.ssrLoadModule('/src/v2/Trace.jsx'),
    ]);
    const emptyHtml = renderToStaticMarkup(React.createElement(Shell, {
      location: { dest: 'build', run: null }, build: emptySurface,
    }));
    assert.match(emptyHtml, /CLEAN SLATE/,
      'the untouched production snapshot renders the explicit no-stack state before geometry');
    assert.doesNotMatch(emptyHtml, /Plugin prompt/);
    const buildHtml = renderToStaticMarkup(React.createElement(Shell, {
      location: { dest: 'build', run: null }, build: surface,
    }));
    assert.match(buildHtml, /Plugin prompt/);
    assert.match(buildHtml, /data-plugin="example.ui.plugin"/);
    assert.match(buildHtml, /value="Ship it"/);

    const toolHtml = renderToStaticMarkup(React.createElement(ToolCall, {
      initiallyOpen: true,
      call: { callId: 'c1', name: 'example_search', args: { q: 'rpc' }, result: 'result', error: null, unfinished: false },
      uiExtensions: surface.uiExtensions,
    }));
    assert.match(toolHtml, /Found by plugin/);
    assert.match(toolHtml, /example_search tool view/);
    assert.doesNotMatch(toolHtml, /plugin-react-component|dangerouslySetInnerHTML/);
  } finally {
    await vite?.close();
    detachUiSurface();
    detachReviewSurface();
    await booted?.dispose();
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test('Electron exposes the production bridge as read-only build data and a push subscription', () => {
  const main = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /createV2HostBridge\(booted\)/);
  assert.match(main, /ipcMain\.handle\('v2:build'/);
  assert.match(main, /webContents\.send\('v2:ui-extensions-change', rows\)/);
  assert.match(preload, /v2Build: \(\) => ipcRenderer\.invoke\('v2:build'\)/);
  assert.match(preload, /onV2UiExtensionsChange:/);
  assert.doesNotMatch(preload, /ui\.contribute|uiExtensions\.invoke/,
    'the renderer bridge must not expose the contribution RPC');
});
