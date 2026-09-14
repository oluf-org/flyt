// Read-only evidence extraction; never launches or changes a workflow.
import fs from 'node:fs';
import path from 'node:path';
import {workflowMeasurements} from '../core/workflowMeasurements.js';
const root=path.resolve(process.argv[2]||'.flyt/gui-workflows/2026-09-13-fixed');
const results=[];
for(const name of fs.readdirSync(root)){
 const dir=path.join(root,name),file=path.join(dir,'result.json');if(!fs.existsSync(file))continue;
 const r=JSON.parse(fs.readFileSync(file));const runs=path.join(r.workspace,'.flyt','runs');
 const savedSession=path.join(dir,'session-at-end.jsonl');
 const saved=fs.existsSync(savedSession)?fs.readFileSync(savedSession,'utf8').trim().split('\n').map(JSON.parse):null;
 const candidates=fs.readdirSync(runs).filter(x=>x.startsWith('chat-'));
 const run=r.runId??saved?.find(e=>e.type==='run.created')?.data.runId??(candidates.length===1?candidates[0]:null);
 if(!run)throw new Error('Cannot identify the canonical run for '+dir);
 const events=saved??fs.readFileSync(path.join(runs,run,'session.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const rootBlock=events.find(e=>e.type==='block.status'&&!e.data.parentId)?.data.blockId;
 const outputs=events.filter(e=>e.type==='block.output'&&e.data.blockId===rootBlock&&e.data.port!=='workflow-state');
 const report=String(outputs.at(-1)?.data.content||'');
 const commands=events.filter(e=>e.type==='tool.result'&&['bash','run_gate'].includes(e.data.name)).map(e=>({at:e.at,block:e.data.blockId,result:e.data.result||e.data.content}));
 const stages=new Map();
 for(const event of events){
  if(event.type!=='block.status'||!event.data.parentId)continue;
  const d=event.data;const stage=stages.get(d.blockId)||{blockId:d.blockId,title:d.title};
  if(d.status==='active'&&!stage.startedAt)stage.startedAt=event.at;
  if(['done','failed','stopped','interrupted'].includes(d.status))stage.endedAt=event.at;
  stage.status=d.status;stages.set(d.blockId,stage);
 }
 results.push({id:r.id,title:r.title,workflow:r.workflow,guiStatus:r.guiStatus,startedAt:r.startedAt,launchedAt:r.launchedAt,elapsedSeconds:r.elapsedSeconds,
  automatedAcceptance:r.automatedAcceptance,independentExit:r.independent?.status,projectTestExit:r.projectTests?.status,continuationOf:r.continuationOf,inspectionOf:r.inspectionOf,freshFrom:r.freshFrom,recoveryProbe:r.recoveryProbe,
  runtimeBudget:events.find(e=>e.type==='workflow.budget')?.data,
  readOnlyPreserved:r.readOnlyPreserved,changedPaths:r.changedPaths,questions:r.questions,supervisorStop:r.supervisorStop,
  harnessError:r.harnessError,rendererErrors:r.rendererErrors,report,commands,
  stages:[...stages.values()].map(s=>({...s,elapsedSeconds:s.startedAt&&s.endedAt?Math.round((Date.parse(s.endedAt)-Date.parse(s.startedAt))/1000):null})),
  measurements:workflowMeasurements({runDir:id=>path.join(runs,id)},run,fs.existsSync(savedSession)?{rootSessionFile:savedSession}:{}),evidence:dir});
}
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(results,null,2));
console.log(results.map(r=>`${r.id}: GUI=${r.guiStatus}; external=${r.independentExit??'semantic review'}; ${r.elapsedSeconds}s; ${r.measurements.modelCalls} calls`).join('\n'));
