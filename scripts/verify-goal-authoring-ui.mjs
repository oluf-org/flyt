// Browser interaction test with the real authoring controller and a deterministic
// model boundary. No paid calls, execution runs, or personal project data.
// Set FLYT_PLAYWRIGHT_ROOT to an installed Playwright package if not local.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { GoalController } from '../core/goalController.js';
import { GoalAuthoring } from '../core/goalAuthoring.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FLYT_PLAYWRIGHT_ROOT || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-authoring-ui-'));
const workspace = path.join(temporary, 'workspace'); fs.mkdirSync(workspace);
const sourceWorkspace = path.join(temporary, 'source'); fs.mkdirSync(sourceWorkspace);
fs.writeFileSync(path.join(workspace, 'notes.md'), 'Keep the result concise and include ALPHA.');
const output = path.join(root, 'docs/reviews/goal-authoring-chat'); fs.mkdirSync(output, { recursive: true });
const models = [{ id: 'test-author', source: 'mock', enabled: true }];
const goals = new GoalController({ runs: {}, project: id => id === 'source-project' ? ({ id, name: 'Source project', folder: sourceWorkspace, store: { rootDir: path.join(temporary, 'source-runs') } }) : ({ id: 'test-project', name: 'Destination project', folder: workspace, store: { rootDir: path.join(temporary, 'runs') } }), worker: () => ({ provider: 'mock', model: 'test-author' }) });
const contexts = [];
const replace = (address, value) => ({ op: 'replace', address, value });
const author = new GoalAuthoring({ root: path.join(temporary, 'authoring'), goals, models: () => models, call: async ({ prompt, onText }) => {
  const context = JSON.parse(prompt); contexts.push(context);
  let response;
  if (context.request === 'Explain the loop') response = { type: 'message', text: 'Each iteration produces a candidate and checks it against the fixed criteria.' };
  else if (context.request === 'What do you need?') response = { type: 'question', text: 'Which artifact should the loop produce?' };
  else if (context.request === 'Try outside scope') response = { type: 'proposal', operations: [replace('goal/name', 'Outside scope')], rationale: 'Intentionally invalid test proposal' };
  else if (context.request === 'Change the budget') response = { type: 'proposal', operations: [replace('goal/limits', { ...context.definition.limits, iterations: 4 })], rationale: 'Limit the loop to four iterations.' };
  else if (context.exchanges.length === 0) response = { type: 'tool', name: 'read_project_file', arguments: { path: 'notes.md' } };
  else if (context.exchanges.length === 1) response = { type: 'tool', name: 'inspect_block', arguments: { use: 'flyt-blocks-core:general-analysis' } };
  else if (context.exchanges.length === 2) response = { type: 'tool', name: 'validate_proposal', arguments: { operations: [replace('recipe/improve/config/instructions', 'Return a concise candidate containing ALPHA.')] } };
  else response = { type: 'proposal', operations: [replace('recipe/improve/config/instructions', 'Return a concise candidate containing ALPHA.')], rationale: 'Use the requirements from notes.md.' };
  if (context.request === 'Explain the loop') {
    onText?.('partial response', { content: '{"type":"message",', telemetry: { contentChars: 18, reasoningChars: 0 } });
    await new Promise(resolve => setTimeout(resolve, 2200));
  }
  return { text: JSON.stringify(response), usage: { cost: 0.001 } };
} });
let server, browser;
try {
  const middleware = async (req, res, next) => {
    if (req.url === '/__authoring-test') {
      const html = await server.transformIndexHtml(req.url, `<!doctype html><html><head><title>Goal authoring verification</title></head><body><div id="root" style="height:100vh;display:flex"></div><script type="module">
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import GoalPage from '/src/v2/GoalPage.jsx';
        import '/src/styles.css';
        window.flyt = { getSettings: async () => ({activeModels: ${JSON.stringify(models)}}), goal: async (action, args) => {
          const response = await fetch('/__authoring-api', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action,args})});
          const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
        }};
        createRoot(document.getElementById('root')).render(React.createElement(GoalPage, {projectId:'test-project'}));
      </script></body></html>`);
      res.setHeader('Content-Type', 'text/html'); res.end(html); return;
    }
    if (req.url !== '/__authoring-api') return next();
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 200000) throw new Error('Request too large'); }
      const { action, args } = JSON.parse(body);
      const authorActions = { 'author-open': 'open', 'author-list': 'list', 'author-read': 'read', 'author-ui': 'ui', 'author-message': 'author', 'author-edit': 'edit', 'author-lock': 'setLock', 'author-review': 'review', 'author-cancel': 'cancel', 'library': 'library', 'reuse': 'reuse', 'requirements': 'requirements' };
      const value = authorActions[action] ? await author[authorActions[action]](args) : action === 'list' ? [] : action === 'draft' ? await goals.draft(args) : (() => { throw new Error(`Unsupported test action ${action}`); })();
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
  };
  server = await createServer({ root, configFile: false, plugins: [react(), { name: 'authoring-test', configureServer(host) { host.middlewares.use(middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.FLYT_BROWSER_EXECUTABLE ? { executablePath: process.env.FLYT_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__authoring-test`);
  console.log('Loaded authoring UI');
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const pickModel = async () => { await page.getByRole('button', { name: /^Authoring model: / }).click(); await page.getByRole('group', { name: 'Authoring model', exact: true }).getByRole('button', { name: 'test-author', exact: true }).click(); };
  await page.screenshot({ path: path.join(output, 'empty.png'), animations: 'disabled' });
  await pickModel();
  const send = async text => { await page.getByLabel('Change request message', { exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); };
  // The scope and the context files are pills that open a popover of real
  // buttons, so read them from the trigger and set them by clicking a choice.
  const pill = label => page.getByRole('button', { name: new RegExp(`^${label}: `) });
  const pillValue = async label => (await pill(label).getAttribute('aria-label')).slice(label.length + 2);
  const pickScope = async option => { await pill('Edit scope').click(); await page.getByRole('group', { name: 'Edit scope', exact: true }).getByRole('button', { name: option, exact: true }).click(); };
  await send('Explain the loop');
  await page.getByRole('status').filter({ hasText: 'Receiving response' }).waitFor();
  await page.getByText('Each iteration produces a candidate and checks it against the fixed criteria.', { exact: true }).waitFor();
  await send('What do you need?');
  await page.locator('.goal-chat-history p').filter({ hasText: 'Which artifact should the loop produce?' }).waitFor();
  console.log('Verified conversational replies');
  // Escape belongs to the open popup first: the change request must survive it.
  await pill('Edit scope').click();
  await page.screenshot({ path: path.join(output, 'scope-menu.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Design your loop', exact: true }).waitFor();
  await pickScope('Build / improve candidate');
  assert.equal(await pillValue('Edit scope'), 'Build / improve candidate');
  await pill('Project files').click();
  await page.getByLabel('Project files for context', { exact: true }).fill('notes.md');
  await page.keyboard.press('Escape');
  assert.equal(await pillValue('Project files'), '1 file');
  await send('Use notes.md');
  await page.getByText('Use the requirements from notes.md.', { exact: true }).last().waitFor();
  assert.equal(await page.locator('.goal-chat-tool > summary').filter({ hasText: /Read project file|Inspect block|Validate proposal/ }).count(), 3);
  console.log('Verified read-only tool sequence');
  assert.equal(contexts.find(context => context.request === 'Use notes.md').conversation.turns[1].assistant.type, 'question');
  await page.screenshot({ path: path.join(output, 'conversation.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Accept proposal', exact: true }).click();
  await page.locator('.goal-node').filter({ hasText: 'Build / improve candidate' }).click();
  const instruction = page.locator('#goal-field-recipe-improve-config-instructions');
  assert.equal(await instruction.inputValue(), 'Return a concise candidate containing ALPHA.');
  await instruction.locator('..').getByRole('button', { name: 'Ask AI to change…', exact: true }).click();
  assert.equal(await pillValue('Edit scope'), 'Selected fields');
  // A field scope with nothing in it cannot be sent, and has to say so.
  await page.getByRole('button', { name: 'Remove quote 1', exact: true }).click();
  await page.locator('.goal-composer-warn').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'empty-field-scope.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await instruction.locator('..').getByRole('button', { name: 'Ask AI to change…', exact: true }).click();
  await send('Try outside scope');
  await page.locator('.goal-chat article').last().locator('.goal-error').waitFor();
  assert.equal(author.read({ projectId: 'test-project', draftId: author.list({ projectId: 'test-project' })[0].id }).definition.name, 'My goal');
  await page.reload();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  assert.equal(await pillValue('Edit scope'), 'Selected fields');
  await pill('Project files').click();
  assert.equal(await page.getByLabel('Project files for context', { exact: true }).inputValue(), 'notes.md');
  await page.keyboard.press('Escape');
  await pickScope('Entire loop');
  assert.equal(await page.locator('.goal-chat-quotes>span').count(), 0);
  await pickModel();
  await send('Change the budget');
  await page.getByText('Limit the loop to four iterations.', { exact: true }).last().waitFor();
  await page.keyboard.press('Escape');
  const setting = page.locator('.goal-pending-review details').filter({ hasText: 'Execution setting' });
  assert.equal(await setting.getAttribute('open'), '');
  await page.getByRole('button', { name: 'Reject proposal', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.setViewportSize({ width: 620, height: 840 });
  const dialog = page.getByRole('dialog', { name: 'Design your loop', exact: true });
  const bounds = await dialog.boundingBox();
  assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 620 && bounds.y + bounds.height <= 840);
  const sendBounds = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  assert(sendBounds.y + sendBounds.height <= 840);
  await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1400, height: 900 });
  const { GOAL_RECIPE } = await import('../src/v2/goalDefaults.js');
  const source = await author.open({ projectId: 'source-project', definition: { name: 'Reusable security audit', objective: 'Audit the repository', recipe: GOAL_RECIPE, folder: sourceWorkspace, createFolder: false, requiredPaths: ['src', 'docs/security.md'] } });
  await page.getByRole('button', { name: 'Loop library', exact: true }).click();
  await page.getByRole('dialog', { name: 'Loop library', exact: true }).waitFor();
  await page.getByRole('searchbox', { name: 'Search loops' }).fill('security audit');
  await page.screenshot({ path: path.join(output, 'shared-library.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Use Reusable security audit in this project', exact: true }).click();
  await page.getByText('2 project warnings', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Workspace folder', { exact: true }).inputValue(), '');
  const pathsField = page.getByLabel('Required project paths', { exact: false });
  assert.equal(await pathsField.inputValue(), 'src\ndocs/security.md');
  assert.equal(await pathsField.locator('..').evaluate(node => node.classList.contains('path-warning')), true);
  assert.equal((await author.list({ projectId: 'test-project' })).some(item => item.id === source.id), false);
  await page.locator('.goal-sidebar').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'project-requirements.png'), animations: 'disabled' });
  await page.locator('.goal-requirements .missing').first().getByRole('button', { name: 'Go to field' }).click();
  await page.waitForFunction(() => document.activeElement?.id === 'goal-field-goal-requiredPaths');
  // Ordinary typing must preserve newlines until Save parses the path list.
  await pathsField.fill('src'); await pathsField.press('End'); await pathsField.press('Enter'); await pathsField.pressSequentially('docs/security.md');
  assert.equal(await pathsField.inputValue(), 'src\ndocs/security.md');
  await page.getByRole('button', { name: 'Save field edits', exact: true }).click();
  fs.mkdirSync(path.join(workspace, 'src')); fs.mkdirSync(path.join(workspace, 'docs')); fs.writeFileSync(path.join(workspace, 'docs/security.md'), 'requirements');
  await page.getByRole('button', { name: 'Recheck paths' }).click();
  await page.getByText('Project requirements available', { exact: true }).waitFor();
  assert.equal(await pathsField.locator('..').evaluate(node => node.classList.contains('path-warning')), false);
  await page.getByLabel('Create a new folder for each run').check();
  await page.getByRole('button', { name: 'Save field edits', exact: true }).click();
  await page.getByText('3 project warnings', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review and start', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review and start', exact: true });
  await review.getByText('3 project warnings', { exact: true }).waitFor();
  assert.equal(await review.getByRole('button', { name: 'Approve and start' }).isEnabled(), true);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByText('3 project warnings', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Loop library', exact: true }).click();
  await page.setViewportSize({ width: 620, height: 840 });
  const libraryBounds = await page.getByRole('dialog', { name: 'Loop library', exact: true }).boundingBox();
  assert(libraryBounds.x >= 0 && libraryBounds.y >= 0 && libraryBounds.x + libraryBounds.width <= 620 && libraryBounds.y + libraryBounds.height <= 840);
  console.log('Verified cross-project library, fresh binding, missing-path highlights, recheck, typing, review warnings and reload');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, modelCalls: contexts.length, screenshots: output, checks: ['message and question', 'conversation memory', 'read and validation traces', 'step proposal acceptance', 'empty field scope refuses to send', 'field scope rejection', 'reload persistence', 'execution-setting review', 'narrow viewport'] }));
} catch (error) { console.error(error); throw error; } finally {
  await browser?.close(); await author.shutdown(); await server?.close();
  const relative = path.relative(os.tmpdir(), temporary);
  if (relative.startsWith('flyt-authoring-ui-') && !relative.includes(path.sep)) fs.rmSync(temporary, { recursive: true, force: true });
}
