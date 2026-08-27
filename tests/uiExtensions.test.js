import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createUiExtensionRpcBoundary, UI_COMPONENTS } from '#kernel';

const contribute = (rpc, contribution) => rpc.invoke({
  method: 'ui.contribute', params: { pluginId: 'example.plugin', contribution },
});

test('block configuration schema and tool view cross typed RPC as data', () => {
  const rpc = createUiExtensionRpcBoundary();
  assert.deepEqual(contribute(rpc, {
    point: 'block-configuration', id: 'example.work.config', block: 'example:work',
    schema: { type: 'object', properties: {
      prompt: { type: 'string', title: 'Prompt', description: 'What should happen?' },
      careful: { type: 'boolean', title: 'Careful', default: true },
      mode: { type: 'select', title: 'Mode', options: ['fast', 'thorough'] },
    }, required: ['prompt'] },
  }), { ok: true, result: { accepted: true } });
  assert.equal(contribute(rpc, {
    point: 'tool-view', id: 'example.search.result', tool: 'example_search',
    view: { component: 'stack', children: [
      { component: 'badge', tone: 'success', text: 'Found' },
      { component: 'key-value', label: 'Source', value: 'workspace' },
    ] },
  }).ok, true);

  const listed = rpc.invoke({ method: 'ui.list', params: {} });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result.map(row => row.contribution.point), ['block-configuration', 'tool-view']);
});

test('unknown components and executable renderer payloads are refused at RPC boundary', () => {
  const rpc = createUiExtensionRpcBoundary();
  const unknown = contribute(rpc, {
    point: 'tool-view', id: 'bad.component', tool: 'search',
    view: { component: 'plugin-react-component', text: 'own chrome' },
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error.message, /unknown component/);

  for (const view of [
    { component: 'text', text: 'click', onClick() {} },
    { component: 'text', text: 'styled', style: { position: 'fixed' } },
    { component: 'text', text: 'renderer', renderer: '() => document.body' },
  ]) {
    const refused = contribute(rpc, { point: 'tool-view', id: 'bad.code', tool: 'search', view });
    assert.equal(refused.ok, false);
    assert.match(refused.error.message, /executable|renderer code|DOM access|styling/);
  }
  const listed = rpc.invoke({ method: 'ui.list', params: {} });
  assert.deepEqual(listed.result, [], 'refused declarations never become renderer input');
});

test('trace, settings and library extension points have the same typed seam', () => {
  const rpc = createUiExtensionRpcBoundary();
  const declarations = [
    { point: 'trace-decoration', id: 'example.trace', event: 'tool.call', view: { component: 'badge', text: 'External' } },
    { point: 'settings-section', id: 'example.settings', title: 'Example', view: { component: 'notice', text: 'Managed by the plugin.' } },
    { point: 'library-entry', id: 'example.library', title: 'Example block', description: 'An installed contribution.' },
  ];
  for (const declaration of declarations) assert.equal(contribute(rpc, declaration).ok, true);
  assert.deepEqual(rpc.invoke({ method: 'ui.list', params: {} }).result.map(row => row.contribution.point),
    ['trace-decoration', 'settings-section', 'library-entry']);
});

test('the Flyt renderer has an exhaustive closed component dispatch and owns both real surfaces', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../src/v2/PluginContributionView.jsx', import.meta.url)), 'utf8');
  for (const component of UI_COMPONENTS) assert.match(source, new RegExp(`case '${component}'`));
  assert.match(source, /export function BlockConfigurationView/);
  assert.match(source, /export function ToolContributionView/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|createElement\(node\.component|node\.style/);
});
