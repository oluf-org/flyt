// Summarize recorded acceptance evidence; does not call a model or change runs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const dir = path.resolve(import.meta.dirname, '../docs/reviews/block-audit');
const read = name => JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const files = [
  'first.json',
  'first-repair-split-plan-start-backlog-plan-loop-handoff-analysis-files-foreach-parallel-sequence-repeat-until-if-plan-handoff.json',
  'second.json',
  'second-final-general-analysis-analysis-files-foreach.json',
  'second-quality-split-prompt-refiner-backlog-plan-compare-parallel-sequence-plan-handoff.json',
  'second-controls-foreach-parallel-sequence-repeat-until-if.json',
  'second-edge-split-foreach-parallel-failure-until-exhausted.json',
  'second-input-only-foreach.json',
];
const reports=files.map(read), latest=new Map();
for(const [index,report] of reports.entries()) {
  assert(report.completedAt,`${files[index]} is not complete`);
  assert.equal(report.model,'z-ai/glm-5.3-flash');
  for(const result of report.results) latest.set(result.id,{...result,file:files[index]});
}
const first=reports[0], second=reports[2];
assert.equal(first.inventory.length,15);
for(const definition of first.inventory) {
  const id=definition.use.split(':').at(-1);
  assert(first.results.some(result=>result.id===id),`No first trial for ${id}`);
  assert(second.results.some(result=>result.id===id),`No second trial for ${id}`);
  assert.equal(latest.get(id)?.quality,'pass',`${id} still fails`);
}
for(const result of latest.values()) assert.equal(result.quality,'pass',`${result.id} still fails`);
const ui=read('ui-authoring.json'); assert(ui.passed);assert.equal(ui.blocks.length,15);assert.equal(ui.controls.length,6);
const tests=fs.readFileSync(path.join(dir,'final-tests.log'),'utf8');
assert.match(tests,/# fail 0\b/);assert.match(tests,/# duration_ms/);
const count=key=>Number(tests.match(new RegExp(`# ${key} (\\d+)`))?.[1]);
const allRuns=new Map();
for(const name of fs.readdirSync(dir).filter(name=>name.endsWith('.json'))) {
  const data=read(name);
  if(data.model!=='z-ai/glm-5.3-flash') continue;
  for(const result of data.results??[]) if(result.runId) allRuns.set(result.runId,result);
}
const calls=[...allRuns.values()].flatMap(result=>result.calls??[]);
const cost=calls.reduce((sum,call)=>sum+Number(call.usage?.cost??call.usage?.costUsd??0),0);
const repairTests=[];
for(const report of [first,second]) {
  const work=report.results.find(result=>result.id==='work');
  const name=report===first?'schedule.test.js':'inventory.test.js';
  const test=spawnSync(process.execPath,['--test',path.join(work.workspace,name)],{encoding:'utf8',windowsHide:true});
  assert.equal(test.status,0,test.stdout+test.stderr);
  repairTests.push({pass:report.pass,path:path.join(work.workspace,name),exitCode:test.status,output:test.stdout});
}
fs.writeFileSync(path.join(dir,'generated-tests-rechecked.json'),JSON.stringify(repairTests,null,2));
const seconds=result=>Math.round(result.durationMs/1000)+'s';
const trialDescriptions={
  'work':['Create and run departure boundary tests','Create and run empty/zero inventory tests'],
  'research':['Open Node test-runner documentation','Open JSON RFC 8259'],
  'general-analysis':['Compute 75% success and limits','Compute total 20; explain zero counts'],
  'combine':['Merge latency and invalidation notes','Merge offline/zero/Unicode requirements'],
  'split':['Split keyboard and JSON-documentation tasks','Split zero-count and Unicode tasks'],
  'plan-start':['Plan boundary tests and null-result documentation','Plan quantity validation and Unicode documentation'],
  'task-graph':['Dispatch two actual read-only scheduling workers','Dispatch two actual read-only inventory workers'],
  'evaluation':['Pass correct arithmetic','Retry incomplete ALPHA/BETA candidate'],
  'compare':['Select B under an 8 MB hard limit','Select A preserving zeros and labels'],
  'prompt-refiner':['Refine schedule tests without code changes','Refine inventory tests without scope expansion'],
  'human-checkpoint':['Approve and continue','Reject and stop'],
  'interrogate':['Ask for export format; incorporate JSON answer','Ask for export format; incorporate CSV answer'],
  'orient':['Distinguish local schedule from airline platform','Distinguish offline calculator from marketplace'],
  'backlog-plan':['Ground two scheduling backlog tasks','Ground inventory tasks with new write paths'],
  'loop-handoff':['Queue a real scheduling task','Queue a real inventory task'],
};
const matrix=first.inventory.map(definition=>{
  const id=definition.use.split(':').at(-1), a=first.results.find(r=>r.id===id), b=latest.get(id), desc=trialDescriptions[id];
  const title=reports.at(-1).inventory.find(row=>row.use===definition.use)?.title??definition.title;
  return `| ${title} | ${desc[0]} — ${a.quality==='pass'?'passed':'found fault'} | ${desc[1]} — passed | ${seconds(b)} / ${b.calls.length} |`;
}).join('\n');
const controls=['analysis-files','foreach','parallel-sequence','repeat','until','if','plan-handoff','parallel-failure','until-exhausted'].map(id=>{
  const result=latest.get(id);return `| ${id} | ${result.status} / expected | ${seconds(result)} / ${result.calls.length} | [record](${result.file}) |`;
}).join('\n');
const text=`# Block acceptance audit — 6 September 2026

All 15 registered block types were exercised through the production kernel with **z-ai/glm-5.3-flash**, in two passes using different tasks. The original pass found four failing block contracts (Split, Plan, Backlog plan, Backlog handoff). Repairs were followed by another full pass, output review, combination tests, failure-path tests, and targeted live reruns. Every latest acceptance case passes. Expected human rejection and exhausted Until cases terminate as failures and are counted as successful checks of that behavior.

The production Build UI also passed insertion, configuration, and output-declaration checks for all 15 blocks, plus authoring all six controls. A real isolated Electron session created a workflow, ran Repeat with inputs 0 and 10, and showed results 2 and 12; the final container and child both displayed Done. [Desktop evidence](desktop-repeat-done.jpg). Newly created workflows appear selected in Work immediately after Build → Run. [Editor evidence](ui-authoring.json), [selection screenshot](fresh-workflow-selected.png).

## Coverage

Final trial time includes tools and model latency; calls are recorded completed model responses. Deterministic checkpoint/handoff blocks require no model calls.

| Block | First task | Second task / final repair check | Final time / calls |
|---|---|---|---|
${matrix}

The first fixture was a local departure scheduler; the second an offline fruit inventory calculator with zero quantities and Unicode labels. Work created real node:test files and executed them. Both generated suites were independently rerun successfully after the audit. [Verification](generated-tests-rechecked.json).

| Combination / edge case | Final outcome | Time / calls | Evidence |
|---|---|---|---|
${controls}

Sequence, Parallel, Repeat, For each, Until, If, virtual Input, generated worker children, both If branches, human approval/rejection, actual queue persistence, loop bounds, and downstream failure propagation were exercised. For each was tested with complete task strings and objects, including non-ASCII text. The final input-only variant prevents task-description summaries from starting repository exploration.

## Faults found and corrected

1. **Fragmented task lists:** Split/Plan/Backlog plan split output into individual lines, producing 26, 49, and 16 fragments instead of two tasks. The shared parser now decodes JSON arrays and groups legacy Markdown task details. Invalid JSON fails visibly; a single Markdown task also stays intact.
2. **Truncated plans:** a real Plan response consumed its 4,096-token budget partly on reasoning and ended mid-JSON. AI steps now have a configurable 16,384-token default and bounded continuation on provider length stops.
3. **Missing evidence access:** General analysis and Plan lacked repository readers. Their ceilings now permit read-only evidence tools, with no writers or shell.
4. **Unrunnable handoff:** Backlog handoff unconditionally failed. It now validates explicit task objects and queues through a dedicated permission-checked tool, with durable receipts, replay-safe identities, and honest partial-failure receipts. It never starts the supervisor. Denied approval and narrowed ceilings were tested; ordinary worker queue restrictions remain enforced.
5. **Lost For each objects:** task objects became “[object Object]”. Object items now serialize as JSON; workers received both complete acceptance criteria in live runs.
6. **Hidden parallel failure:** a successful last lane could let a containing sequence/loop continue after another lane failed. All containing controls now stop on any failed child. A real rejected checkpoint alongside a successful model lane verified that downstream work did not run.
7. **Incorrect control status:** Repeat stayed Pending and For each could stay active after completion. Authored controls now record their active/terminal lifecycle, including empty paths and failures. Recovery keeps legacy tool ownership separate from control status events.
8. **Stale workflow picker:** Build → Run on a newly created workflow left “Select workflow” in Work. The catalog refreshes after authoring/plugin changes and before launch selection.
9. **Missing editor outputs:** palette/command insertion dropped registered outputs, preventing normal loop binding. Canonical insert commands now preserve them.
10. **Uneditable JSON settings:** condition fields discarded intermediate invalid text while typing. They now keep draft text and validate on Save. Blank optional numbers/enums remove the override; structured settings are edited as JSON. The checkpoint checkbox now shows its actual enabled default.
11. **Misleading checkpoint prompt/trace:** the question assumed every artifact was a refined planning request, and tool events lacked block identity. The question now applies to any artifact, and trace attribution is explicit.
12. **Unusable backlog write scope:** plans omitted required new test files from blastRadius because they did not already exist. The planner now distinguishes writable deliverables (including new files) from read-only context. The final inventory plan explicitly permits inventory.test.js.
13. **Wrong comparison target and expanded briefs:** Compare sometimes ranked reviewers rather than the actual options; Split invented implementation details; Prompt refiner authorized unrelated metadata changes. Their defaults now preserve scope, identify assumptions, and compare the requested alternatives. Explicit system-prompt overrides remain respected.
14. **Unbounded verbosity and unnecessary exploration:** numeric word ceilings in step instructions now receive the shared correction/enforcement behavior. “Use input only” explicitly removes tools for transformations. An unrestricted For each rerun hit the four-minute audit watchdog; the corrected input-only run completed with intact task content and no tools. Provider reasoning time still varies.

## Verification and limits

- npm test: **${count('pass')} passed, 0 failed, ${count('skipped')} skipped**, ${count('tests')} total. [Log](final-tests.log).
- npm run build: passed. [Log](build-latest.log).
- npm run lint: all six shipped stacks passed. [Log](lint.log).
- Real authoring UI: 15 blocks, six controls, defaults, partial/invalid/valid JSON edits, and fresh-workflow selection passed; no browser page errors. [Record](ui-authoring.json).
- ${allRuns.size} recorded kernel audit runs, ${calls.length} completed model responses, approximately **$${cost.toFixed(4)}** provider-reported cost across those records. Small additional desktop calls are recorded in the isolated app profile. No model other than GLM Flash was used for these live checks.

The four skipped tests require a Windows restricted-token sandbox unavailable for this sign-in; the existing baseline skipped the same four. Real command tests used explicitly unconfined disposable workspaces, as permitted for this unattended audit. These are focused acceptance fixtures, not a throughput benchmark or a guarantee for arbitrary prompts/models. No personal project files were used as test subjects, and the pre-existing working-tree changes were preserved.

Original failures remain in [first-pass evidence](first.json) and subsequent repair records. The first collector was corrected to read structured outputs and generated children from canonical block.status events, not block.output; those collector mistakes are not reported as app faults. The full second pass initially passed automated checks, then manual review exposed the write-scope/comparison/verbosity issues above; later records document their repairs.

## Reproduce

Set FLYT_VERIFY_SETTINGS to a settings file with an OpenRouter connection, then run node scripts/verify-all-blocks-live.mjs --pass=first and --pass=second. The script asserts the selected model is GLM Flash or an explicitly selected free model and creates isolated temporary workspaces. Individual repair cases use --only=id,id. This sends real provider requests.

For the authoring UI, run node scripts/verify-blocks-ui.mjs with FLYT_PLAYWRIGHT_ROOT pointing to an installed Playwright package and optionally FLYT_BROWSER_EXECUTABLE. It uses the real authoring controller and React UI with fixture app services; it does not execute model work. The live audit above verifies execution separately.
`;
fs.writeFileSync(path.join(dir,'REPORT.md'),text);
fs.writeFileSync(path.join(dir,'coverage.json'),JSON.stringify({model:first.model,blocks:first.inventory.map(d=>d.use),latest:[...latest.values()].map(r=>({id:r.id,status:r.status,quality:r.quality,durationMs:r.durationMs,calls:r.calls.length,evidence:r.file})),recordedRuns:allRuns.size,modelResponses:calls.length,costUsd:cost,tests:{passed:count('pass'),skipped:count('skipped'),total:count('tests')}},null,2));
console.log(`Complete: 15 blocks, ${latest.size} acceptance cases, ${count('pass')} passing tests. Report: ${path.join(dir,'REPORT.md')}`);
