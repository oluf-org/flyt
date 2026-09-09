import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const directory = path.dirname(fileURLToPath(import.meta.url));
const rows = [];
for (const size of ['100', 'large']) for (const variant of ['baseline', 'opaque-reply']) for (let n = 1; n <= 3; n++) {
  const file = `reply-confirm-${size}-${variant}-${n}.json`;
  const r = JSON.parse(fs.readFileSync(path.join(directory, file)));
  assert(!r.error && !r.profileError, file);
  assert.equal(r.focusRecoveries.length, 0, file);
  assert(Object.values(r.draftChecks).every(Boolean), file);
  rows.push({ file, size, variant, first: Object.fromEntries(['durationMs','inputDelayMs','processingMs','presentationDelayMs'].map(k=>[k,r.interactions['reply-typing'][k]])), steady: r.interactions['reply-typing-steady'].durationMs, styles:r.replyStyles });
}
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const groups = ['100','large'].map(size=>({size, ...Object.fromEntries(['baseline','opaque-reply'].map(variant=>{
  const group=rows.filter(r=>r.size===size&&r.variant===variant);
  return [variant,{firstP95:group.map(r=>r.first.durationMs.p95),medianFirstP95:median(group.map(r=>r.first.durationMs.p95)),max:group.map(r=>r.first.durationMs.max),steadyP95:group.map(r=>r.steady.p95)}];
}))}));
const result = {method:'Three unprofiled fresh-profile repetitions per variant and fixture; alternating order, focus-contaminated runs excluded and replaced. Baseline is original blurred CSS; opaque-reply overrides only the reply bar. Event Timing >=16ms, grouped by interaction, quantized 8ms; sampled tails, not all-keystroke percentiles or INP.',groups,rows};
fs.writeFileSync(path.join(directory, 'reply-comparison.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(groups,null,2));
