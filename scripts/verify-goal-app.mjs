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
const output = path.join(root, 'docs/reviews/goal-ui-e2e'); fs.mkdirSync(output, { recursive: true });
const replay = process.env.FLYT_VERIFY_REPLAY_ROOT ? JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8')) : null;
const workspace = replay?.goal.contract.folder ?? fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-goal-live-'));
const title = `Live Goal acceptance ${Date.now()}`;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.FLYT_TEST_MOCK_PROVIDER;
const verificationRoot = process.env.FLYT_VERIFY_REPLAY_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-ui-profile-'));
const profile = path.join(verificationRoot, 'profile'); fs.mkdirSync(profile, { recursive: true });
const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'flyt', 'settings.json'), 'utf8'));
delete settings.projects; settings.mock = false;
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
env.FLYT_VERIFY_USER_DATA = profile; env.FLYT_VERIFY_DATA_ROOT = path.join(verificationRoot, 'data');
const launch = () => _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], cwd: root, env, timeout: 30000 });
let app;
let page;
try {
  app = await launch();
  page = await app.firstWindow();
  page.on('pageerror', error => console.error('Renderer error:', error.message));
  await page.waitForFunction(() => Boolean(window.flyt?.goal));
  await page.evaluate(folder => window.flyt.openProject(folder), workspace);
  await page.reload();
  await page.getByRole('button', { name: 'Goals', exact: true }).click({ timeout: 30000 });
  if (replay) {
    await page.getByLabel('Saved goals', { exact: true }).click();
    await page.locator(`.goal-picker-name[data-id="${replay.goal.id}"]`).click();
    await page.getByLabel('Definition revision', { exact: true }).selectOption('running');
    await page.locator('.goal-node').filter({ hasText: 'Build / improve candidate' }).getByText('Done', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('status').filter({ hasText: 'achieved' }).waitFor();
    await page.screenshot({ path: path.join(output, 'goal-result.png'), fullPage: true });
    await page.getByRole('button', { name: 'Inspect memory', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'goal-memory.png'), fullPage: true });
    console.log('Replayed achieved Goal; canonical node status is Done. No model calls.');
  } else {
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(title);
  await page.getByLabel('Objective', { exact: true }).fill('Exercise the Goal loop with a staged text artifact. Read the CURRENT iteration number in the Goal context. If it is 1, return {"candidate":{"text":"ALPHA"}}. If it is 2 or later, return {"candidate":{"text":"ALPHA BETA"}}. Return exactly ONE JSON object for the current iteration only. Do not show both objects or simulate future iterations. This staged fixture intentionally needs two iterations.');
  await page.getByLabel('Fixed constraints', { exact: true }).fill('Do not use tools. Do not change the checks. Preserve the original objective across steps.');
  await page.getByLabel('Acceptance checks', { exact: true }).fill('ALPHA\nBETA');
  const model = process.env.FLYT_VERIFY_MODEL || 'z-ai/glm-5.3-flash';
  await page.getByLabel('Goal model', { exact: true }).selectOption(model);
  await page.getByLabel('Iterations', { exact: true }).fill('3');
  await page.getByLabel('Model calls', { exact: true }).fill('12');
  await page.getByLabel('Minutes', { exact: true }).fill('6');
  await page.getByLabel('Run setup once', { exact: true }).check();
  await page.getByLabel('Human review after each iteration', { exact: true }).check();
  await page.getByRole('button', { name: 'Save field edits', exact: true }).click();
  await page.getByRole('button', { name: 'Lock model from AI', exact: true }).click();
  await page.locator('.goal-node').filter({ hasText: 'Build / improve candidate' }).click();
  const instruction = page.locator('#goal-field-recipe-improve-config-instructions');
  await instruction.waitFor();
  const beforeBounds = await page.locator('.goal-canvas').boundingBox();
  await instruction.locator('..').getByRole('button', { name: 'Ask AI to change…', exact: true }).click();
  await page.getByLabel('Change request message', { exact: true }).fill('Append exactly this sentence to the instructions: Return the complete current candidate. Preserve every existing instruction.');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Design your loop', exact: true }).count(), 0);
  assert.equal(await page.getByRole('complementary', { name: 'Step inspector' }).count(), 1);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  assert.match(await page.getByLabel('Change request message', { exact: true }).inputValue(), /Append exactly/);
  assert.deepEqual(await page.locator('.goal-canvas').boundingBox(), beforeBounds);
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => Boolean(document.activeElement.closest('dialog[open]'))), 'Focus must stay inside the modal');
  }
  await page.keyboard.press('Escape');
  const savedDraft = await page.getByLabel('Saved goals', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  assert.equal(await page.getByLabel('Change request message', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('.goal-chat-quotes>span').count(), 0, 'No quote may leak between drafts');
  await page.keyboard.press('Escape');
  await page.getByLabel('Saved goals', { exact: true }).click();
    await page.locator(`.goal-picker-name[data-id="${savedDraft}"]`).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  assert.match(await page.getByLabel('Change request message', { exact: true }).inputValue(), /Append exactly/);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Design your loop', exact: true }).count(), 0, 'Reload keeps chat closed');
  await page.setViewportSize({ width: 620, height: 840 });
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  assert.match(await page.getByLabel('Change request message', { exact: true }).inputValue(), /Append exactly/);
  const narrow = await page.getByRole('dialog', { name: 'Design your loop', exact: true }).boundingBox();
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 620 && narrow.y >= 0 && narrow.y + narrow.height <= 840);
  await page.screenshot({ path: path.join(output, 'narrow-chat.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.locator('.goal-node').filter({ hasText: 'Build / improve candidate' }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Authoring model', { exact: true }).selectOption(model);
  await page.screenshot({ path: path.join(output, 'change-request.png'), fullPage: true });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Close change request', exact: true }).click();
  await page.getByRole('button', { name: 'Accept proposal', exact: true }).waitFor({ timeout: 200000 });
  assert.equal(await page.getByRole('dialog', { name: 'Design your loop', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(output, 'pending-changes.png'), fullPage: true });
  await page.getByRole('button', { name: 'Accept proposal', exact: true }).click();
  await page.getByRole('button', { name: 'Back to loop overview', exact: true }).click();
  await page.getByRole('button', { name: 'Review and start', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'goal-ready.png'), fullPage: true });
  await page.getByRole('button', { name: 'Approve and start', exact: true }).click();
  console.log('Started live Goal through Electron UI');
  const deadline = Date.now() + 400000;
  let restarted = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async title => {
      const projects = await window.flyt.listProjects();
      const goals = await window.flyt.goal('list', { projectId: projects.active });
      const goal = goals.find(item => item.name === title);
      return goal;
    }, title);
    if (state?.pendingResult && !state.live) {
      if (!restarted) {
        await page.screenshot({ path: path.join(output, 'human-review.png'), fullPage: true });
        await app.close(); app = await launch(); page = await app.firstWindow();
        await page.getByRole('button', { name: 'Goals', exact: true }).click({ timeout: 30000 });
        await page.getByRole('button', { name: 'Approve result', exact: true }).waitFor({ timeout: 30000 });
        restarted = true;
      }
      await page.getByRole('button', { name: 'Approve result', exact: true }).click();
      if (!state.current.verified) {
        await page.getByRole('button', { name: 'Review and resume', exact: true }).click();
        await page.getByRole('button', { name: 'Approve and start', exact: true }).click();
      }
    } else if (state && !state.live && !['ready', 'running', 'paused'].includes(state.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  const evidence = await page.evaluate(async title => {
    const projects = await window.flyt.listProjects();
    const goals = await window.flyt.goal('list', { projectId: projects.active });
    const goal = goals.find(item => item.name === title);
    const best = goal.best ? await window.flyt.goal('inspect', { projectId: projects.active, goalId: goal.id, record: goal.best.artifact }) : null;
    const authoring = await window.flyt.goal('author-read', { projectId: projects.active, draftId: goal.contract.authoringId });
    return { goal, best, authoring };
  }, title);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  await page.getByRole('status').filter({ hasText: evidence.goal.status.replaceAll('_', ' ') }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: path.join(output, 'goal-result.png'), fullPage: true });
  console.log(JSON.stringify({ id: evidence.goal.id, status: evidence.goal.status, reason: evidence.goal.reason, iterations: evidence.goal.iteration, calls: evidence.goal.calls, best: evidence.best?.candidate.text }));
  assert.equal(evidence.goal.status, 'achieved', evidence.goal.reason);
  assert(evidence.goal.iteration >= 2, 'Must actually loop');
  assert.equal(evidence.goal.setupDone, true);
  assert.equal(evidence.best.candidate.text, 'ALPHA BETA');
  assert.equal(evidence.goal.contract.worker.model, model);
  assert.equal(evidence.goal.resultReviews.length, 2);
  assert.equal(restarted, true);
  await page.getByRole('button', { name: 'Inspect memory', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'goal-memory.png'), fullPage: true });
  }
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 7000));
  }
  throw error;
} finally {
  try { await app?.close(); } finally {
    // Verification evidence contains definitions and usage, never credentials.
    fs.rmSync(path.join(profile, 'settings.json'), { force: true });
  }
}
