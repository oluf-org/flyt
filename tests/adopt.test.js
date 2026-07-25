// Adopt (D28): promoting a flow designed in the installed app into a shipped
// default. The invariants that matter are the id rewrite, the layout sidecar
// following the rename, and the "will this actually ship?" check — the last is
// what keeps a promoted flow from being silently excluded by electron-builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFlow } from '../core/flowlang/parse.js';
import {
  adoptFlow, listFlows, reidFlowText, slugFlowId, willShip, installedFlowsDir, PRODUCT_NAME
} from '../core/flowlang/adopt.js';

const FLOW = `version: 1
id: flow-mrkhw5q9-eaxv
name: Deep Research v2
description: A hand-built flow.

nodes:
  research:
    use: work

flow:
  - input -> research
  - research -> output
`;

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  const from = path.join(dir, 'installed');
  const to = path.join(dir, 'repo-flows');
  fs.mkdirSync(from, { recursive: true });
  fs.mkdirSync(to, { recursive: true });
  return { dir, from, to };
}

function seed(from, id = 'flow-mrkhw5q9-eaxv', { layout = true } = {}) {
  fs.writeFileSync(path.join(from, `${id}.flow.yaml`), FLOW.replace('flow-mrkhw5q9-eaxv', id));
  if (layout) fs.writeFileSync(path.join(from, `${id}.layout.json`), JSON.stringify({ research: { x: 10, y: 20 } }));
}

test('adopt: slugs the flow name into a stable, shippable id', () => {
  assert.equal(slugFlowId('Deep Research v2'), 'deep-research-v2');
  assert.equal(slugFlowId('  GPT-5 · strict!  '), 'gpt-5-strict');
  assert.equal(slugFlowId('///'), null);
});

test('adopt: scratch ids are exactly the ones electron-builder excludes', () => {
  assert.equal(willShip('deep-research-v2'), true);
  assert.equal(willShip('flow-mrkhw5q9-eaxv'), false);
  assert.equal(willShip('flow-test'), false); // a name like "Flow test" is the trap
  assert.equal(willShip('bad id'), false);
});

test('adopt: re-id rewrites only the id line and re-parses', () => {
  const out = reidFlowText(FLOW, 'deep-research-v2');
  assert.equal(parseFlow(out).id, 'deep-research-v2');
  assert.equal(parseFlow(out).name, 'Deep Research v2');
  assert.match(out, /description: A hand-built flow\./);
  assert.equal(out.includes('flow-mrkhw5q9-eaxv'), false);
  assert.throws(() => reidFlowText(FLOW, 'not a slug'), /Invalid flow id/);
  assert.throws(() => reidFlowText('version: 1\nname: x\n', 'ok'), /no top-level "id:"/);
});

test('adopt: copies flow + layout under the new id', () => {
  const { from, to } = tmp();
  seed(from);
  const r = adoptFlow({ from, to, id: 'flow-mrkhw5q9-eaxv' });

  assert.equal(r.id, 'deep-research-v2');
  assert.equal(r.ships, true);
  assert.equal(r.layout, true);
  assert.equal(parseFlow(fs.readFileSync(r.file, 'utf8')).id, 'deep-research-v2');
  // The sidecar is keyed by NODE id — the rename must not disturb its contents.
  const layout = JSON.parse(fs.readFileSync(path.join(to, 'deep-research-v2.layout.json'), 'utf8'));
  assert.deepEqual(layout, { research: { x: 10, y: 20 } });
  // The source is left alone: adopting is a copy, not a move.
  assert.ok(fs.existsSync(path.join(from, 'flow-mrkhw5q9-eaxv.flow.yaml')));
});

test('adopt: --as overrides the slug; a missing layout is not fatal', () => {
  const { from, to } = tmp();
  seed(from, 'flow-abc', { layout: false });
  const r = adoptFlow({ from, to, id: 'flow-abc', as: 'house-style' });
  assert.equal(r.id, 'house-style');
  assert.equal(r.layout, false);
  assert.ok(fs.existsSync(path.join(to, 'house-style.flow.yaml')));
});

test('adopt: refuses to clobber an existing default unless forced', () => {
  const { from, to } = tmp();
  seed(from);
  adoptFlow({ from, to, id: 'flow-mrkhw5q9-eaxv' });
  assert.throws(() => adoptFlow({ from, to, id: 'flow-mrkhw5q9-eaxv' }), /already exists/);
  assert.doesNotThrow(() => adoptFlow({ from, to, id: 'flow-mrkhw5q9-eaxv', overwrite: true }));
});

test('adopt: unknown flow id fails loudly', () => {
  const { from, to } = tmp();
  assert.throws(() => adoptFlow({ from, to, id: 'nope' }), /no flow "nope"/);
});

test('adopt: lists installed flows, newest first, skipping unparseable files', () => {
  const { from } = tmp();
  seed(from, 'flow-old');
  seed(from, 'flow-new');
  fs.utimesSync(path.join(from, 'flow-new.flow.yaml'), new Date(), new Date(Date.now() + 10_000));
  fs.writeFileSync(path.join(from, 'junk.flow.yaml'), 'not: a flow\n');

  const list = listFlows(from);
  assert.deepEqual(list.map(f => f.id), ['flow-new', 'flow-old']);
  assert.equal(list[0].ships, false);
  assert.deepEqual(listFlows(path.join(from, 'does-not-exist')), []);
});

// PRODUCT_NAME (= core/brand.js APP_NAME) is the directory Electron derives
// userData from, so this asserts against the constant rather than a literal:
// hard-coding the name here would make a rename fail in the CLI at the same
// moment the test claimed it was fine.
test('adopt: resolves the installed data dir per platform', () => {
  const win = installedFlowsDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } });
  assert.match(win, new RegExp(`${PRODUCT_NAME}.flows$`));
  const mac = installedFlowsDir({ platform: 'darwin', env: {}, home: '/Users/x' });
  assert.equal(mac, path.join('/Users/x', 'Library', 'Application Support', PRODUCT_NAME, 'flows'));
  const linux = installedFlowsDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/x/.config' } });
  assert.equal(linux, path.join('/home/x/.config', PRODUCT_NAME, 'flows'));
});
