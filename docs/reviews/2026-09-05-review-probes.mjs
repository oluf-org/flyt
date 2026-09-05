// Review probes: print observed behavior, not assertions of corrected behavior.
// No network calls. Small session logs remain in the OS temp directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKernel, flytBlocks, flytStackRunner, sessionJsonl, parseStack, flytTools, provideSeam, manageContextBudget, unknownCapability } from '../../kernel/dist/index.js';
import { executeAiStep } from '../../kernel/dist/plugins/blocks-aistep.js';
async function boot(source, execute) {
 const kernel=createKernel();
 await kernel.ctx.plugin(flytBlocks);
 await kernel.ctx.plugin(flytTools);
 await kernel.ctx.plugin(sessionJsonl,{root:fs.mkdtempSync(path.join(os.tmpdir(),'flyt-review-evidence-'))});
 await kernel.ctx.plugin({name:'review-blocks',inject:['blocks'],apply(ctx){ctx.blocks.register({use:'demo:work',title:'Demo',description:'',category:'work',settings:{type:'object'},ceiling:[],execute});}});
 const stack=parseStack(source);
 await kernel.ctx.plugin(flytStackRunner,{stacks:{resolve:()=>stack.root}});
 return kernel;
}
const repeat='version: 2\nid: demo\nblocks:\n  - id: reps\n    kind: repeat\n    count: 3\n    body:\n      - id: item\n        use: demo:work\n';
let n=0;
const k=await boot(repeat,async()=>({status:'done',output:String(++n)}));
const outcome=await(await k.ctx.agents.start({id:'demo',runId:'repeat'},'start')).settled();
console.log(JSON.stringify({probe:'repeat-three',status:outcome.status,expectedExecutions:3,actualExecutions:n}));
await k.dispose();
const parallel='version: 2\nid: demo\nblocks:\n  - id: fan\n    kind: parallel\n    maxParallel: 1\n    lanes:\n      - id: left\n        kind: sequence\n        blocks:\n          - id: a\n            use: demo:work\n      - id: right\n        kind: sequence\n        blocks:\n          - id: b\n            use: demo:work\n';
const seen=[];
const p=await boot(parallel,run=>executeAiStep(run,'Only the current lane '+run.blockId,{name:'text'}));
await p.ctx.plugin({name:'review-llm',apply(ctx){return provideSeam(ctx,'llm',{stream(req){seen.push(req.messages);const answer=seen.length===1?'LEFT_PRIVATE_FINDING':'RIGHT_RESULT';return {async *[Symbol.asyncIterator](){yield {text:answer};},async settled(){return {content:answer,finishReason:'stop',route:{requested:'fake',effective:'fake',degraded:false,reason:''}};}};},async models(){return [];}});}});
const pout=await(await p.ctx.agents.start({id:'demo',runId:'parallel'},'common input')).settled();
console.log(JSON.stringify({probe:'parallel-model-history',status:pout.status,rightSawLeftResult:seen[1]?.some(m=>m.content.includes('LEFT_PRIVATE_FINDING')),rightSystemPrompts:seen[1]?.filter(m=>m.role==='system').map(m=>m.content)}));
await p.dispose();
const profile=unknownCapability('review','mock');
profile.limits.contextTokens.value=4000;
profile.providerOverheadTokens.value=0;
const messages=[{role:'system',content:'Do the task'},{role:'user',content:'Inspect and answer.'}];
for(let i=0;i<6;i++){
 messages.push({role:'assistant',content:'',toolCalls:[{id:'c'+i+'a',name:'read_file',args:{path:'a'+i}},{id:'c'+i+'b',name:'read_file',args:{path:'b'+i}}]});
 messages.push({role:'tool',name:'read_file',toolCallId:'c'+i+'a',content:'a'.repeat(3000),handle:'ha'+i});
 messages.push({role:'tool',name:'read_file',toolCallId:'c'+i+'b',content:'b'.repeat(3000),handle:'hb'+i});
}
const budget=manageContextBudget({messages,requestedOutput:200,profile});
const ids=new Set(budget.messages.flatMap(m=>(m.toolCalls??[]).map(c=>c.id)));
console.log(JSON.stringify({probe:'compaction-tool-pairs',actions:budget.actions.map(a=>a.action),roles:budget.messages.map(m=>m.role),orphanToolResults:budget.messages.filter(m=>m.role==='tool'&&!ids.has(m.toolCallId)).map(m=>m.toolCallId)}));

const foreach='version: 2\nid: demo\nblocks:\n  - id: plan\n    use: demo:work\n    outputs:\n      - name: items\n        type: list\n  - id: each\n    kind: foreach\n    roster: plan.items\n    max: 3\n    body:\n      - id: item\n        use: demo:work\n';
const executed=[];
let fh;
const fk=await boot(foreach,async run=>{
 if(run.blockId==='plan')return {status:'done',output:'roster',structured:{items:['alpha','beta','gamma']}};
 executed.push(run.input);
 await fh.stop('review interruption');
 return {status:'done',output:run.input+' complete'};
});
fh=await fk.ctx.agents.start({id:'demo',runId:'foreach'},'start');
await fh.settled();
const root=(await fk.ctx.sessions.read('foreach')).file;
const before=[...executed];
const resumed=await fk.ctx.agents.resume('foreach');
const resumedOutcome=await resumed.settled();
console.log(JSON.stringify({probe:'foreach-resume',beforeResume:before,afterResume:executed,status:resumedOutcome.status,expectedItems:['alpha','beta','gamma']}));
await fk.dispose();
const { InterceptionRegistry }=await import('../../kernel/dist/index.js');
const hk=await boot('version: 2\nid: demo\nblocks:\n  - id: single\n    use: demo:work\n',run=>executeAiStep(run,'Normal system',{name:'text'}));
let dispatched;
await hk.ctx.plugin({name:'review-hooks',apply(ctx){const reg=new InterceptionRegistry(ctx,()=>true);reg.register({plugin:'trusted-review',point:'model.request.prepared',order:1,mutates:true,run:value=>({...value,messages:[...value.messages,{role:'user',content:'HOOK_ONLY_INSTRUCTION'}]})});}});
await hk.ctx.plugin({name:'review-hook-llm',apply(ctx){return provideSeam(ctx,'llm',{stream(req){dispatched=req.messages;return {async *[Symbol.asyncIterator](){yield {text:'ok'};},async settled(){return {content:'ok',finishReason:'stop',route:{requested:'fake',effective:'fake',degraded:false,reason:''}};}};},async models(){return [];}});}});
const ho=await(await hk.ctx.agents.start({id:'demo',runId:'hooks'},'input')).settled();
const hs=await hk.ctx.sessions.read('hooks');
const he=[];for await(const e of hs.read())he.push(e);
const locator=he.find(e=>e.type==='step.prompt').data.content;
const replay=await hs.deriveMessages(locator.throughSeq);
console.log(JSON.stringify({probe:'effective-prompt-replay',status:ho.status,dispatchedHasHook:dispatched.some(m=>m.content==='HOOK_ONLY_INSTRUCTION'),replayHasHook:replay.some(m=>m.content==='HOOK_ONLY_INSTRUCTION'),eventsContainHookContent:JSON.stringify(he).includes('HOOK_ONLY_INSTRUCTION')}));
await hk.dispose();

