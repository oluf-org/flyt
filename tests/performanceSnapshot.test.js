import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as kernel from '#kernel';
import { StoredStackSnapshotReader, snapshotStackRun } from '../core/runProjection.js';
import { ReadWorkerClient } from '../core/readWorkerClient.js';
import { measure } from '../scripts/performance-metrics.mjs';

function setup(t, options = {}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'flyt-incremental-'));
 t.after(()=> {assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const id='run', file=path.join(root,id,'session.jsonl');fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,'');
 const reader=new StoredStackSnapshotReader(options);let seq=0;
 const add=(type,data)=>{const event={seq:++seq,at:`t${seq}`,type,data};fs.appendFileSync(file,JSON.stringify(event)+'\n');return event;};
 const full=()=>snapshotStackRun({sessions:new kernel.JsonlSessionStore(root),__flytRunsRoot:root},id,kernel,{materialise:false});
 const check=async()=>{const actual=await reader.snapshot(root,id,kernel,{materialise:false});assert.deepEqual(actual,await full());return actual;};
 return {root,id,file,reader,add,full,check};
}

test('incremental Work equals canonical replay at every lifecycle/call/generated-task boundary',async t=>{
 const {add,check,reader,root,id}=setup(t,{maxBytes:0});
 const events=[
 ['run.created',{prompt:'test',model:'a'}],['stack.resolved',{stack:{kind:'sequence',children:[{kind:'block',id:'parent'}]}}],
 ['run.stage',{stage:'execution'}],['block.status',{blockId:'parent',status:'active'}],
 ['llm.request',{callId:'one',blockId:'parent',model:'test',messages:[{content:'x'.repeat(100000)}]}],
 ['llm.request',{callId:'two',blockId:'parent'}],['llm.response',{callId:'two',usage:{tokens:5},content:'body'}],
 ['tool.result',{name:'read_file',result:'z'.repeat(100000),content:'preview',args:{large:'y'.repeat(100000)}}],
 ['block.status',{parentId:'parent',taskId:'t',blockId:'child',title:'First',status:'active'}],
 ['block.status',{parentId:'parent',taskId:'t',blockId:'child',title:'Later',status:'done'}],
 ['message.user',{content:'hello'}],['supervisor.summary',{content:'summary',degraded:true,reason:'fallback'}],
 ['block.output',{blockId:'parent',port:'notes',content:'first'}],['block.output',{blockId:'parent',port:'notes',content:'second'}],
 ['sandbox.failure',{error:'failed'}],['run.stage',{stage:'failed'}],['run.stage',{stage:'execution'}],
 ['llm.response',{callId:'one',usage:{tokens:7,cost:0.1},route:{reason:'fallback'}}],
 ['run.reconfigured',{model:'b',routing:{fast:'b'}}],['run.named',{name:'New'}],['run.error',{error:'oops'}],
 ['llm.stream',{text:'ignored but advances cursor'}],['run.stage',{stage:'done'}],
 ];
 for(const [type,data] of events){add(type,data);await check();}
 const held=await check();held.meta.stage='tampered';held.retrospectives.parent.toolCalls[0].tool='tampered';await check();
 reader.drop(root,id);await check();
});

test('verified suffix parses no historical stream or tool body and large logs retain snapshots',async t=>{
 const {add,check,reader,root,id,file}=setup(t,{maxBytes:1024});
 add('run.created',{});add('tool.result',{name:'read_file',content:'x'.repeat(2*1024*1024)});
 for(let i=0;i<100;i++)add('llm.stream',{text:'token '.repeat(100)});
 await check();
 const warm=await measure('warm',()=>reader.snapshot(root,id,kernel,{materialise:false}));assert.equal(warm.sample.syncReadBytes,0);
 let parses=0;const parse=JSON.parse;JSON.parse=(...args)=>{parses++;return parse(...args);};
 try {add('block.output',{blockId:'work',content:'new'});await reader.snapshot(root,id,kernel,{materialise:false});} finally {JSON.parse=parse;}
 assert.equal(parses,1,'only the new event is parsed');await check();
 assert.equal(reader.events(root,id).at(-1).data.content,'new');
 add('block.output',{blockId:'work',content:'after standalone Trace'});
 assert.equal(reader.events(root,id).at(-1).data.content,'after standalone Trace');
 parses=0;JSON.parse=(...args)=>{parses++;return parse(...args);};
 try {await reader.snapshot(root,id,kernel,{materialise:false});} finally {JSON.parse=parse;}
 assert.equal(parses,1,'a standalone oversized Trace preserves verified snapshot continuity');await check();
 assert.equal(fs.statSync(file).size>1024,true);
});

test('partial UTF-8 tails, gaps, malformed records and repairs resynchronize without duplicate events',async t=>{
 const {add,check,file,reader,root,id}=setup(t,{maxBytes:0});add('run.created',{});await check();
 const line=Buffer.from(JSON.stringify({seq:2,at:'t2',type:'block.output',data:{blockId:'work',content:'æ🙂'}})+'\n');
 const split=line.indexOf(Buffer.from('🙂'))+2;fs.appendFileSync(file,line.subarray(0,split));await check();
 fs.appendFileSync(file,line.subarray(split));await check();
 fs.appendFileSync(file,JSON.stringify({seq:8,at:'t8',type:'run.named',data:{name:'gap'}})+'\n');await check();
 fs.appendFileSync(file,'not json\n');await check();
 fs.appendFileSync(file,JSON.stringify({seq:9,at:'t9',type:'run.stage',data:{stage:'done'}})+'\n');await check();
 fs.writeFileSync(file,JSON.stringify({seq:1,at:'new',type:'run.created',data:{prompt:'repair'}})+'\n');await check();
 const actual=await reader.snapshotAndLog(root,id);assert.deepEqual(actual.log,kernel.readSessionLogFile(file).events);assert.deepEqual(actual.snapshot,await check());
});

test('growth is not append proof: prefix rewrites, restored mtime, replacement and truncation invalidate immediately',async t=>{
 const {add,check,file}=setup(t);add('run.created',{prompt:'old'});add('run.stage',{stage:'execution'});await check();
 const original=fs.readFileSync(file,'utf8'),stat=fs.statSync(file);
 fs.writeFileSync(file,original.replace('old','new')+JSON.stringify({seq:3,at:'t3',type:'run.named',data:{name:'grown'}})+'\n');
 fs.utimesSync(file,stat.atime,stat.mtime);assert.equal((await check()).prompt,'new');
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('new','now'));fs.utimesSync(file,stat.atime,stat.mtime);assert.equal((await check()).prompt,'now');
 fs.writeFileSync(file+'.replacement',original);fs.renameSync(file+'.replacement',file);assert.equal((await check()).prompt,'old');
 fs.truncateSync(file,original.indexOf('\n')+1);await check();
});

test('concurrent writes discard mutated folds, retry, and never poison the next snapshot',async t=>{
 const {add,check,file,reader,root,id}=setup(t,{maxBytes:0});add('run.created',{prompt:'old'});await check();add('run.named',{name:'append'});
 const read=fs.readSync;let writes=0;
 fs.readSync=(...args)=>{const n=read(...args);if(!writes++){fs.writeFileSync(file,JSON.stringify({seq:1,at:'replacement',type:'run.created',data:{prompt:'raced'}})+'\n');}return n;};
 try {assert.equal((await reader.snapshot(root,id,kernel,{materialise:false})).prompt,'raced');} finally {fs.readSync=read;}
 await check();
 // A continuously changing source fails with a retryable error, then recovers.
 add('run.named',{name:'more'});fs.readSync=(...args)=>{const n=read(...args);fs.appendFileSync(file,'\n');return n;};
 try {await assert.rejects(reader.snapshot(root,id,kernel,{materialise:false}),{code:'session_read_changed'});} finally {fs.readSync=read;}
 await check();
});

test('raw/projection byte eviction, file eviction and materialization preserve canonical artifacts',async t=>{
 const {add,check,file,root,id,reader}=setup(t,{maxFiles:1,maxBytes:0,maxProjectionBytes:2048});
 add('run.created',{});add('tool.result',{name:'read_file',content:'complete body'});await check();
 add('block.output',{blockId:'work',content:'large'.repeat(2000)});await check();await check();
 fs.mkdirSync(path.join(root,'other'));fs.copyFileSync(file,path.join(root,'other','session.jsonl'));
 await reader.snapshot(root,'other',kernel,{materialise:false});await check();
 await reader.snapshot(root,id);const tool=fs.readdirSync(path.join(root,id,'tools'))[0];assert.equal(JSON.parse(fs.readFileSync(path.join(root,id,'tools',tool))).result,'complete body');
});

test('combined worker read shares one canonical pass; cancellation rebuilds and preserves queued work',async t=>{
 const {add,root,id,file,full}=setup(t,{maxBytes:0});add('run.created',{});add('tool.result',{name:'large',content:'x'.repeat(34*1024*1024)});
 const worker=new ReadWorkerClient();t.after(()=>worker.close());
 const {value,sample}=await measure('combined',()=>worker.request('snapshotAndLog',{root,runId:id}));
 assert.equal(sample.workerReadBytes,fs.statSync(file).size);assert.deepEqual(value.snapshot,await full());assert.deepEqual(value.log,kernel.readSessionLogFile(file).events);
 const active=new AbortController(),queued=new AbortController();
 const first=worker.request('snapshotAndLog',{root,runId:id},{signal:active.signal});
 const second=worker.request('snapshot',{root,runId:id},{signal:queued.signal});
 const pending=worker.request('snapshot',{root,runId:id});
 const assertions=[assert.rejects(first,{name:'AbortError'}),assert.rejects(second,{name:'AbortError'})];queued.abort();setTimeout(()=>active.abort(),5);await Promise.all(assertions);
 assert.deepEqual(await pending,await full());
});


test('many tool calls preserve usage and retrospectives through append and file eviction', async t => {
  const { add, check, file, root, id, reader } = setup(t, { maxFiles: 1, maxBytes: 0 });
  add('run.created', { prompt: 'Many tool calls' });
  add('block.status', { blockId: 'work', status: 'active' });
  for (let i = 0; i < 2000; i++) {
    add('llm.request', { callId: `call-${i}`, blockId: 'work' });
    add('tool.result', { name: 'read_file', content: 'source\n'.repeat(2000), error: i % 17 ? null : 'missing' });
    add('llm.response', { callId: `call-${i}`, usage: { input: 100, output: i, cost: 0.01 } });
  }
  const first = await check();
  assert.equal(first.retrospectives.work.toolCalls.length, 2000);
  add('block.output', { blockId: 'work', content: 'After many calls' });
  await check();
  fs.mkdirSync(path.join(root, 'other'));
  fs.writeFileSync(path.join(root, 'other', 'session.jsonl'), JSON.stringify({ seq: 1, at: 't', type: 'run.created', data: {} }) + '\n');
  await reader.snapshot(root, 'other', kernel, { materialise: false });
  const result = await measure('evicted', () => reader.snapshot(root, id, kernel, { materialise: false }));
  assert.equal(result.sample.syncReadBytes, fs.statSync(file).size);
  assert.deepEqual(result.value, await check());
});
