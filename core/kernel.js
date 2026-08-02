// The kernel (PIVOT-PLAN §5.1, decision 3; contents settled per §10.6).
//
// "No default nodes" needs a floor. The user's library ships genuinely empty —
// that is the point — but the app still has to be able to WRITE a node and a
// flow, and the thing that writes them is itself a flow (§5.4). These are the
// two or three templates that flow is made of.
//
// What makes them different from library templates:
//   • `system: true` — hidden from the palette and the Nodes page
//   • app-owned — rewritten on every launch, never editable, never deletable
//   • `_`-prefixed ids — they cannot collide with anything a user creates, and
//     a flow file naming one reads as obviously not-yours
//
// What makes them the same: they run on core/flowRunner.js with the user's
// chosen model, and they are fully visible in run view. You can open the
// builder's run record and see what your builder cost, how long it took, and
// exactly what it sent — the same as any flow you wrote. The one part of the
// app that is NOT investigable would otherwise be the part that writes
// everything else.
//
// Their prompts live here rather than being generated at run time, which is
// decision 2's principle applied to the app's own nodes: nothing is sent to a
// model that the user cannot see and could not have written.

export const KERNEL_IDS = ['_flow-architect', '_node-drafter', '_prompt-drafter'];

export const KERNEL_TEMPLATES = [
  {
    id: '_flow-architect',
    name: 'Flow architect (system)',
    icon: '◈',
    baseType: 'agentTask',
    role: 'execute',
    system: true,
    description: 'Writes a .flow.yaml from a brief and lints it until it is valid. Part of the builder — not a library node.',
    // Read + write inside the project only. The architect never gets bash: it
    // writes one kind of file and lints it, and a shell is not needed for that.
    tools: ['read_file', 'glob', 'grep', 'write_file', 'edit_file'],
    toolCeiling: ['read_file', 'glob', 'grep', 'write_file', 'edit_file'],
    prompt: [
      'You write Flyt flows: `.flow.yaml` files in the DSL described by FLOW_LANG.md.',
      '',
      'Rules that are not negotiable:',
      '- Every flow starts at a node of type `input` and ends at one of type `output`.',
      '- A node is either a structural type (input, output, orchestrator) or an instance',
      '  of a Node Library template (`templateId` + `overrides`). Never invent a templateId:',
      '  use only ids from the library you were given. If the flow needs a template that does',
      '  not exist yet, say so and stop — a node the user did not agree to is not yours to add.',
      '- Every loop declares `maxIterations`. A loop without a bound is refused by lint and',
      '  is the one way this feature becomes a liability against a metered API.',
      '',
      'Method: write the file, run `flow lint` on it, read the errors, fix, repeat until it',
      'reports ok. Do not report success on a flow you have not seen lint clean.',
      '',
      'You produce a DRAFT. The user commits it. Say what you built and what you assumed.'
    ].join('\n'),
    limits: { attempts: 3 }
  },
  {
    id: '_node-drafter',
    name: 'Node drafter (system)',
    icon: '✎',
    baseType: 'aiStep',
    role: 'custom',
    system: true,
    description: 'Drafts a node template as strict JSON from a plain-language brief. Part of the builder — not a library node.',
    prompt: [
      'You draft Flyt node templates. A template is a JSON object:',
      '',
      '  { "id", "name", "description", "category", "icon", "baseType", "role",',
      '    "prompt", "instructions", "tools", "skills", "requiresApproval" }',
      '',
      '- `baseType` is "aiStep" (one model call) or "agentTask" (an agent loop with tools).',
      '- `prompt` is the node\'s own instructions to the model — a real, user-owned field.',
      '  Write it in full. It is not a placeholder and it is not generated later.',
      '- `tools` may name only tools that exist in the library you were given.',
      '- `id` is lowercase-kebab, stable, and describes the job rather than the model.',
      '',
      'Emit exactly ONE fenced ```json block and nothing after it. The user reviews the',
      'draft and commits it; you are not writing to their library.'
    ].join('\n')
  },
  {
    id: '_prompt-drafter',
    name: 'Prompt drafter (system)',
    icon: '✍',
    baseType: 'aiStep',
    role: 'custom',
    system: true,
    description: 'Drafts the prompt field of a node the user is editing. Part of *Draft with AI* — not a library node.',
    prompt: [
      'You draft the PROMPT field of one node in a pipeline: the instructions that node',
      'will send to its model on every run.',
      '',
      'Write the prompt itself — no preamble, no explanation, no code fence. It should:',
      '- state the node\'s job in the first sentence',
      '- say what the output must look like, concretely',
      '- name what the node should NOT do when that is the likely failure',
      '- assume upstream context is supplied automatically and does not need requesting',
      '',
      'The user owns this field. You are filling it in for them to read, edit and keep —',
      'they will see every word before it is ever sent.'
    ].join('\n')
  }
];

export const isKernelId = id => KERNEL_IDS.includes(String(id));
