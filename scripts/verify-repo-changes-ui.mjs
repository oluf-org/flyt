import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FLYT_PLAYWRIGHT_ROOT || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.flyt', 'repo-changes-ui');
fs.mkdirSync(output, { recursive: true });
let server, browser;
try {
  server = await createServer({ root, configFile: false, plugins: [react(), {
    name: 'repo-changes-verification', configureServer(host) {
      host.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__repo-changes-test') return next();
        const html = await server.transformIndexHtml(req.url, `<!doctype html><html><head><title>Repository changes</title></head><body><div id="root"></div><script type="module">
          import React from 'react'; import { createRoot } from 'react-dom/client';
          import RepoChanges from '/src/v2/RepoChanges.jsx';
          import '/src/styles.css'; import '/src/v2/workStyles.css';
          window.opened = []; window.reads = 0;
          window.flyt = {
            getRepoChanges: async () => { window.reads++; return { available: true, files: [
              {path:'src/new feature.jsx', status:'created', added:82, deleted:0},
              {path:'src/workflow/runner.js', status:'modified', added:14, deleted:7},
              {path:'src/obsolete.js', status:'deleted', added:0, deleted:36},
              {path:'assets/logo.png', status:'created', binary:true, added:null, deleted:null}
            ]}; },
            openChangedFile: async (...args) => { window.opened.push(args); if (args[2].endsWith('.png')) throw new Error('No default program is configured'); }
          };
          createRoot(document.getElementById('root')).render(React.createElement('main', {style:{padding:24,maxWidth:1000,margin:'auto'}},
            React.createElement('h1', null, 'Workflow run'), React.createElement(RepoChanges, {projectId:'project',runId:'run',running:false})));
        </script></body></html>`);
        res.setHeader('Content-Type', 'text/html'); res.end(html);
      });
    },
  }], optimizeDeps: { entries: ['src/v2/RepoChanges.jsx'], include: ['react', 'react-dom/client'] },
  cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 5189 } });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.FLYT_BROWSER_EXECUTABLE ? { executablePath: process.env.FLYT_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__repo-changes-test`);
  await page.getByRole('button', { name: 'src/new feature.jsx' }).click();
  assert.deepEqual(await page.evaluate(() => window.opened), [['project', 'run', 'src/new feature.jsx']]);
  assert.equal(await page.getByRole('button', { name: 'src/obsolete.js' }).isDisabled(), true);
  assert.match(await page.locator('summary').innerText(), /4 files.*\+96.*−43/);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => window.reads === 2);
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await page.getByRole('button', { name: 'assets/logo.png' }).click();
  await page.getByRole('alert').filter({ hasText: 'No default program' }).waitFor();
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: path.join(output, 'narrow.png') });
  assert.deepEqual(errors, []);
  console.log('Repository changes UI passed: counts, file opening, deleted files, errors, refresh and narrow layout.');
} finally {
  await browser?.close();
  await server?.close();
}
