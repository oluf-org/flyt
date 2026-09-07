// Real canonical authoring controller and production React UI. Unrelated app
// services use preview fixtures; execution is explicitly disabled in this test.
// Live model execution is covered separately by verify-all-blocks-live.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { bootKernel } from '../core/v2.js';
import { createV2BuildController, createV2HostBridge } from '../core/v2Host.js';
import { StackStore } from '../core/stackstore.js';
import { parseStack, walk } from '#kernel';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FLYT_PLAYWRIGHT_ROOT || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'docs/reviews/block-audit');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-block-authoring-'));
const store = new StackStore(path.join(temp, 'stacks'), { parseStack });
store.save('audit', 'version: 2\nid: audit\nname: Block editor audit\nlaunchable: true\nblocks:\n  - id: starter\n    use: flyt-blocks-core:general-analysis\n');
const booted = await bootKernel({ call: true, env: {}, profile: 'flyt-desktop', runsRoot: path.join(temp, 'runs') });
const controller = await createV2BuildController(booted, { stacks: store });
const bridge = createV2HostBridge(booted, { build: () => controller.snapshot() });
const report = { blocks: [], controls: [], checks: [], errors: [] };
let events = [], browser, server, page;
const detach = controller.subscribe(event => events.push(event));
const methods = {
  v2Build: () => bridge.build(),
  v2OpenStack: (...args) => controller.open(...args),
  v2CreateStack: (...args) => controller.create(...args),
  v2InvokeCommand: (...args) => controller.invoke(...args),
  v2SaveStackSource: (...args) => controller.saveSource(...args),
  v2ValidateStackSource: (...args) => controller.validate(...args),
  v2StackHistory: (...args) => controller.history(...args),
  listWorkflows: () => controller.snapshot().library.stacks.filter(row => row.launchable),
};
try {
  server = await createServer({ root, configFile: false, plugins: [react(), { name: 'block-authoring-audit', configureServer(host) {
    host.middlewares.use(async (req, res, next) => {
      if (req.url === '/__blocks-audit') {
        const html = await server.transformIndexHtml(req.url, `<!doctype html><html><head><title>Block authoring audit</title></head><body><div id="root" style="height:100vh"></div><script type="module">
          import React from 'react'; import {createRoot} from 'react-dom/client';
          import DailyRoot from '/src/v2/DailyRoot.jsx'; import {installDevMock} from '/src/devMock.js'; import '/src/styles.css';
          installDevMock(); const listeners = new Set();
          const previewSettings = window.flyt.getSettings;
          window.flyt.getSettings = async () => ({...await previewSettings(),
            activeModels:[{id:'z-ai/glm-5.3-flash',source:'openrouter',enabled:true}],
            workflowModelTiers:Object.fromEntries(['free','economy','standard','frontier'].map(tier=>[tier,[{provider:'openrouter',model:'z-ai/glm-5.3-flash'}]]))});
          for (const method of ${JSON.stringify(Object.keys(methods))}) window.flyt[method] = async (...args) => {
            const response = await fetch('/__blocks-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,args})});
            const result = await response.json(); if(!response.ok) throw new Error(result.error);
            window.__auditSnapshot = result.snapshot;
            for(const event of result.events) for(const listener of listeners) listener(event);
            return result.value;
          };
          window.flyt.onV2Command = listener => {listeners.add(listener);return ()=>listeners.delete(listener)};
          window.flyt.listProjects = async () => ({tabs:[{id:'audit-project',name:'Audit fixture',folder:${JSON.stringify(temp)},state:{}}],active:'audit-project'});
          window.flyt.projectRecents = async () => []; window.flyt.listRuns = async () => [];
          window.flyt.saveProjectState = async () => {};
          window.flyt.startWorkflow = async () => {throw new Error('UI authoring test cannot execute workflows')};
          createRoot(document.getElementById('root')).render(React.createElement(DailyRoot));
        </script></body></html>`);
        res.setHeader('Content-Type', 'text/html'); res.end(html); return;
      }
      if(req.url !== '/__blocks-api') return next();
      try {
        let body = ''; for await(const chunk of req) body += chunk;
        const {method,args} = JSON.parse(body); assert(methods[method]);
        const value = await methods[method](...args);
        res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({value,events:events.splice(0),snapshot:controller.snapshot()}));
      } catch(error) {res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
    });
  }}], server: { host:'127.0.0.1',port:0 } });
  await server.listen();
  browser = await chromium.launch({headless:true,...(process.env.FLYT_BROWSER_EXECUTABLE ? {executablePath:process.env.FLYT_BROWSER_EXECUTABLE}:{})});
  page = await browser.newPage({viewport:{width:1500,height:1000}});
  page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__blocks-audit`);
  await page.getByRole('button',{name:'Build',exact:true}).click();
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByPlaceholder('Search blocks').waitFor();
  const palette = page.getByRole('complementary',{name:'Block palette'});
  const card = id => page.locator(`[data-node-id="${id}"]`);
  const currentNode = id => [...walk(controller.snapshot().stack.root)].find(node=>node.id===id);
  const waitNode = async (id, field, value) => page.waitForFunction(({id,field,value})=>{
    const find = node => node.id===id ? node : [...(node.children??[]),...(node.else??[])].map(find).find(Boolean);
    return JSON.stringify(find(window.__auditSnapshot.stack.root)?.config?.[field])===JSON.stringify(value);
  },{id,field,value});
  const save = async () => {await page.getByRole('button',{name:'Save configuration',exact:true}).click();};
  for(const definition of booted.ctx.blocks.list()) {
    const id = definition.use.split(':').at(-1);
    await page.getByPlaceholder('Search blocks').fill(definition.use);
    await palette.locator('button.be-palette-item').filter({has:page.getByText(definition.title,{exact:true})}).click();
    await card(id).click();
    const instructions = page.locator('.be-config-form label').filter({has:page.locator('span').getByText('instructions',{exact:true})}).locator('textarea');
    if(definition.settings?.properties?.instructions) {
      const label = page.locator('.be-config-form label').filter({has:page.locator('span').filter({hasText:/^instructions$/})});
      await label.locator('textarea').fill(`Audit ${id}: keep the acceptance criteria unchanged.`);
      await save(); await waitNode(id,'instructions',`Audit ${id}: keep the acceptance criteria unchanged.`);
    } else if(id==='human-checkpoint') {
      assert(await page.getByRole('checkbox').isChecked(),'checkpoint must display its enabled default');
      await page.getByRole('checkbox').uncheck(); await save(); await waitNode(id,'enabled',false);
      await page.getByRole('checkbox').check(); await save(); await waitNode(id,'enabled',true);
    } else { await save(); }
    assert.deepEqual(currentNode(id).outputs, definition.outputs??[]);
    report.blocks.push({id,inserted:true,configured:true,outputs:currentNode(id).outputs});
    console.log(`UI block ${id}: inserted, configured, outputs preserved`);
  }
  await page.getByPlaceholder('Search blocks').fill('');
  // Restore optional settings through their controls; an empty number or
  // Default enum must remove the override rather than save null/empty string.
  await card('general-analysis').click();
  await page.locator('.be-config-form input[type="checkbox"]').check();
  await save(); await waitNode('general-analysis','inputOnly',true);
  report.checks.push('Use input only persists from the block configuration form');
  const number = page.locator('.be-config-form label').filter({has:page.locator('span').filter({hasText:/^maxTokens$/})}).locator('input');
  await number.fill('2048'); await save(); await waitNode('general-analysis','maxTokens',2048);
  await number.fill(''); await save(); await waitNode('general-analysis','maxTokens',undefined);
  const effort = page.locator('.be-config-form label').filter({has:page.locator('span').filter({hasText:/^effort$/})}).locator('select');
  await effort.selectOption('high'); await save(); await waitNode('general-analysis','effort','high');
  await effort.selectOption(''); await save(); await waitNode('general-analysis','effort',undefined);
  report.checks.push('optional numeric and enum settings reset to defaults');
  // Each control wraps a fresh independent block, using Split as its upstream
  // list. This exercises the palette's real binding choices and validation.
  for(const [kind,label] of [['sequence','Sequence'],['parallel','Parallel'],['repeat','Repeat'],['foreach','For each'],['until','Until'],['if','If']]) {
    await card('split').click();
    await page.getByPlaceholder('Search blocks').fill('flyt-blocks-core:general-analysis');
    await palette.locator('button.be-palette-item').filter({has:page.getByText('General analysis',{exact:true})}).click();
    const id = [...walk(controller.snapshot().stack.root)].find(node=>node.id.startsWith('general-analysis-')&&!report.controls.some(c=>c.child===node.id))?.id;
    assert(id); await card(id).click();
    await palette.locator('button.be-palette-item').filter({has:page.getByText(label,{exact:true})}).click();
    await card(kind).locator(':scope > header').click();
    if(kind==='until'||kind==='if') {
      const field=kind==='until'?'condition':'predicate';
      const textarea=page.getByLabel(kind==='until'?'Condition (JSON)':'Predicate (JSON)',{exact:true});
      const before=currentNode(kind)[field];
      await textarea.fill('{'); await textarea.pressSequentially('"source":');
      assert.equal(await textarea.inputValue(),'{"source":');
      await save(); await page.getByRole('alert').filter({hasText:'must contain valid JSON'}).waitFor();
      assert.deepEqual(currentNode(kind)[field],before);
      const edited={...before,operator:'is',literal:'READY'};
      await textarea.fill(JSON.stringify(edited,null,2)); await save();
      await page.waitForFunction(({kind,field})=>{
        const find=n=>n.id===kind?n:[...(n.children??[]),...(n.else??[])].map(find).find(Boolean);
        return find(window.__auditSnapshot.stack.root)?.[field]?.literal==='READY';
      },{kind,field});
      report.checks.push(`${kind} JSON survives partial typing; invalid save rejected; valid save persists`);
    } else {await save();}
    assert.equal(controller.snapshot().validation.ok,true);
    report.controls.push({kind,child:id,valid:true}); console.log(`UI control ${kind}: configured and validated`);
  }
  await page.screenshot({path:path.join(output,'editor-controls.png'),animations:'disabled'});
  // Newly created workflow must be available to Work without restarting.
  await page.getByRole('button',{name:'Workflows',exact:true}).click();
  await page.getByRole('button',{name:'New workflow',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('textbox').first().fill('Fresh audit workflow');
  await dialog.getByRole('button',{name:'Create workflow',exact:true}).click();
  await page.getByRole('button',{name:'Run',exact:true}).click();
  await page.getByRole('button').filter({hasText:/Fresh audit workflow/}).first().waitFor();
  assert.equal(await page.getByText('Select workflow',{exact:true}).count(),0);
  report.checks.push('new workflow appears selected in Work immediately after Build > Run');
  await page.screenshot({path:path.join(output,'fresh-workflow-selected.png'),animations:'disabled'});
  assert.deepEqual(report.errors,[]); report.passed=true;
} catch(error) {
  report.failure=error.stack;
  if(page){report.uiText=await page.locator('body').innerText();await page.screenshot({path:path.join(output,'ui-authoring-failure.png')});}
  throw error;
}
finally {
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'ui-authoring.json'),JSON.stringify(report,null,2));
  await browser?.close();await server?.close();detach();controller.dispose();await booted.dispose();
}
