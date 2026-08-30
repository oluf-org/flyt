import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every local app entry point compiles the kernel before Electron can load it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.predev, /build:kernel/);
  assert.match(pkg.scripts.dev, /kernel --watch|tsc -p kernel --watch/);
  assert.match(pkg.scripts.dev, /watch-electron\.mjs/);
  assert.match(pkg.scripts.start, /npm run build/);
  for (const name of ['dist', 'dist:win', 'dist:mac', 'dist:linux', 'release']) {
    assert.match(pkg.scripts[name], /npm run build/, `${name} builds before packaging`);
  }
});

test('even direct electron-builder calls rebuild at the packager boundary', () => {
  const config = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  const hook = fs.readFileSync(path.join(root, 'scripts', 'build-before-pack.mjs'), 'utf8');
  assert.match(config, /beforePack:\s*scripts\/build-before-pack\.mjs/);
  assert.match(hook, /npm run build/);
});
