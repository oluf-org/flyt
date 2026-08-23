import io

def edit(path, pairs):
    s = io.open(path, encoding='utf-8', newline='').read().replace('\r\n', '\n')
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: anchor not found: {old[:60]!r}'
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8', newline='\r\n').write(s)
    print('ok', path)

# --- blocks-core.ts ---
edit('kernel/src/plugins/blocks-core.ts', [(
    "import { AI_STEP_SETTINGS, executeAiStep } from './blocks-aistep.js';",
    "import { AI_STEP_OUTPUT, AI_STEP_SETTINGS, executeAiStep } from './blocks-aistep.js';",
),(
    """/**
 * Define a one-shot core block: same executor, its own role brief.
 */
const aiStep = (use: string, title: string, description: string, brief: string): BlockDefinition => ({
  use, title, description, category: 'work',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: [], // reads its input only; a stack grants tools by naming a ceiling
  execute: run => executeAiStep(run, brief),
});""",
    """/**
 * Define a one-shot core block: same executor, its own role brief, and the
 * structured output it declares. The executor fills exactly the field named
 * here, so the declaration and the return agree by construction.
 */
const aiStep = (
  use: string, title: string, description: string, brief: string,
  output: { name: string; type?: 'string' | 'list' } = { name: AI_STEP_OUTPUT },
): BlockDefinition => ({
  use, title, description, category: 'work',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: [], // reads its input only; a stack grants tools by naming a ceiling
  outputs: [{ name: output.name, type: output.type ?? 'string' }],
  execute: run => executeAiStep(run, brief, output),
});"""
),(
    """  'Analyse the input. Give a summary, its structure, the claims and the evidence for them, the gaps, the risks, and a recommendation. Ground every claim in what you were given.');""",
    """  'Analyse the input. Give a summary, its structure, the claims and the evidence for them, the gaps, the risks, and a recommendation. Ground every claim in what you were given.',
  { name: 'analysis' });"""
),(
    """  'Merge the upstream outputs into one coherent deliverable, keeping the best of each. Small fixes inline; a larger gap becomes a named fix task, not a silent patch.');""",
    """  'Merge the upstream outputs into one coherent deliverable, keeping the best of each. Small fixes inline; a larger gap becomes a named fix task, not a silent patch.',
  { name: 'combined' });"""
),(
    """  'Divide the upstream work into clearly labeled, independent parts that downstream blocks can run in parallel.');""",
    """  'Divide the upstream work into clearly labeled, independent parts that downstream blocks can run in parallel.',
  // The one core roster: a typed list is the only source a `For each` may
  // read, which is what keeps a roster from ever being prose split on
  // newlines at the lint rule's discretion (D56).
  { name: 'parts', type: 'list' });"""
),(
    """    'Call out risks, unknowns, and acceptance criteria per task.'].join('\\n'));""",
    """    'Call out risks, unknowns, and acceptance criteria per task.'].join('\\n'),
  // `plan.tasks`, the field the Phase 3 predicate examples name.
  { name: 'tasks', type: 'list' });"""
)])

# --- blocks-judgement.ts ---
edit('kernel/src/plugins/blocks-judgement.ts', [(
    """const judge = (
  use: string, title: string, description: string, brief: string,
): BlockDefinition => ({
  use, title, description, category: 'judgement',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: [],
  execute: (run: BlockRun) => executeAiStep(run, brief),
});""",
    """const judge = (
  use: string, title: string, description: string, brief: string,
  output: { name: string; type?: 'string' | 'list' },
): BlockDefinition => ({
  use, title, description, category: 'judgement',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: [],
  outputs: [{ name: output.name, type: output.type ?? 'string' }],
  execute: (run: BlockRun) => executeAiStep(run, brief, output),
});"""
),(
    "  'Evaluate the work against the plan or brief it answers to. Return a verdict — pass, retry, or escalate — and say why. A pass that rests on nothing is a retry.',\n);",
    "  'Evaluate the work against the plan or brief it answers to. Return a verdict — pass, retry, or escalate — and say why. A pass that rests on nothing is a retry.',\n  // The verdict an `If` predicate names (the plan's `gate.result` example).\n  { name: 'verdict' },\n);"
),(
    "  'Compare the alternatives in front of you: where they agree, where they differ, each one’s strengths, and a keep-the-best recommendation. Say which you would keep and why.',\n);",
    "  'Compare the alternatives in front of you: where they agree, where they differ, each one’s strengths, and a keep-the-best recommendation. Say which you would keep and why.',\n  { name: 'comparison' },\n);"
),(
    "  'Rewrite the request into a precise, self-contained brief: goal, constraints, deliverable, acceptance. Ask a clarifying question only when an ambiguity would materially change the work; otherwise take the reading a competent person would and mark it.',\n);",
    "  'Rewrite the request into a precise, self-contained brief: goal, constraints, deliverable, acceptance. Ask a clarifying question only when an ambiguity would materially change the work; otherwise take the reading a competent person would and mark it.',\n  { name: 'brief' },\n);"
)])

# --- blocks-inquiry.ts ---
edit('kernel/src/plugins/blocks-inquiry.ts', [(
    """const inquire = (
  use: string, title: string, description: string, brief: string,
): BlockDefinition => ({
  use, title, description, category: 'inquiry',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: INQUIRY_CEILING,
  execute: (run: BlockRun) => executeAiStep(run, brief),
});""",
    """const inquire = (
  use: string, title: string, description: string, brief: string,
  output: { name: string; type?: 'string' | 'list' },
): BlockDefinition => ({
  use, title, description, category: 'inquiry',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: INQUIRY_CEILING,
  outputs: [{ name: output.name, type: output.type ?? 'string' }],
  execute: (run: BlockRun) => executeAiStep(run, brief, output),
});"""
),(
    "  'Interrogate the request over a few bounded rounds — goal, non-goals, constraints, acceptance — then write the specification the answers settle. Mark every assumption you had to take as an assumption; do not present one as a decision.',\n);",
    "  'Interrogate the request over a few bounded rounds — goal, non-goals, constraints, acceptance — then write the specification the answers settle. Mark every assumption you had to take as an assumption; do not present one as a decision.',\n  { name: 'spec' },\n);"
),(
    "  'Say what THIS project is and what relationship it has to the subject about to be read: empty, the same kind of thing, overlapping problems, or no real overlap. Read enough to argue it — the manifests and guidance, plus at most two load-bearing files from each side — then stop. This is a bounded survey, not the analysis.',\n);",
    "  'Say what THIS project is and what relationship it has to the subject about to be read: empty, the same kind of thing, overlapping problems, or no real overlap. Read enough to argue it — the manifests and guidance, plus at most two load-bearing files from each side — then stop. This is a bounded survey, not the analysis.',\n  { name: 'orientation' },\n);"
)])

# --- blocks-loop.ts ---
edit('kernel/src/plugins/blocks-loop.ts', [(
    """  ceiling: PLAN_CEILING,
  execute: (run: BlockRun) => executeAiStep(run, [""",
    """  ceiling: PLAN_CEILING,
  outputs: [{ name: 'tasks', type: 'list' }],
  execute: (run: BlockRun) => executeAiStep(run, ["""
),(
    """    'Every task must be claimable by someone standing here weeks from now who has not read the analysis.',
  ].join('\\n')),
};""",
    """    'Every task must be claimable by someone standing here weeks from now who has not read the analysis.',
  ].join('\\n'), { name: 'tasks', type: 'list' }),
};"""
),(
    """  ceiling: [],
  execute: (run: BlockRun) => executeAiStep(run,
    'Hand the planned tasks to the loop queue: emit them as the queue accepts them, and say what was queued. Nothing else is this block’s to do.'),
};""",
    """  ceiling: [],
  outputs: [{ name: 'queued', type: 'list' }],
  execute: (run: BlockRun) => executeAiStep(run,
    'Hand the planned tasks to the loop queue: emit them as the queue accepts them, and say what was queued. Nothing else is this block’s to do.',
    { name: 'queued', type: 'list' }),
};"""
)])
