// Headed Electron acceptance. Requests, selection, launch, answers and stopping
// use visible GUI controls; never invokes workflow/run commands or renderer IPC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {GUI_SCENARIOS as NODE_SCENARIOS} from '../benchmark/default-workflows/gui-scenarios.mjs';
import {GUI_PYTHON_SCENARIOS} from '../benchmark/default-workflows/gui-python-scenarios.mjs';
const root=path.resolve(import.meta.dirname,'..');
const flags=new Map(process.argv.slice(2).filter(x=>x.startsWith('--')).map(x=>{const [k,...v]=x.slice(2).split('=');return [k,v.join('=')||true]}));
const GUI_SCENARIOS=flags.get('suite')==='python'?GUI_PYTHON_SCENARIOS:NODE_SCENARIOS;
if(!flags.has('live')) { console.log('Headed live-provider GUI suite: --live --case=all|id --output=absolute-directory\n'+GUI_SCENARIOS.map(x=>`${x.id}\t${x.workflow}`).join('\n'));process.exit(0); }
const require=createRequire(import.meta.url);
const {_electron}=require(process.env.FLYT_PLAYWRIGHT_ROOT || 'playwright');
const output=path.resolve(String(flags.get('output')||path.join(root,'.flyt','gui-workflows',new Date().toISOString().replace(/[:.]/g,'-'))));
fs.mkdirSync(output,{recursive:true});
const selected=GUI_SCENARIOS.filter(x=>flags.get('case')==='all'||String(flags.get('case')).split(',').includes(x.id));
if(!selected.length)throw new Error('Select --case=all or a listed scenario');
if((flags.has('continue')||flags.has('inspect')||flags.has('fresh-from'))&&selected.length!==1)throw new Error('A retained-workspace operation requires exactly one selected scenario');
const names={'make-change':'Make a change','fix-bug':'Fix a bug','review-change':'Review a change','research-question':'Research a question','plan-idea':'Plan an idea','deliver-complex-task':'Deliver a complex task'};
const appData=process.platform==='win32' ? process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming')
 : process.platform==='darwin' ? path.join(os.homedir(),'Library','Application Support')
 : process.env.XDG_CONFIG_HOME || path.join(os.homedir(),'.config');
const sourceSettings=JSON.parse(fs.readFileSync(path.resolve(String(flags.get('settings')||path.join(appData,'Flyt','settings.json'))),'utf8'));
// Electron's package resolves the native executable on each supported platform.
const electronPath=require('electron');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function capture(page,file,issues,options={}){
 for(let attempt=0;attempt<2;attempt++){
  try{await page.screenshot({path:file,...options});return true;}
  catch(error){issues.push({at:new Date().toISOString(),file,error:error.message});if(attempt===0){await page.bringToFront().catch(()=>{});await sleep(500);}}
 }
 return false;
}
function writeFiles(dir,files){for(const [name,text]of Object.entries(files)){const f=path.join(dir,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text)}}
function fingerprints(dir){const out={};for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(['.git','.flyt','node_modules'].includes(entry.name))continue; const f=path.join(dir,entry.name);if(entry.isDirectory()){for(const [k,v]of Object.entries(fingerprints(f)))out[entry.name+'/'+k]=v}else out[entry.name]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}return out}
function command(cmd,args,cwd){const r=spawnSync(cmd,args,{cwd,encoding:'utf8',windowsHide:true,timeout:60000});return {status:r.status,error:r.error?.message,stdout:r.stdout,stderr:r.stderr}}
function sessionFile(workspace,runId){const dir=path.join(workspace,'.flyt','runs');if(!fs.existsSync(dir))return null;const run=runId??fs.readdirSync(dir).filter(x=>x.startsWith('chat-')).sort((a,b)=>fs.statSync(path.join(dir,b)).birthtimeMs-fs.statSync(path.join(dir,a)).birthtimeMs)[0];return run?path.join(dir,run,'session.jsonl'):null;}
const results=fs.existsSync(path.join(output,'index.json'))?JSON.parse(fs.readFileSync(path.join(output,'index.json'))):[];
for(const scenario of selected){
 const dir=path.join(output,scenario.id); if(fs.existsSync(path.join(dir,'result.json'))){if(flags.has('resume'))continue;throw new Error('Refusing to overwrite evidence '+dir);}
 const previousDir=flags.has('continue')||flags.has('inspect')||flags.has('fresh-from')?path.resolve(String(flags.get('continue')||flags.get('inspect')||flags.get('fresh-from'))):null;
 const previous=previousDir?JSON.parse(fs.readFileSync(path.join(previousDir,'result.json'))):null;
 if(previous&&(previous.id!==scenario.id||previous.prompt!==scenario.prompt))throw new Error('Continuation must preserve the exact original scenario and request');
 const workspace=previous?.workspace??path.join(dir,'workspace');fs.mkdirSync(dir,{recursive:true});
 if(previous&&!previous.runId){
  const saved=path.join(previousDir,'session-at-end.jsonl');
  if(fs.existsSync(saved))previous.runId=JSON.parse(fs.readFileSync(saved,'utf8').split('\n')[0]).data.runId;
  else{const runs=path.join(workspace,'.flyt','runs'),ids=fs.readdirSync(runs).filter(id=>id.startsWith('chat-'));if(ids.length===1)previous.runId=ids[0];}
  if(!previous.runId)throw new Error('Retained attempt has no unambiguous canonical run identity');
 }
 if(!previous){fs.mkdirSync(workspace,{recursive:true});writeFiles(workspace,scenario.files);}
 else{const session=sessionFile(workspace,previous.runId),snapshot=path.join(previousDir,'session-at-end.jsonl');if(session&&!fs.existsSync(snapshot))fs.copyFileSync(session,snapshot);}
 const runsRoot=path.join(workspace,'.flyt','runs'),existingRuns=new Set(fs.existsSync(runsRoot)?fs.readdirSync(runsRoot):[]);
 const git=args=>execFileSync('git',args,{cwd:workspace,stdio:'pipe',windowsHide:true});
 if(!previous){git(['init']);git(['add','.']);git(['-c','user.name=GUI Acceptance','-c','user.email=gui-acceptance@example.invalid','commit','-m','Scenario starting state']);
 if(scenario.after)writeFiles(workspace,scenario.after);}
 const before=fingerprints(workspace);
 const profileRoot=fs.mkdtempSync(path.join(os.tmpdir(),'flyt-gui-profile-'));const profile=path.join(profileRoot,'profile');fs.mkdirSync(profile);
 const settings={...sourceSettings,mock:false,projects:{open:[workspace],active:workspace,recents:[workspace],tabState:{}}};
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify(settings));
 // Keep credentials in a local temporary app profile, outside fixture/evidence.
 const env={...process.env,FLYT_VERIFY_USER_DATA:profile,FLYT_VERIFY_DATA_ROOT:path.join(profileRoot,'data')};
 delete env.ELECTRON_RUN_AS_NODE;delete env.FLYT_TEST_MOCK_PROVIDER;delete env.VITE_DEV_SERVER;
 delete env.FLYT_SANDBOX_MODE;
 const result={id:scenario.id,workflow:scenario.workflow,title:scenario.title,prompt:scenario.prompt,workspace,startedAt:new Date().toISOString(),modelTiers:settings.workflowModelTiers,transport:'headed Electron / Playwright GUI controls',observations:[],questions:[],approvals:[],rendererErrors:[],screenshotErrors:[]};
 if(previous){result[flags.has('inspect')?'inspectionOf':flags.has('fresh-from')?'freshFrom':'continuationOf']=previousDir;result.originalLaunchedAt=previous.originalLaunchedAt??previous.launchedAt;}
 fs.writeFileSync(path.join(dir,'scenario.json'),JSON.stringify({id:scenario.id,title:scenario.title,workflow:scenario.workflow,prompt:scenario.prompt,expect:scenario.expect},null,2));
 let app,page;
 try{
  app=await _electron.launch({executablePath:electronPath,args:[root],cwd:root,env,timeout:45000});
  page=await app.firstWindow();page.on('pageerror',e=>result.rendererErrors.push(e.message));
  await page.getByLabel('Describe what you want',{exact:true}).waitFor({timeout:45000});
  await page.screenshot({path:path.join(dir,'00-ready.png')});
  if(previous&&!flags.has('fresh-from')){
   await page.locator(`.work-history-group .work-history-item[data-run-id="${previous.runId}"]`).click();
   await page.locator('.work-run-head').waitFor({timeout:30000});
   await capture(page,path.join(dir,'01-before-retry.png'),result.screenshotErrors);
   if(!flags.has('inspect')){
    const session=sessionFile(workspace,previous.runId),beforeSeq=JSON.parse(fs.readFileSync(session,'utf8').trim().split('\n').at(-1)).seq;
    const retry=page.locator('.work-retry');
    if(await retry.count())await retry.click();
    else{await page.locator('.work-run-actions summary').click();await page.getByRole('button',{name:'Resume run',exact:true}).click();}
    let started=false;const until=Date.now()+30000;
    while(Date.now()<until){
     const status=await page.locator('.work-run-actions summary').innerText();
     if(/Running|Queued|Planning|Resuming/.test(status)){started=true;break;}
     const events=fs.readFileSync(session,'utf8').split('\n').flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}});
     if(events.some(e=>e.seq>beforeSeq&&e.type==='run.stage'&&e.data.stage==='resumed')&&events.some(e=>e.seq>beforeSeq&&e.type==='run.stage'&&['done','failed','stopped'].includes(e.data.stage))){started=true;break;}
     await sleep(250);
    }
    if(!started)throw new Error('Visible retry did not start or settle within 30 seconds');
   }
   result.launchedAt=new Date().toISOString();
  }else{
  await page.getByRole('button',{name:/^Workflow:/}).click();
  await page.getByRole('option').filter({has:page.locator('.lander-picker-name',{hasText:names[scenario.workflow]})}).first().click();
  await page.getByLabel('Describe what you want',{exact:true}).fill(scenario.prompt);
  await page.screenshot({path:path.join(dir,'01-request.png')});
  await page.getByRole('button',{name:/^Run/}).click();result.launchedAt=new Date().toISOString();
  }
  console.log(JSON.stringify({event:'gui-launch',id:scenario.id,workflow:scenario.workflow,dir}));
  await page.locator('.work-run-head').waitFor({timeout:30000});
  if(!previous||flags.has('fresh-from')){
   result.runId=fs.readdirSync(runsRoot).find(id=>id.startsWith('chat-')&&!existingRuns.has(id));
   if(!result.runId)throw new Error('No new canonical run appeared after the visible launch');
  }else result.runId=previous.runId??path.basename(path.dirname(sessionFile(workspace)));
  if(flags.has('pause-on-start')){
   result.recoveryProbe={accepted:[],requestedAt:new Date().toISOString()};
   fs.writeFileSync(path.join(dir,'pause-request.json'),JSON.stringify({reason:'Verify a visible pause and rejection of subsequent external source drift.'}));
  }
  let index=0,last='',answerCount=0;
  const deadline=Date.now()+(scenario.workflow==='deliver-complex-task'?30:scenario.workflow==='plan-idea'?20:15)*60000;
  while(Date.now()<deadline){
   const text=await page.locator('body').innerText();
   const status=await page.locator('.work-run-actions summary').innerText();
   const observation={at:new Date().toISOString(),status,text};result.observations.push(observation);
   fs.writeFileSync(path.join(dir,'live.txt'),text);
   fs.writeFileSync(path.join(dir,'progress.json'),JSON.stringify({id:scenario.id,status,elapsedSeconds:Math.round((Date.now()-Date.parse(result.launchedAt))/1000),observation:index},null,2));
   await capture(page,path.join(dir,'live.png'),result.screenshotErrors);
   if(text!==last){fs.writeFileSync(path.join(dir,`observation-${String(index).padStart(3,'0')}.txt`),text);console.log(JSON.stringify({event:'gui-observation',id:scenario.id,status,elapsedSeconds:Math.round((Date.now()-Date.parse(result.launchedAt))/1000),tail:text.slice(-1100)}));last=text;}
   if(await page.locator('.work-interaction.question').count()){
    const question=await page.locator('.work-interaction.question').innerText();
    await page.screenshot({path:path.join(dir,`question-${answerCount+1}.png`)});
    const answer=answerCount++===0&&scenario.answer?scenario.answer:'Use the explicit requirements and project documents in the original request. Do not assume additional scope or unavailable access. Record any unresolved blocking requirement explicitly.';
    result.questions.push({question,answer});await page.getByLabel('Answer this block directly',{exact:true}).fill(answer);await page.getByRole('button',{name:'Send answer to block',exact:true}).click();
   }
   if(await page.locator('.work-interaction.approval').count()){
    const approval=await page.locator('.work-interaction.approval').innerText();fs.writeFileSync(path.join(dir,'pending-approval.txt'),approval);
    await page.screenshot({path:path.join(dir,'approval.png')});
    const decisionPath=path.join(dir,'approval-decision.json');
    if(fs.existsSync(decisionPath)){const decision=JSON.parse(fs.readFileSync(decisionPath));fs.renameSync(decisionPath,path.join(dir,`approval-decision-${index}.json`));result.approvals.push({approval,decision});await page.getByRole('button',{name:decision.allow?'Approve':'Refuse',exact:true}).click();}
   }
   if(/^(Done|Failed|Rejected|Stopped|Interrupted)/.test(status)){result.guiStatus=status;break;}
   if(flags.has('pause-after-first-milestone')&&!result.recoveryProbe){
    const runs=path.join(workspace,'.flyt','runs');
    for(const run of fs.existsSync(runs)?fs.readdirSync(runs):[]){
     if(run!==result.runId)continue;
     const session=path.join(runs,run,'session.jsonl');if(!fs.existsSync(session))continue;
     const events=fs.readFileSync(session,'utf8').split('\n').flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}});
     const accepted=events.filter(e=>e.type==='workflow.acceptance');
     if(!accepted.length)continue;
     result.recoveryProbe={accepted:accepted.map(e=>e.data),requestedAt:new Date().toISOString()};
     fs.writeFileSync(path.join(dir,'pause-request.json'),JSON.stringify({reason:'Verify GUI pause/resume after an accepted milestone; do not change project files.'}));
     break;
    }
   }
   if(result.recoveryProbe&&!result.recoveryProbe.resumedAt&&/^Paused/.test(status)){
    result.recoveryProbe.pausedAt=new Date().toISOString();
    result.recoveryProbe.pausedFiles=fingerprints(workspace);
    await capture(page,path.join(dir,'recovery-paused.png'),result.screenshotErrors);
    await sleep(5000);
    result.recoveryProbe.unchangedWhilePaused=JSON.stringify(fingerprints(workspace))===JSON.stringify(result.recoveryProbe.pausedFiles);
    if(!result.recoveryProbe.unchangedWhilePaused)throw new Error('Workspace changed during the controlled pause; retain evidence for inspection');
    if(flags.has('drift-while-paused')){
     const external=path.join(workspace,'external-drift-fixture.txt');
     fs.writeFileSync(external,'External fixture change made while the GUI is paused. Resume must reject this source version.\n',{flag:'wx'});
     result.recoveryProbe.injectedDrift={path:external,at:new Date().toISOString()};
    }
    fs.writeFileSync(path.join(dir,'resume-request.json'),JSON.stringify({reason:'Resume the unchanged checkpoint through the visible run controls.'}));
    result.recoveryProbe.resumedAt=new Date().toISOString();
   }
   for(const [action,label] of [['pause','Pause run'],['resume','Resume run'],['stop','Stop run']]){
    const requestFile=path.join(dir,`${action}-request.json`);
    if(!fs.existsSync(requestFile))continue;
    const request=JSON.parse(fs.readFileSync(requestFile));
    fs.renameSync(requestFile,path.join(dir,`${action}-request-${index}.json`));
    result.interventions??=[];result.interventions.push({action,request,at:new Date().toISOString(),status});
    if(action==='stop')result.supervisorStop=request;
    await page.locator('.work-run-actions summary').click();
    await page.getByRole('button',{name:label,exact:true}).click();
    await capture(page,path.join(dir,`${action}-${index}.png`),result.screenshotErrors);
   }
   index++;await sleep(15000);
  }
  if(!result.guiStatus){result.timedOut=true;await page.locator('.work-run-actions summary').click();const stop=page.getByRole('button',{name:'Stop run',exact:true});if(await stop.count())await stop.click();await sleep(2000);result.guiStatus=await page.locator('.work-run-actions summary').innerText();}
  // Expand result bodies through visible controls to retain the actual answer.
  for(const summary of await page.locator('.be-inline-output:not([open]) > summary').all())if(await summary.isVisible())await summary.click().catch(()=>{});
  result.finalText=await page.locator('body').innerText();fs.writeFileSync(path.join(dir,'final.txt'),result.finalText);
  await page.locator('.work-run-main').evaluate(el=>{el.scrollTop=0;});
  if(await page.locator('.be-canvas').count())await page.locator('.be-canvas').evaluate(el=>{el.scrollTop=0;});
  await capture(page,path.join(dir,'final-top.png'),result.screenshotErrors);
  if(await page.locator('.be-inline-output').count())await page.locator('.be-inline-output').last().scrollIntoViewIfNeeded();
  await capture(page,path.join(dir,'final.png'),result.screenshotErrors);
 }catch(error){result.harnessError=error.stack;if(page){fs.writeFileSync(path.join(dir,'error-ui.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(dir,'error.png')}).catch(()=>{})}}
 finally{await app?.close().catch(()=>{});}
 const completedSession=sessionFile(workspace,result.runId);if(completedSession)fs.copyFileSync(completedSession,path.join(dir,'session-at-end.jsonl'));
 const after=fingerprints(workspace);result.changedPaths=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>before[k]!==after[k]);
 result.readOnlyPreserved=!result.changedPaths.length;
 if(scenario.check){
  const python=scenario.checkLanguage==='python';
  fs.writeFileSync(path.join(dir,python?'holdout.py':'holdout.mjs'),scenario.check);
  result.independent=python?command(scenario.python,['-c',scenario.check],workspace):command(process.execPath,['--input-type=module','--eval',scenario.check],workspace);
  result.projectTests=python?command(scenario.python,['-m','unittest','discover','-s','tests','-v'],workspace):command(process.execPath,['--test','test/*.test.js'],workspace);
 }
 if(scenario.expect){const answer=result.finalText||'';result.conceptSmoke=scenario.expect.concepts.map(options=>({options,found:options.some(s=>answer.toLowerCase().includes(s.toLowerCase()))}));result.requiresSemanticReview=true;}
 result.completedAt=new Date().toISOString();result.elapsedSeconds=Math.round((Date.now()-Date.parse(result.launchedAt||result.startedAt))/1000);
 result.automatedAcceptance=scenario.check?result.guiStatus?.startsWith('Done')&&result.independent.status===0&&result.projectTests.status===0:null;
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));results.push(result);fs.writeFileSync(path.join(output,'index.json'),JSON.stringify(results.map(({observations,finalText,...r})=>r),null,2));
 // Remove only credential-bearing settings in the known temporary profile.
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({...settings,providers:{}}));
 console.log(JSON.stringify({event:'gui-result',id:scenario.id,status:result.guiStatus,accepted:result.automatedAcceptance,harnessError:result.harnessError,seconds:result.elapsedSeconds}));
 if(result.harnessError)break;
}
