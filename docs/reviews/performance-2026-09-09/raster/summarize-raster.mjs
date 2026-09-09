import fs from 'node:fs';
import path from 'node:path';
const files = process.argv.slice(2);
const results = [];
for (const file of files) {
  const r = JSON.parse(fs.readFileSync(file));
  const es = JSON.parse(fs.readFileSync(fs.existsSync(r.chromiumTrace) ? r.chromiumTrace : path.join(path.dirname(file), path.basename(r.chromiumTrace)))).traceEvents.filter(e=>e.ph==='X'&&e.dur>0);
  const offset=r.traceSummary.epochOffsetMs;
  const phases=[];
  for(const name of ['history-row-to-reply-observed','reply-typing','reply-typing-steady']) {
    const p=r.phases.find(p=>p.name===name);
    const overlap=e=>Math.max(0,Math.min((e.ts+e.dur)/1000+offset,p.at+p.durationMs)-Math.max(e.ts/1000+offset,p.at));
    const shaders=es.filter(e=>e.name==='shader_compile'&&overlap(e)>0).map(e=>{
      const enclosing=es.filter(a=>a.pid===e.pid&&a.tid===e.tid&&a.ts<=e.ts&&a.ts+a.dur>=e.ts+e.dur&&/Op$/.test(a.name)).sort((a,b)=>a.dur-b.dur)[0];
      return {atMs:e.ts/1000+offset-p.at,ms:e.dur/1000,phaseOverlapMs:overlap(e),operation:enclosing?.name,nested:es.filter(a=>a.pid===e.pid&&a.tid===e.tid&&a.ts>=e.ts&&a.ts+a.dur<=e.ts+e.dur&&/driver_link_program|cache_miss|Program::MainLinkLoadEvent::wait/.test(a.name)).map(a=>({name:a.name,ms:a.dur/1000}))};
    }).sort((a,b)=>b.ms-a.ms);
    const opTimes = [...new Set(es.filter(e=>overlap(e)&&/Op$/.test(e.name)).map(e=>e.name))].map(operation=>{
      const durations=es.filter(e=>e.name===operation&&overlap(e)).map(overlap);
      return {operation,count:durations.length,totalMs:durations.reduce((a,b)=>a+b,0),maxMs:Math.max(...durations)};
    }).sort((a,b)=>b.maxMs-a.maxMs);
    const driverCompiles=es.filter(e=>e.name==='D3DCompile'&&overlap(e)).map(e=>({atMs:e.ts/1000+offset-p.at,ms:e.dur/1000,pid:e.pid,tid:e.tid}));
    phases.push({name,shaders,opTimes,driverCompiles});
  }
  results.push({file,error:r.error,focus:r.focusRecoveries,phases});
}
fs.writeFileSync(path.join(path.dirname(files[0]), 'raster-summary.json'),JSON.stringify(results,null,2));
for(const r of results) console.log(JSON.stringify({file:r.file,error:r.error,focus:r.focus,phases:r.phases.map(p=>({name:p.name,shaders:p.shaders.slice(0,6),ops:p.opTimes.slice(0,5),driverCompiles:p.driverCompiles}))},null,2));
