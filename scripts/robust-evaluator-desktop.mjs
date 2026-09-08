// Launch with: electron scripts/robust-evaluator-desktop.mjs
// The ordinary application loads after a deterministic provider is registered.
import fs from 'node:fs';
import { app } from 'electron';
const fixture = JSON.parse(fs.readFileSync(new URL('../.flyt/robust-desktop.json', import.meta.url), 'utf8'));
process.env.FLYT_TEST_MOCK_PROVIDER = '1';
process.env.FLYT_SANDBOX_MODE = 'danger-full-access';
process.env.FLYT_VERIFY_USER_DATA = fixture.profile;
process.env.FLYT_VERIFY_DATA_ROOT = fixture.data;
const { registerProvider } = await import('../core/adapters/index.js');
const { syntheticProvider } = await import('../tests/fixtures/robustEvaluator.js');
registerProvider('mock', syntheticProvider);
app.on('browser-window-created', (_event, window) => {
  window.on('page-title-updated', event => { event.preventDefault(); });
  window.setTitle('Flyt — Synthetic evaluator acceptance');
});
await import('../electron/main.js');
