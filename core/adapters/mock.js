// Mock adapter: lets the whole pipeline run end-to-end with no API key.
// It keys off the "ROLE:" marker each node puts in its system prompt and
// returns plausible, correctly-shaped output for that node type.
export async function mockAdapter({ system, prompt, onText }) {
  await sleep(600 + Math.random() * 900); // simulate latency so the canvas animates
  let role = (system.match(/ROLE:\s*([\w-]+)/) ?? [])[1] ?? 'generic';
  // Also recognize explicit role in the prompt/context for flow aiSteps that put role in user message
  if (!role || role === 'generic') {
    const fromPrompt = (prompt || '').match(/role[=:]\s*["']?([\w-]+)/i);
    if (fromPrompt) role = fromPrompt[1].toLowerCase();
  }
  const goal = (prompt.match(/USER PROMPT:\n([\s\S]{0,120})/) ?? [])[1]?.trim() ?? 'the request';

  // When the agent loop's text protocol is active (core/agent.js injects a
  // TOOL PROTOCOL section), an executor emits one example tool call first so
  // the whole registry + text path can be exercised with no API key.
  let reply = null;
  if (role === 'executor' && system.includes('TOOL PROTOCOL')) {
    reply = !prompt.includes('TOOL RESULT')
      ? {
        text: [
          'I will save my working notes to the workspace first.',
          '```tool',
          JSON.stringify({ tool: 'write_file', args: { path: 'notes.md', content: `# Notes\n\nMock working notes for: ${goal}\n` } }),
          '```'
        ].join('\n'),
        usage: { input_tokens: 100, output_tokens: 60 }
      }
      : {
        text: `## Result\n\n(mock output) Completed the assigned task for: ${goal}\n\n- Wrote working notes to workspace/notes.md via the write_file tool\n- Respected the listed constraints`,
        usage: { input_tokens: 160, output_tokens: 200 }
      };
  }

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
    }, null, 2),

    // === Roles for the documented standard example nodes (FLOW_NODES.md) ===
    'plan-start': `# Tasks

## task-1: Design the public API for config loading
Goal: Define a clean TypeScript interface and default contract.
Category: Code design
Context files:
- src/types.ts (only the AppConfig interface and related exported types; ignore everything else)
- docs/architecture.md (Configuration section only)
Constraints: Follow existing project style.
Depends on: none
Suggested template: code-design-step

## task-2: Implement the loader
Goal: Implement the loader behavior and write the module.
Category: Code general
Context files:
- src/types.ts (the interfaces produced by the design task)
Depends on: task-1
Suggested template: code-general-step

## task-3: Add a short README section + basic test
Goal: Document usage and add a minimal test.
Category: documentation
Context files:
- (the implemented module + types)
Depends on: task-2
Suggested template: documentation-step`,

    'plan-eval': JSON.stringify({
      parallelGroups: [["task-1"], ["task-2"], ["task-3"]],
      order: ["task-1", "task-2", "task-3"],
      categories: { "task-1": "Code design", "task-2": "Code general", "task-3": "documentation" },
      nodes: [
        {
          id: "gen-design", template: "code-design-step", taskRef: "task-1", category: "Code design",
          title: "Design the API (task-1)",
          goal: "Define the config loader interface exactly as described by task-1 in tasks.md.",
          contextSpec: { files: [{ path: "tasks-md", description: "The full task list; task-1 is this node's assignment." }] }
        },
        {
          id: "gen-impl", template: "code-general-step", taskRef: "task-2", category: "Code general",
          title: "Implement the loader (task-2)",
          goal: "Implement the loader behavior per the design from task-1.",
          dependsOn: ["gen-design"],
          contextSpec: { files: [{ path: "gen-design", description: "The API design produced by the design step." }] }
        },
        {
          id: "gen-docs", template: "documentation-step", taskRef: "task-3", category: "documentation",
          title: "Docs + test notes (task-3)",
          goal: "Document usage of the implemented loader and outline a minimal test.",
          dependsOn: ["gen-impl"],
          contextSpec: { files: [{ path: "gen-impl", description: "The implemented module output." }] }
        }
      ],
      summary: "Small sequential plan. All tasks have explicit minimal context specs."
    }, null, 2),

    'step-eval': `Step evaluation complete. No plan-impacting changes. Output consistent with goal and declared (minimal) context.

\`\`\`json
{ "verdict": "pass", "reason": "Output consistent with goal and declared minimal context." }
\`\`\``,

    'stitch': `## Stitch Report

All pieces reviewed. Design, implementation and docs are consistent.

Small inline fix applied in workspace (README example now matches final API).
No larger gaps — no corrective task nodes created.

\`\`\`json
{ "fixTasks": [] }
\`\`\``,

    // Follow-up turns (FOLLOWUP-PLAN): classify the reply as a small fix so
    // the whole extend-and-walk loop is exercisable with no API key.
    'followup-triage': JSON.stringify({
      class: 'fix',
      reason: 'The reply asks for a small correction to the produced output (mock triage).',
      contextNodes: [],
      nodes: [
        {
          id: 'apply-feedback', template: 'code-general-step', category: 'Code general',
          title: 'Apply the requested fix',
          goal: `Apply the correction the user asked for in their follow-up: ${goal}`
        }
      ]
    }, null, 2),

    'feedback-review': `## Feedback review

The follow-up work addresses the user's feedback (mock review).

\`\`\`json
{ "verdict": "solved", "reason": "The turn's output addresses the feedback (mock review)." }
\`\`\``,

    'final-eval': `## Final Evaluation

**Completeness:** Good.

**Differences from original plan (with reasoning):**
- Added one small internal helper (not in original plan) — natural extraction that improved clarity and testability.
- Docs are slightly shorter because the final API surface was smaller than anticipated.

The explicit per-file context descriptions worked: only the listed files were required.`
  }[role] ?? `(mock output for role "${role}")`;

  reply ??= { text, usage: { input_tokens: 100, output_tokens: 200 } };

  // Simulate streaming: surface the text in growing prefixes so the
  // incremental-output path (onText contract in adapters/index.js) can be
  // exercised with no API key. Every role streams, the executor's tool-calling
  // turns included — those are what an agentTask's live output actually shows
  // (V1 task 8), so a mock that skipped them would hide the feature on exactly
  // the path it matters most.
  if (onText) {
    const step = Math.max(20, Math.ceil(reply.text.length / 8));
    for (let end = step; end < reply.text.length; end += step) {
      onText(reply.text.slice(0, end));
      await sleep(80);
    }
    onText(reply.text, { final: true });
  }

  return reply;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
