// Controlled scheduler benchmark. The LLM seam has fixed delays, so these are
// scheduling measurements, not claims about provider latency or model quality.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { createKernel, flytTools, sessionJsonl, provideSeam, executeTaskGraph } from '#kernel';

const root = path.resolve(import.meta.dirname, '..');
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', `${process.argv[2] ?? 'HEAD'}^{commit}`], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const baselineSource = execFileSync('git', ['show', `${baselineCommit}:kernel/src/plugins/blocks-task-graph.ts`], { cwd: root, encoding: 'utf8', windowsHide: true });
const baselineFile = path.join(root, `kernel/dist/plugins/.dispatch-before-${process.pid}.js`);
fs.writeFileSync(baselineFile, (await transform(baselineSource, { loader: 'ts', format: 'esm', target: 'es2022' })).code);
const makeTask = (id, dependsOn = []) => ({ id, title: id.toUpperCase(), goal: `Return ${id}.`, dependsOn, produces: [], requires: [], optional: [], writeFiles: [] });
const plan = JSON.stringify({ summary: 'Controlled uneven workloads', tasks: [makeTask('slow'), makeTask('fast'), makeTask('dependent', ['fast']), makeTask('queued')] });
const delays = { slow: 500, fast: 50, dependent: 180, queued: 180 };
async function measure(execute, label, sample) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-dispatch-perf-'));
  const kernel = createKernel();
  const timeline = [];
  let active = 0, peak = 0;
  const began = performance.now();
  try {
    await kernel.ctx.plugin(flytTools);
    await kernel.ctx.plugin(sessionJsonl, { root: dir });
    await kernel.ctx.plugin({ name: 'controlled-delay', apply(ctx) { return provideSeam(ctx, 'llm', {
      stream(request) {
        const prompt = request.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
        const id = /# Task: (SLOW|FAST|DEPENDENT|QUEUED)\b/.exec(prompt)?.[1]?.toLowerCase();
        if (id) { active++; peak = Math.max(peak, active); timeline.push({ task: id, event: 'start', ms: performance.now() - began }); }
        return { async *[Symbol.asyncIterator]() {}, async settled() {
          if (id) { await new Promise(resolve => setTimeout(resolve, delays[id])); active--; timeline.push({ task: id, event: 'end', ms: performance.now() - began }); }
          return { content: id ? `${id} done` : plan, finishReason: 'stop' };
        } };
      }, async models() { return []; },
    }); } });
    const result = await execute({ ctx: kernel.ctx, runId: 'sample', blockId: 'dispatch', input: 'Read only.', ceiling: [], config: { model: 'fixed-delay-fixture', maxParallel: 2, parallelism: 'high' } });
    if (result.status !== 'done' || peak !== 2) throw new Error(`Invalid benchmark: ${result.error ?? peak}`);
    return { label, sample, durationMs: performance.now() - began, peak, timeline, output: result.output };
  } finally { await kernel.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}
try {
  const before = (await import(pathToFileURL(baselineFile).href)).executeTaskGraph;
  const samples = [];
  for (let i = 0; i < 4; i++) {
    // Alternate order to reduce consistent warm-up bias.
    for (const label of i % 2 ? ['after', 'before'] : ['before', 'after']) samples.push(await measure(label === 'before' ? before : executeTaskGraph, label, i));
  }
  const mean = label => samples.filter(s => s.label === label).reduce((n, s) => n + s.durationMs, 0) / 4;
  const report = { kind: 'controlled scheduler benchmark; no real model calls', baselineCommit, delaysMs: delays, maxParallel: 2,
    beforeMeanMs: mean('before'), afterMeanMs: mean('after'), reductionPercent: (mean('before') - mean('after')) / mean('before') * 100, samples };
  fs.mkdirSync(path.join(root, 'docs/reviews/plan-dispatch-performance'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/reviews/plan-dispatch-performance/scheduler.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
} finally { fs.unlinkSync(baselineFile); }
