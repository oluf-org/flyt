// A conversation attached to a project's backlog (DECISIONS.md D45).
//
// WHAT THIS IS NOT, said first because it is the thing that will go wrong:
// this is not a second orchestration surface. It is ONE agent turn loop over a
// READ-MOSTLY toolset, whose single write is `enqueue_task`. Everything
// expensive still goes through the loop, in a worktree, behind gates, with a
// reviewer. The moment this can write files you have built a second,
// unsupervised loop with no worktree — which is the one thing DESIGN-SPEC.md §8
// exists to prevent. The toolset below is the enforcement, not the prompt.
//
// Why it exists at all: every model call in this app previously required
// composing or running a flow. "Why is t-0008 blocked?" and "turn this into
// three tasks" are both one turn and no orchestration, and making a person
// build a graph to ask them is the reason they do not get asked.
//
// STORAGE is `.flyt/chats/<threadId>.jsonl`, one JSON object per turn — the
// same discipline as core/ledger.js. Appendable, greppable, survives a crash
// mid-turn with everything before it intact, and diffable when someone wants to
// know what they asked last Tuesday.
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from './agent.js';
import { resolveTools } from './tools/index.js';
import { blockersFor, boardBlockers, whyNothingReady } from './blockers.js';

// The ceiling. Read-mostly, with `enqueue_task` as the ONE write.
//
// Deliberately a literal list rather than a selector: `effects:read` would
// silently admit every future read tool, and the argument for each member here
// is specific. No `bash`, no `write_file`, no `edit_file`, no `run_gate` — the
// last one because running the project's suite from a chat box is a five-minute
// wait behind a text field, and the loop already runs it.
export const CHAT_TOOLS = [
  'list_tasks', 'read_task', 'why_blocked',   // the queue it is standing in
  'read_file', 'glob', 'search_references',   // the code, read only
  'read_run',                                 // what already happened
  'enqueue_task'                              // the one write
];

// Build's ceiling. Same discipline, different job: it reads the workflow on the
// screen and the code around it, and its one "write" writes nothing — a
// proposal is applied by a person, through ctx.commands, in the renderer.
//
// Deliberately WITHOUT `enqueue_task`: a question about a graph is not a reason
// to put a row on somebody's board, and a chat that quietly queued work while
// you were editing would be the Loop's chat wearing the wrong hat.
export const BUILD_CHAT_TOOLS = [
  'read_stack',                               // the graph on the screen
  'read_file', 'glob', 'search_references',   // the code, read only
  'read_run',                                 // what this workflow did last time
  'propose_stack_change'                      // a card, not an edit
];

const THREAD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TURNS_IN_CONTEXT = 20;

export class ChatStore {
  constructor(rootDir) {
    this.rootDir = rootDir; // <project>/.flyt/chats
    fs.mkdirSync(rootDir, { recursive: true });
    this.problems = [];
  }

  #file(threadId) {
    if (!THREAD_ID.test(String(threadId ?? ''))) throw new Error(`Invalid thread id "${threadId}".`);
    return path.join(this.rootDir, `${threadId}.jsonl`);
  }

  newThreadId() {
    // Sortable and collision-proof enough for a per-project directory a person
    // creates by hand a few times a week.
    return `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Every thread, newest first, with enough to render a rail. */
  threads() {
    let files = [];
    try { files = fs.readdirSync(this.rootDir).filter(f => f.endsWith('.jsonl')); }
    catch { return []; }
    this.problems = [];
    const out = [];
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '');
      try {
        const turns = this.read(id);
        const first = turns.find(t => t.role === 'user');
        out.push({
          id,
          // The first thing the person asked IS the thread's name. A model-
          // generated title is a second model call to produce something less
          // accurate than the sentence already sitting there.
          title: clip(first?.text ?? '', 80) || 'Empty thread',
          turns: turns.length,
          updatedAt: turns.at(-1)?.at ?? null
        });
      } catch (err) {
        this.problems.push({ id, error: String(err?.message ?? err) });
      }
    }
    return out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  }

  /** One thread's turns, in order. A torn last line is skipped, never fatal. */
  read(threadId) {
    let raw;
    try { raw = fs.readFileSync(this.#file(threadId), 'utf8'); }
    catch (err) { if (err?.code === 'ENOENT') return []; throw err; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); }
      catch { /* a crash mid-append leaves one bad line; the rest is good */ }
    }
    return out;
  }

  append(threadId, turn) {
    const line = { at: new Date().toISOString(), ...turn };
    fs.appendFileSync(this.#file(threadId), `${JSON.stringify(line)}\n`);
    return line;
  }

  remove(threadId) {
    try { fs.unlinkSync(this.#file(threadId)); return true; }
    catch (err) { if (err?.code === 'ENOENT') return false; throw err; }
  }
}

/**
 * What the model is told about where it is standing.
 *
 * Grounded rather than generic (D38): it gets the board's actual state, so
 * "what should I work on next" is answerable without a tool call and "why is
 * t-0008 blocked" starts from the right sentence. The instruction that matters
 * most is the last one — propose work, do not attempt it here.
 */
export function chatSystemPrompt({ projectName = null, tasks = [], ctx = {} }) {
  const board = boardBlockers({ ...ctx, tasks });
  const counts = tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {});
  const stuck = tasks
    .filter(t => t.status === 'queued')
    .map(t => ({ t, b: blockersFor(t, { ...ctx, tasks }).filter(x => x.severity === 'blocked') }))
    .filter(e => e.b.length)
    .slice(0, 5);

  return [
    'ROLE: backlog-chat',
    `You are answering questions about the backlog of the project "${projectName ?? 'this project'}" in Flyt,`,
    'a desktop app that runs an unattended loop of AI workers over a queue of tasks.',
    '',
    'THE BOARD RIGHT NOW:',
    Object.entries(counts).map(([k, v]) => `- ${v} ${k}`).join('\n') || '- the backlog is empty',
    board.length ? `\nBLOCKING THE WHOLE PROJECT:\n${board.map(b => `- ${b.summary}`).join('\n')}` : '',
    stuck.length ? `\nSTUCK TASKS:\n${stuck.map(e => `- ${e.t.id}: ${e.b[0].summary}`).join('\n')}` : '',
    `\nThe picker's own summary: ${whyNothingReady({ ...ctx, tasks })}.`,
    '',
    'HOW TO WORK:',
    '- Answer from the tools, not from memory. list_tasks, read_task and why_blocked read the real queue.',
    '- Be short. This is a chat box beside a board, not a report.',
    '- WHEN THE USER ASKS FOR WORK TO BE DONE, PROPOSE A TASK AND CALL enqueue_task.',
    '  Do NOT attempt the work here. You cannot write files, run commands or run tests,',
    '  and that is deliberate: work is done by the loop, in an isolated worktree, behind',
    '  the project\'s gates, with a reviewer. A task you queue gets all of that.',
    '- A good task names the files, states what "done" means as testable assertions, and',
    '  is written for a reader who has not seen this conversation.',
    '- Check list_tasks before queueing, so you do not add a fifth copy of an existing task.'
  ].filter(Boolean).join('\n');
}

/**
 * What Build's chat is told about where it is standing.
 *
 * Grounded the same way the Loop's is, and from the SAME surface the editor
 * draws: the workflow's real steps, its real verification errors, and the block
 * the person has selected. "Why does this fail" is answerable from the first
 * lines of this prompt, which is the difference between a chat beside an editor
 * and a chat that has to go and find out what it is looking at.
 */
export function buildChatSystemPrompt({ projectName = null, workflow = null, selected = null }) {
  const stack = workflow?.stack ?? null;
  const validation = workflow?.validation ?? null;
  const nodes = stack?.root ? outline(stack.root, 0, []) : [];
  const errors = (validation?.errors ?? []).slice(0, 5);
  const warnings = (validation?.warnings ?? []).slice(0, 5);

  return [
    'ROLE: workflow-chat',
    'You are answering questions about a workflow being edited in Flyt’s Build editor,',
    `in the project "${projectName ?? 'this project'}". A workflow is one graph of blocks and`,
    'controls; running it spends money on models, so being accurate about what it does matters.',
    '',
    stack ? `THE WORKFLOW OPEN RIGHT NOW: ${stack.name ?? stack.id ?? 'untitled'}` : 'NO WORKFLOW IS OPEN.',
    nodes.length ? nodes.join('\n') : '',
    selected ? `\nThe person has "${selected}" selected.` : '',
    validation ? `\nSTATIC VERIFICATION: ${validation.ok ? 'passing' : 'FAILING'}` : '',
    errors.length ? `ERRORS:\n${errors.map(e => `- ${e.line ? `line ${e.line}: ` : ''}${e.message}`).join('\n')}` : '',
    warnings.length ? `WARNINGS:\n${warnings.map(w => `- ${w.line ? `line ${w.line}: ` : ''}${w.message}`).join('\n')}` : '',
    '',
    'HOW TO WORK:',
    '- Answer from the tools, not from memory. read_stack is the graph on the screen,',
    '  including edits not yet saved to YAML; read_file and glob are the repository.',
    '- Be short. This is a panel over an editor, not a report.',
    '- WHEN THE USER ASKS FOR THE WORKFLOW TO BE CHANGED, CALL propose_stack_change.',
    '  It changes nothing: the person sees your commands as a card and applies them.',
    '  Never say an edit was made — you cannot make one.',
    '- You cannot write files, run commands or run this workflow. Work is done by a run,',
    '  in an isolated worktree, behind the project’s gates. That is deliberate.',
    '- Every block id you name must already exist. Call read_stack before proposing anything.'
  ].filter(Boolean).join('\n');
}

/** The graph as indented lines — cheaper to read than JSON, and in order. */
function outline(node, depth, out) {
  for (const child of node.children ?? []) {
    const pad = '  '.repeat(depth + 1);
    const what = child.kind === 'block' ? (child.use ?? 'block') : child.kind;
    out.push(`${pad}- ${child.id} (${what})${child.title ? ` — ${child.title}` : ''}`);
    if (child.kind !== 'block') outline(child, depth + 1, out);
    if (child.kind === 'if' && child.else?.length) {
      out.push(`${pad}  else:`);
      outline({ children: child.else }, depth + 1, out);
    }
  }
  return out;
}

/**
 * The channels, as a table.
 *
 * A channel is: where its threads live, what it may call, what it is told, and
 * how its turns’ proposals are read back out. Everything else about a turn is
 * the same for all of them, which is why `runChatTurn` below takes one of these
 * rather than branching on a name — and why a third channel is a row here
 * rather than an edit to the turn loop.
 *
 * `dir` is relative to the project’s chat root. The loop keeps the root itself,
 * because that is where its threads already are and a migration bought only
 * symmetry; `ChatStore.threads()` lists `*.jsonl` and nothing else, so another
 * channel’s subdirectory is invisible to it.
 */
export const CHAT_CHANNELS = {
  loop: {
    id: 'loop',
    dir: '.',
    tools: CHAT_TOOLS,
    system: ({ projectName, tasks, blockerCtx }) => chatSystemPrompt({ projectName, tasks, ctx: blockerCtx }),
    // enqueue_task in propose mode: the card the human commits with task:add.
    proposals: calls => calls
      .filter(c => c.tool === 'enqueue_task' && c.ok && c.result?.proposed)
      .map(c => ({
        id: c.result?.id ?? null,
        title: c.result?.task?.title ?? c.args?.title ?? '',
        goal: c.result?.task?.goal ?? c.args?.goal ?? '',
        // The body Queue it passes to task:add verbatim: the human committing
        // is the same call the model would have made without a witness.
        task: c.result?.task ?? null
      }))
  },
  build: {
    id: 'build',
    dir: 'build',
    tools: BUILD_CHAT_TOOLS,
    system: ({ projectName, workflow, selected }) => buildChatSystemPrompt({ projectName, workflow, selected }),
    // propose_stack_change: the card the human commits through ctx.commands.
    proposals: calls => calls
      .filter(c => c.tool === 'propose_stack_change' && c.ok && c.result?.proposed)
      .map((c, index) => ({
        id: c.result?.id ?? `p-${index + 1}`,
        summary: c.result?.summary ?? c.args?.summary ?? '',
        rationale: c.result?.rationale ?? null,
        commands: c.result?.commands ?? []
      }))
  }
};

/** The channel by name. An unknown one is the loop, never a new store. */
export const chatChannel = name => CHAT_CHANNELS[name] ?? CHAT_CHANNELS.loop;

/**
 * Run one turn.
 *
 * Everything expensive is injected: the caller supplies the worker, the key,
 * the tool ctx and the sinks. This function's job is the shape of a turn —
 * history in, system prompt built, agent run, turns appended — and nothing else.
 *
 * Both halves of the exchange are written even when the model call THROWS. A
 * thread that loses the question along with the answer is a thread where the
 * person cannot see what they asked that broke it.
 *
 * Chat turns call enqueue_task in PROPOSE mode via `proposeTasks` on the tool
 * ctx. A loop worker keeps writing directly — an unattended agent has nobody
 * to confirm with, so propose mode would leave its task unwritten forever. A
 * chat turn has exactly the person the button is for: the card appears with
 * Queue it / Discard before anything exists on disk, and Queue it is the human
 * making the same task:add call the model would have made.
 */
export async function runChatTurn({
  store, threadId, text, worker, apiKey, projectName = null,
  // Which conversation this is. The channel decides the toolset, the prompt and
  // how proposals are read back out — everything else about a turn is the same,
  // so it is the only thing that branches.
  channel = 'loop',
  tasks = [], blockerCtx = {}, workflow = null, selected = null,
  toolCtx = {}, onText = null, onEvent = null,
  signal = null, timeout = null, retry = null
}) {
  const question = String(text ?? '').trim();
  if (!question) throw new Error('An empty message has nothing to answer.');
  const lane = chatChannel(channel);

  store.append(threadId, { role: 'user', text: question });
  onEvent?.({ kind: 'user', channel: lane.id, threadId, text: question });

  const { tools, missing } = resolveTools({ grant: lane.tools, ceiling: lane.tools });
  const system = lane.system({ projectName, tasks, blockerCtx, workflow, selected });
  const prompt = historyPrompt(store.read(threadId), question);

  let result;
  try {
    result = await runAgent({
      worker, apiKey, system, prompt, tools,
      // A chat has no RunStore — there is no runs/<id>/ for it, and inventing
      // one would make every question a run in the history. But `appendLog` is
      // exactly where executeTool announces a call, so a sink in that slot is
      // the documented seam rather than a hook bolted on: tool calls arrive
      // live, in the shape the audit trail already uses.
      // Chat turns enqueue in PROPOSE mode (the model proposes; the human
      // commits). The binding carries the flag because executeTool binds the
      // registry's run, not a copy a caller could wrap — the only door into a
      // model's call is the ctx. The loop's workers never set it: an
      // unattended agent has nobody to confirm with, so its calls stay writes.
      ctx: {
        ...toolCtx, proposeTasks: true,
        // The workflow the editor is drawing, for the channel whose tools read
        // it. Passed on the ctx like every other bound resource, so a tool
        // cannot reach a workflow the caller did not hand it.
        ...(workflow ? { workflow } : {}),
        store: logSink(toolCtx.store, threadId, onEvent, lane.id)
      },
      onText, signal, timeout, retry,
      // What the MODEL call did — budget, finish reason, cost (D40). Distinct
      // from a tool call, and conflating the two is why this was wrong first.
      onCall: rec => onEvent?.({ kind: 'model', channel: lane.id, threadId, model: rec.model ?? null, finishReason: rec.finishReason ?? null })
    });
  } catch (err) {
    const message = String(err?.message ?? err);
    const turn = store.append(threadId, { role: 'assistant', text: '', error: message });
    onEvent?.({ kind: 'error', channel: lane.id, threadId, error: message });
    return { ...turn, error: message };
  }

  // What this turn PROPOSED. Pulled out separately because the UI renders each
  // as a card with a commit button: the model proposes, the human commits, and
  // that is the highest-value interaction in the phase. WHAT a proposal looks
  // like is the channel's business — a queued task on the Loop, a list of
  // `stack:` commands in Build — so its shape comes from the table above.
  const proposals = lane.proposals(result.toolCalls ?? []);

  const turn = store.append(threadId, {
    role: 'assistant',
    text: result.text ?? '',
    model: worker?.model ?? null,
    usage: result.usage ?? null,
    durationMs: result.durationMs ?? null,
    // Tool calls are RECORDED, never hidden. The trust model of this whole app
    // is that you can see what it did, and a chat that quietly reads forty
    // files is the first place that would stop being true.
    toolCalls: (result.toolCalls ?? []).map(c => ({
      tool: c.tool, args: c.args, ok: c.ok, ms: c.ms,
      ...(c.error ? { error: c.error } : {})
    })),
    ...(proposals.length ? { proposals } : {}),
    channel: lane.id,
    ...(missing?.length ? { missingTools: missing } : {})
  });
  onEvent?.({ kind: 'assistant', channel: lane.id, threadId, text: turn.text, proposals });
  return turn;
}

/**
 * The conversation so far, as the prompt.
 *
 * Bounded on purpose. A thread that has run all afternoon should not make every
 * subsequent question cost the whole afternoon again — and the tools can always
 * re-read anything that matters, which is the point of having them.
 */
export function historyPrompt(turns, question) {
  const prior = turns.filter(t => t.text).slice(-MAX_TURNS_IN_CONTEXT - 1, -1);
  const lines = prior.map(t => `${t.role === 'user' ? 'USER' : 'YOU'}: ${t.text}`);
  return [
    lines.length ? `EARLIER IN THIS CONVERSATION:\n${lines.join('\n\n')}` : '',
    `USER: ${question}`
  ].filter(Boolean).join('\n\n');
}

/**
 * A `store`-shaped shim that turns tool-call log lines into live events.
 *
 * Only `appendLog` is implemented, because that is the only method a chat's
 * tools reach: none of them write artifacts, read run files or archive
 * results. Anything a future tool calls falls through to the real store when
 * one was supplied, and is a no-op when one was not — a chat must never fail
 * because a tool tried to write a run file that does not exist.
 */
function logSink(store, threadId, onEvent, channel = 'loop') {
  return {
    ...(store ?? {}),
    appendLog(runId, entry) {
      if (entry?.event === 'tool_call') {
        onEvent?.({
          kind: 'tool', channel, threadId, tool: entry.tool, ok: entry.ok,
          ms: entry.ms, args: entry.args, ...(entry.error ? { error: entry.error } : {})
        });
      }
      return store?.appendLog?.(runId, entry);
    }
  };
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
