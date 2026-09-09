// Synthetic, settled canonical history. No provider calls or user data.
import fs from 'node:fs';
import path from 'node:path';
import { projectRun, materialise } from '#kernel';

export function seedPerformanceRuns(root, count, chunks = 200, { toolBytes = 0 } = {}) {
  const ids = [];
  let bytes = 0;
  for (let index = 0; index < count; index++) {
    const id = `perf-${String(index).padStart(5, '0')}`;
    const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
    const events = [];
    const add = (type, data) => events.push({ seq: events.length + 1, at, type, data });
    add('run.created', { runId: id, createdAt: at, prompt: `Performance fixture ${index}`, stackId: 'performance-fixture', stackName: 'Performance fixture' });
    add('stack.resolved', { stack: {
      kind: 'sequence', id: 'root', children: [{ kind: 'block', id: 'work', use: 'flyt-blocks-core:work', config: {} }],
    } });
    add('run.stage', { stage: 'execution' });
    add('block.status', { blockId: 'work', status: 'active' });
    add('turn.start', { turnId: 'turn-1', blockId: 'work' });
    add('step.start', { blockId: 'work', step: 1 });
    add('llm.request', { callId: 'call-1', blockId: 'work', model: 'mock', provider: 'mock' });
    for (let chunk = 0; chunk < chunks; chunk++) add('llm.stream', { callId: 'call-1', blockId: 'work', text: 'Synthetic streamed output. '.repeat(20) });
    add('llm.response', { callId: 'call-1', blockId: 'work', ok: true, content: 'Fixture complete.', finishReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 100 } });
    if (toolBytes) {
      add('tool.call', { callId: 'tool-1', blockId: 'work', name: 'read_file', args: { path: 'synthetic.txt' } });
      add('tool.result', { callId: 'tool-1', blockId: 'work', name: 'read_file', content: 'x'.repeat(toolBytes) });
    }
    add('step.end', { blockId: 'work', step: 1 });
    add('turn.end', { turnId: 'turn-1', blockId: 'work' });
    add('block.output', { blockId: 'work', content: 'Fixture complete.' });
    add('block.status', { blockId: 'work', status: 'done' });
    add('run.stage', { stage: 'done' });
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const text = events.map(event => JSON.stringify(event)).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'session.jsonl'), text);
    materialise(dir, projectRun(events, id));
    bytes += Buffer.byteLength(text);
    ids.push(id);
  }
  return { ids, count, chunks, sessionBytes: bytes };
}
