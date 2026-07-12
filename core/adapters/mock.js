// Mock adapter: lets the whole pipeline run end-to-end with no API key.
// It keys off the "ROLE:" marker each node puts in its system prompt and
// returns plausible, correctly-shaped output for that node type.
export async function mockAdapter({ system, prompt }) {
  await sleep(600 + Math.random() * 900); // simulate latency so the canvas animates
  const role = (system.match(/ROLE:\s*(\w+)/) ?? [])[1] ?? 'generic';
  const goal = (prompt.match(/USER PROMPT:\n([\s\S]{0,120})/) ?? [])[1]?.trim() ?? 'the request';

  const text = {
    planner: [
      `# Plan`,
      ``,
      `Goal: ${goal}`,
      ``,
      `## Steps`,
      `1. Research and outline the approach for: ${goal}`,
      `2. Produce the main deliverable draft`,
      `3. Review the draft and produce the final version`
    ].join('\n'),

    router: JSON.stringify({
      tasks: [
        { id: 'task-1', title: 'Research and outline', goal: `Outline the approach for: ${goal}`, inputs: ['plan.md', 'prompt.md'], constraints: ['Be concise'], dependsOn: [], worker: { provider: 'mock', model: 'mock-small' } },
        { id: 'task-2', title: 'Draft deliverable', goal: 'Produce the main deliverable using the outline', inputs: ['plan.md', 'task-1 output'], constraints: ['Follow the outline'], dependsOn: ['task-1'], worker: { provider: 'mock', model: 'mock-large' } },
        { id: 'task-3', title: 'Final review pass', goal: 'Review and finalize the draft', inputs: ['task-2 output'], constraints: ['Fix errors only, no rewrites'], dependsOn: ['task-2'], worker: { provider: 'mock', model: 'mock-small' } }
      ]
    }, null, 2),

    executor: `## Result\n\n(mock output) Completed the assigned task for: ${goal}\n\n- Did the work described in the task goal\n- Respected the listed constraints`,

    verifier: JSON.stringify({
      verdict: 'pass',
      checks: [
        { name: 'All tasks produced output', result: 'pass' },
        { name: 'Outputs consistent with plan', result: 'pass' }
      ],
      summary: 'All task outputs present and consistent with the plan (mock verification).'
    }, null, 2)
  }[role] ?? `(mock output for role "${role}")`;

  return { text, usage: { input_tokens: 100, output_tokens: 200 } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
