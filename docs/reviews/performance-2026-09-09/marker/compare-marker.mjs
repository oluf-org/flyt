import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = process.argv[2] || '.flyt/performance';
const rows = [];
const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length / 2)];
for (const size of ['100', 'large']) for (const variant of ['history-inset-shadow', 'baseline']) for (let n=1;n<=3;n++) {
  const file = `marker-${size}-${variant}-${n}.json`;
  const r = JSON.parse(fs.readFileSync(path.join(directory,file)));
  assert(!r.error && !r.profileError, file);
  assert.equal(r.focusRecoveries.length,0,file);
  assert(Object.values(r.draftChecks).every(Boolean),file);
  assert.equal(r.historyPolls.length,2,file);
  assert(r.typingOverlap.every(p=>p.inputsDuringRead>0),file);
  if(variant==='baseline') {
    assert.equal(r.historyIndicator.boxShadow,'none',file);
    assert.equal(r.historyIndicator.marker.width,'2px',file);
    assert.equal(r.historyIndicator.marker.pointerEvents,'none',file);
    assert.notEqual(r.historyIndicator.marker.content,'none',file);
  } else assert(r.historyIndicator.boxShadow.includes('inset'),file);
  rows.push({file,size,variant,first:Object.fromEntries(['durationMs','inputDelayMs','processingMs','presentationDelayMs'].map(k=>[k,r.interactions['reply-typing'][k]])),steady:r.interactions['reply-typing-steady'].durationMs,indicator:r.historyIndicator});
}
const groups=['100','large'].map(size=>({size,...Object.fromEntries(['history-inset-shadow','baseline'].map(variant=>{
  const group=rows.filter(r=>r.size===size&&r.variant===variant);
  const p95=group.map(r=>r.first.durationMs.p95),max=group.map(r=>r.first.durationMs.max);
  return [variant,{p95,max,medianP95:median(p95),medianMax:median(max),steadyP95:group.map(r=>r.steady.p95)}];
}))}));
const result={method:'Three unprofiled fresh-profile trials per fixture/variant, alternating order. Same production build; before restores the inset shadow and suppresses the marker, after uses actual production CSS. Event Timing grouped by interaction, >=16ms threshold and 8ms quantization; not all-keystroke percentiles or INP. Profiles and synthetic data are on the workspace drive for both variants.',groups,rows};
fs.writeFileSync(path.join(directory,'marker-comparison.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(groups,null,2));
