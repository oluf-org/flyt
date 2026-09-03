import test from 'node:test';
import assert from 'node:assert/strict';
import { debugOutputHistory, debugReportMarkdown } from '../src/v2/debugView.js';

test('debug output history preserves outputs across retries', () => {
  const history = debugOutputHistory({ others: [
    { type: 'block.output', at: '2026-01-01', data: { blockId: 'write', content: 'before' } },
    { type: 'block.status', data: { blockId: 'write', status: 'pending' } },
    { type: 'block.output', at: '2026-01-02', data: { blockId: 'write', content: 'after' } },
  ] });
  assert.deepEqual(history.write.map(row => row.content), ['before', 'after']);
});

test('bug report export includes diagnosis and complete evidence context', () => {
  const markdown = debugReportMarkdown({
    summary: 'One block failed.', probableCause: 'The tool errored.', confidence: 'high', suspectedBlockId: 'verify',
    evidence: ['exit 1'], suggestedAreas: ['test setup'], suggestedPrompt: 'Fix the setup.', recommendedAction: 'Retry.',
    facts: { run: { workflow: 'Ship', stage: 'failed' }, tools: [{ name: 'bash', error: 'exit 1' }] },
  }, 'run-1');
  assert.match(markdown, /Run: run-1/);
  assert.match(markdown, /Probable cause[\s\S]*The tool errored/);
  assert.match(markdown, /"error": "exit 1"/);
});
