// Live-provider Electron verification. Set FLYT_PLAYWRIGHT_ROOT to an installed
// Playwright package directory. This deliberately does not enable mock mode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.FLYT_PLAYWRIGHT_ROOT || 'playwright');
const output = path.join(root, 'docs/reviews/goal-e2e'); fs.mkdirSync(output, { recursive: true });
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-goal-live-'));
const title = `Live Goal acceptance ${Date.now()}`;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.FLYT_TEST_MOCK_PROVIDER;
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], cwd: root, env, timeout: 30000 });
let page;
try {
  page = await app.firstWindow();
  page.on('pageerror', error => console.error('Renderer error:', error.message));
  await page.waitForFunction(() => Boolean(window.flyt?.goal));
  await page.evaluate(folder => window.flyt.openProject(folder), workspace);
  await page.reload();
  await page.getByRole('button', { name: 'Goals', exact: true }).click({ timeout: 30000 });
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(title);
  await page.getByLabel('Objective', { exact: true }).fill('Exercise the Goal loop with a staged text artifact. Read the CURRENT iteration number in the Goal context. If it is 1, return {"candidate":{"text":"ALPHA"}}. If it is 2 or later, return {"candidate":{"text":"ALPHA BETA"}}. Return exactly ONE JSON object for the current iteration only. Do not show both objects or simulate future iterations. This staged fixture intentionally needs two iterations.');
  await page.getByLabel('Fixed constraints', { exact: true }).fill('Do not use tools. Do not change the checks. Preserve the original objective across steps.');
  await page.getByLabel('Acceptance checks', { exact: false }).fill('ALPHA\nBETA');
  await page.getByLabel('Goal model', { exact: true }).selectOption(process.env.FLYT_VERIFY_MODEL || 'openai/gpt-3.5-turbo');
  await page.getByLabel('Iterations', { exact: true }).fill('3');
  await page.getByLabel('Model calls', { exact: true }).fill('6');
  await page.getByLabel('Minutes', { exact: true }).fill('3');
  await page.getByLabel('Run setup once', { exact: true }).check();
  await page.getByRole('button', { name: 'Save goal', exact: true }).click();
  await page.getByRole('button', { name: 'Start goal', exact: true }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: path.join(output, 'goal-ready.png'), fullPage: true });
  await page.getByRole('button', { name: 'Start goal', exact: true }).click();
  console.log('Started live Goal through Electron UI');
  const deadline = Date.now() + 200000;
  while (Date.now() < deadline) {
    const settled = await page.evaluate(async title => {
      const projects = await window.flyt.listProjects();
      const goals = await window.flyt.goal('list', { projectId: projects.active });
      const goal = goals.find(item => item.name === title);
      return goal && !goal.live && !['ready', 'running'].includes(goal.status);
    }, title);
    if (settled) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  const evidence = await page.evaluate(async title => {
    const projects = await window.flyt.listProjects();
    const goals = await window.flyt.goal('list', { projectId: projects.active });
    const goal = goals.find(item => item.name === title);
    const best = goal.best ? await window.flyt.goal('inspect', { projectId: projects.active, goalId: goal.id, record: goal.best.artifact }) : null;
    return { goal, best };
  }, title);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  await page.getByRole('status').filter({ hasText: evidence.goal.status.replaceAll('_', ' ') }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: path.join(output, 'goal-result.png'), fullPage: true });
  console.log(JSON.stringify({ id: evidence.goal.id, status: evidence.goal.status, reason: evidence.goal.reason, iterations: evidence.goal.iteration, calls: evidence.goal.calls, best: evidence.best?.candidate.text }));
  assert.equal(evidence.goal.status, 'achieved', evidence.goal.reason);
  assert(evidence.goal.iteration >= 2, 'Must actually loop');
  assert.equal(evidence.goal.setupDone, true);
  assert.equal(evidence.best.candidate.text, 'ALPHA BETA');
  await page.getByRole('button', { name: 'Inspect memory', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'goal-memory.png'), fullPage: true });
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 7000));
  }
  throw error;
} finally { await app.close(); }
