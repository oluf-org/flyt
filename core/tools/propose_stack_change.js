// propose_stack_change: what the model would do to this workflow, as a card.
//
// THIS TOOL WRITES NOTHING, and that is its entire design. It validates a list
// of `stack:` commands, names them back, and returns them as a proposal. The
// edit happens later, in the renderer, when a person presses Apply — and it
// happens through `ctx.commands`, the one edit path, exactly as a drag on the
// canvas does (CLAUDE.md). There is no second door into the graph and this is
// not one.
//
// Why a tool at all, rather than letting the model describe the change in
// prose: a sentence is not applicable and cannot be checked. A command list is
// both. The model proposes; the human commits.
//
// The allowlist below is the ceiling, and it is a literal list rather than a
// prefix match on `stack:` — a future command that renames a project or deletes
// a workflow would otherwise be admitted by a rule nobody revisited.
export const PROPOSABLE_COMMANDS = [
  'stack:insert-block',
  'stack:remove-block',
  'stack:move-block',
  'stack:wrap-block',
  'stack:unwrap-container',
  'stack:configure-block',
  'stack:configure-container'
];

export default {
  name: 'propose_stack_change',
  title: 'Propose a change to the open workflow',
  description: [
    'Propose an edit to the workflow open in Build. Give a one-line summary and the',
    'exact commands that would make it:',
    PROPOSABLE_COMMANDS.join(', '),
    '— each with the same arguments the editor uses. NOTHING IS CHANGED by calling this:',
    'the proposal is shown to the person as a card, and only they can apply it.',
    'Call read_stack first so every node id you name actually exists.'
  ].join(' '),
  // Read, because it is: it inspects the bound workflow and returns a
  // description. Marking it a write would gate a call that touches nothing and
  // teach the gate to cry wolf.
  effects: ['read'],
  scope: 'workspace',
  risk: 'safe',
  autoExecute: true,
  keywords: ['workflow', 'edit', 'change', 'propose', 'block', 'add', 'remove', 'configure'],
  examples: [
    'add a review step after the writer block',
    'run these two blocks in parallel instead of one after the other'
  ],
  parameters: {
    type: 'object',
    required: ['summary', 'commands'],
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        description: 'One line, in the person\'s terms: "Add an evaluation step after `draft`." Not a restatement of the command names.'
      },
      commands: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        description: 'The edits, in the order they must be applied.',
        items: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', enum: PROPOSABLE_COMMANDS },
            args: { type: 'object', description: 'The command\'s arguments, e.g. { "nodeId": "draft", "config": { "modelTier": "economy" } }.' }
          }
        }
      },
      rationale: { type: 'string', description: 'Why, if it is not obvious from the summary. One or two sentences.' }
    }
  },
  run(args, ctx) {
    const surface = ctx?.workflow ?? null;
    if (!surface?.stack?.root) {
      throw new Error('No workflow is open in Build, so there is nothing to change. Open one first.');
    }
    const summary = String(args?.summary ?? '').trim();
    if (!summary) throw new Error('A proposal needs a one-line summary a person can read.');

    const ids = new Set(walkIds(surface.stack.root, [surface.stack.root.id]));
    const commands = (args?.commands ?? []).map((step, index) => {
      const name = String(step?.name ?? '');
      if (!PROPOSABLE_COMMANDS.includes(name)) {
        throw new Error(`"${name}" is not a proposable command. Use one of: ${PROPOSABLE_COMMANDS.join(', ')}.`);
      }
      const commandArgs = step?.args && typeof step.args === 'object' ? step.args : {};
      // Check the ids that must ALREADY exist. An id a later command creates is
      // not checkable here, so it is not checked — a proposal refused for
      // naming a node it is about to add would be refused for being correct.
      const existing = commandArgs.nodeId ?? null;
      if (typeof existing === 'string' && !ids.has(existing)) {
        throw new Error(`Command ${index + 1} names "${existing}", which is not in this workflow. Call read_stack for the real ids.`);
      }
      return { name, args: commandArgs };
    });
    if (!commands.length) throw new Error('A proposal with no commands changes nothing. Say what you would do.');

    return {
      proposed: true,
      summary,
      ...(args?.rationale ? { rationale: String(args.rationale) } : {}),
      commands,
      // Said out loud in the result, because the model reads its own tool
      // results and should not go on to report the change as done.
      note: 'Nothing has changed. This is shown to the person, who applies or discards it.'
    };
  }
};

function walkIds(node, out) {
  for (const child of [...(node.children ?? []), ...(node.else ?? [])]) {
    out.push(child.id);
    if (child.kind !== 'block') walkIds(child, out);
  }
  return out;
}
