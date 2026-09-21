// Chat channels: one window, two conversations (DECISIONS.md D45).
//
// The Loop's drawer and Build's modal are the SAME component over two channels.
// What these tests hold is the pair of properties that split makes, both of
// which fail silently if they ever stop being true:
//
//   A change to the chat changes both. Asserted by source: neither surface may
//   grow its own thread list, its own compose box or its own tool line — the
//   moment one does, a fix lands on one chat and not the other, and nobody
//   finds out until two panels disagree in a screenshot.
//
//   The window is a text box, not a tutorial. No starter prompts, no paragraph
//   explaining what a chat can do, no heading over an empty pane. What the
//   channel may actually do is its tool ceiling, not a sentence above the box.
//
//   A channel cannot reach another channel's authority. Build's ceiling has no
//   enqueue_task and no writer at all, asserted against the REGISTRY rather
//   than the prompt: a prompt is a request, and a chat beside an editor that
//   can write files is a second unsupervised loop with no worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CHAT_CHANNELS, CHAT_TOOLS, BUILD_CHAT_TOOLS, chatChannel, buildChatSystemPrompt,
} from '../core/chat.js';
import { resolveTools } from '../core/tools/index.js';
import readStack from '../core/tools/read_stack.js';
import proposeStackChange, { PROPOSABLE_COMMANDS } from '../core/tools/propose_stack_change.js';
import { chatTransport, channelOf, CHAT_CHANNELS as UI_CHANNELS } from '../src/chat/chatTransport.js';
import { subjectOf } from '../src/chat/chatChannels.js';

const src = rel => fs.readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

const STACK = {
  id: 'demo',
  name: 'A demo',
  root: {
    id: 'root',
    kind: 'sequence',
    children: [
      { id: 'draft', kind: 'block', use: 'work', title: 'Draft it', config: { modelTier: 'economy' }, outputs: [{ name: 'text', type: 'string' }] },
      {
        id: 'gate', kind: 'if', predicate: { source: 'draft.text', operator: 'is not empty' },
        children: [{ id: 'judge', kind: 'block', use: 'evaluation' }],
        else: [{ id: 'retry', kind: 'block', use: 'work' }],
      },
    ],
  },
  presets: { low: { name: 'Low', blocks: { draft: { effort: 'low' } } } },
};

const surface = (validation = null) => ({ workflow: { stack: STACK, validation } });

// --- the table -------------------------------------------------------------

test('a channel names its own store, toolset, prompt and proposal shape', () => {
  for (const [name, lane] of Object.entries(CHAT_CHANNELS)) {
    assert.equal(lane.id, name);
    assert.equal(typeof lane.dir, 'string');
    assert.ok(Array.isArray(lane.tools) && lane.tools.length);
    assert.equal(typeof lane.system, 'function');
    assert.equal(typeof lane.proposals, 'function');
  }
});

test('an unknown channel is the loop, never a new store on disk', () => {
  assert.equal(chatChannel('nope').id, 'loop');
  assert.equal(chatChannel(undefined).id, 'loop');
  assert.equal(channelOf({}), 'loop', 'an event from before the split is the loop’s');
  assert.equal(channelOf({ channel: 'build' }), 'build');
  assert.equal(channelOf({ channel: 'invented' }), 'loop');
});

test('the two channels keep separate directories, and the loop keeps the one it had', () => {
  assert.equal(CHAT_CHANNELS.loop.dir, '.', 'existing .flyt/chats/*.jsonl must not need moving');
  assert.notEqual(CHAT_CHANNELS.build.dir, CHAT_CHANNELS.loop.dir);
});

// --- the ceilings ----------------------------------------------------------

test('Build’s chat cannot reach a shell, a file write, or the backlog', () => {
  const { tools, refused, missing } = resolveTools({ grant: BUILD_CHAT_TOOLS, ceiling: BUILD_CHAT_TOOLS });
  const names = tools.map(tool => tool.name);

  for (const forbidden of ['bash', 'write_file', 'edit_file', 'create_file', 'run_gate', 'update_task']) {
    assert.ok(!names.includes(forbidden), `Build's chat must not be able to call ${forbidden}`);
  }
  // Not the Loop's chat wearing the wrong hat: a question about a graph is not
  // a reason to put a row on somebody's board.
  assert.ok(!names.includes('enqueue_task'), 'Build’s chat does not queue backlog work');
  for (const allowed of ['read_stack', 'read_file', 'glob', 'propose_stack_change']) {
    assert.ok(names.includes(allowed), `Build's chat should be able to call ${allowed}`);
  }
  assert.deepEqual(refused, []);
  assert.deepEqual(missing, [], 'every tool the build channel names exists in the registry');
});

test('NOTHING in Build’s chat set writes anything', () => {
  const { tools } = resolveTools({ grant: BUILD_CHAT_TOOLS, ceiling: BUILD_CHAT_TOOLS });
  const writers = tools.filter(tool => (tool.effects ?? []).some(effect => ['write', 'shell', 'destructive'].includes(effect)));
  assert.deepEqual(writers.map(tool => tool.name), [],
    'propose_stack_change proposes; the edit happens in the renderer through ctx.commands');
});

test('the two ceilings are different lists, not one list used twice', () => {
  assert.notDeepEqual(CHAT_TOOLS, BUILD_CHAT_TOOLS);
});

// --- read_stack ------------------------------------------------------------

test('read_stack reports the graph the editor is drawing, containment intact', () => {
  const result = readStack.run({}, surface({ ok: false, errors: [{ message: 'boom', line: 4 }], warnings: [] }));
  assert.equal(result.name, 'A demo');
  assert.deepEqual(result.nodes.map(node => node.id), ['draft', 'gate', 'judge', 'retry']);
  assert.equal(result.nodes.find(node => node.id === 'judge').parent, 'gate');
  const otherwise = result.nodes.find(node => node.id === 'retry');
  assert.equal(otherwise.parent, 'gate');
  assert.equal(otherwise.branch, 'else', 'an else branch is not the same slot as the body');
  assert.deepEqual(result.nodes.find(node => node.id === 'draft').outputs, [{ name: 'text', type: 'string' }]);
  assert.deepEqual(result.modes, [{ id: 'low', name: 'Low', overrides: { draft: { effort: 'low' } } }]);
  assert.equal(result.verification.ok, false);
  assert.deepEqual(result.verification.errors, [{ message: 'boom', line: 4 }]);
});

test('read_stack says there is no workflow rather than describing an empty one', () => {
  // "There is no workflow" and "the workflow is empty" are different facts, and
  // a model told the second when the first is true describes a graph that does
  // not exist.
  assert.throws(() => readStack.run({}, {}), /No workflow is open/);
});

// --- propose_stack_change --------------------------------------------------

test('a proposal is returned, never applied', () => {
  const result = proposeStackChange.run({
    summary: 'Make the draft cheaper',
    commands: [{ name: 'stack:configure-block', args: { nodeId: 'draft', config: { modelTier: 'free' } } }],
  }, surface());
  assert.equal(result.proposed, true);
  assert.equal(result.summary, 'Make the draft cheaper');
  assert.deepEqual(result.commands[0].name, 'stack:configure-block');
  assert.match(result.note, /Nothing has changed/);
  // The stack it was handed is the stack it leaves behind.
  assert.deepEqual(STACK.root.children[0].config, { modelTier: 'economy' });
});

test('a proposal naming a node that does not exist is refused, not silently dropped', () => {
  assert.throws(() => proposeStackChange.run({
    summary: 'Configure something', commands: [{ name: 'stack:configure-block', args: { nodeId: 'ghost' } }],
  }, surface()), /not in this workflow/);
});

test('the proposable commands are a literal list, not every `stack:` command', () => {
  // A prefix match would admit a future command nobody revisited this list for.
  assert.ok(PROPOSABLE_COMMANDS.every(name => name.startsWith('stack:')));
  assert.ok(!PROPOSABLE_COMMANDS.includes('stack:run'));
  assert.ok(!PROPOSABLE_COMMANDS.includes('stack:save-source'));
  assert.throws(() => proposeStackChange.run({
    summary: 'Run it', commands: [{ name: 'stack:run' }],
  }, surface()), /not a proposable command/);
});

test('a proposal with no summary or no commands is refused', () => {
  assert.throws(() => proposeStackChange.run({ summary: '  ', commands: [{ name: 'stack:remove-block', args: {} }] }, surface()), /summary/);
  assert.throws(() => proposeStackChange.run({ summary: 'Something', commands: [] }, surface()), /changes nothing/);
});

// --- what each turn's proposals become -------------------------------------

test('each channel reads its own proposals out of the same turn', () => {
  const calls = [
    { tool: 'read_file', ok: true, result: {} },
    { tool: 'enqueue_task', ok: true, args: { title: 'q' }, result: { proposed: true, id: 't-0009', task: { title: 'Fix it', goal: 'g' } } },
    { tool: 'propose_stack_change', ok: true, result: { proposed: true, summary: 'Add a reviewer', commands: [{ name: 'stack:insert-block', args: {} }] } },
  ];
  const queued = CHAT_CHANNELS.loop.proposals(calls);
  assert.deepEqual(queued.map(row => row.id), ['t-0009']);
  assert.equal(queued[0].title, 'Fix it');

  const edits = CHAT_CHANNELS.build.proposals(calls);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].summary, 'Add a reviewer');
  assert.deepEqual(edits[0].commands, [{ name: 'stack:insert-block', args: {} }]);

  // A failed call proposes nothing: a card for an edit the tool refused is a
  // button that cannot work.
  assert.deepEqual(CHAT_CHANNELS.build.proposals([{ tool: 'propose_stack_change', ok: false, result: null }]), []);
});

// --- the prompt ------------------------------------------------------------

test('Build’s prompt carries the real graph and the real errors', () => {
  const prompt = buildChatSystemPrompt({
    projectName: 'flyt', selected: 'draft',
    workflow: { stack: STACK, validation: { ok: false, errors: [{ message: 'draft has no output', line: 7 }], warnings: [] } },
  });
  assert.match(prompt, /THE WORKFLOW OPEN RIGHT NOW: A demo/);
  assert.match(prompt, /- draft \(work\)/);
  assert.match(prompt, /- judge \(evaluation\)/);
  assert.match(prompt, /"draft" selected/);
  assert.match(prompt, /STATIC VERIFICATION: FAILING/);
  assert.match(prompt, /line 7: draft has no output/);
  // The instruction that matters most: it proposes, it does not edit.
  assert.match(prompt, /CALL propose_stack_change/);
  assert.match(prompt, /cannot write files/);
});

test('with nothing open, the prompt says so instead of inventing a graph', () => {
  assert.match(buildChatSystemPrompt({ projectName: 'flyt' }), /NO WORKFLOW IS OPEN/);
});

// --- the transport ---------------------------------------------------------

test('every call carries its channel, and the event stream is filtered by it', async () => {
  const seen = [];
  let listener = null;
  const host = {
    chatThreads: (...args) => { seen.push(['threads', ...args]); return { threads: [] }; },
    chatRead: (...args) => { seen.push(['read', ...args]); return { turns: [] }; },
    chatNew: (...args) => { seen.push(['new', ...args]); return { threadId: 'c-1' }; },
    chatSend: (...args) => { seen.push(['send', ...args]); return {}; },
    chatStop: (...args) => { seen.push(['stop', ...args]); return {}; },
    chatDelete: (...args) => { seen.push(['delete', ...args]); return {}; },
    onChatEvent: cb => { listener = cb; return () => { listener = null; }; },
  };
  const build = chatTransport('build', host);
  await build.threads('p1');
  await build.read('p1', 'c-1');
  await build.create('p1');
  await build.send('p1', 'c-1', 'hello', { model: 'm' });
  await build.stop('p1', 'c-1');
  await build.remove('p1', 'c-1');
  assert.deepEqual(seen.map(call => call.at(-1)), ['build', 'build', 'build', 'build', 'build', 'build'],
    'the channel is the last argument of every verb');

  const heard = [];
  build.subscribe(event => heard.push(event.kind));
  listener({ kind: 'text', channel: 'build' });
  listener({ kind: 'text', channel: 'loop' });
  listener({ kind: 'tool' }); // no channel: the loop's
  assert.deepEqual(heard, ['text'], 'Build never sees the Loop’s tokens');
});

test('an unknown channel addresses the loop rather than a store nobody made', () => {
  assert.equal(chatTransport('invented', {}).channel, 'loop');
  assert.deepEqual(UI_CHANNELS, ['loop', 'build']);
});

test('the model choice is saved per channel, so one chat cannot re-point the other', async () => {
  const saved = [];
  const host = {
    getSettings: () => ({ chat: { worker: { model: 'loop-model' }, workers: { build: { model: 'build-model' } } } }),
    setSettings: patch => { saved.push(patch); return {}; },
  };
  assert.deepEqual(await chatTransport('loop', host).readWorker(), { model: 'loop-model' });
  assert.deepEqual(await chatTransport('build', host).readWorker(), { model: 'build-model' });
  await chatTransport('build', host).saveWorker({ model: 'cheap' });
  assert.deepEqual(saved, [{ chat: { workers: { build: { model: 'cheap' } } } }]);
});

test('a tool line names the argument that matters, per channel toolset', () => {
  assert.equal(subjectOf('loop', 'read_task', { id: 't-0008' }), 't-0008');
  assert.equal(subjectOf('build', 'read_file', { path: 'src/v2/Shell.jsx' }), 'src/v2/Shell.jsx');
  assert.equal(subjectOf('build', 'propose_stack_change', { summary: 'Add a reviewer' }), 'Add a reviewer');
  // A tool the table has not heard of still says what it acted on.
  assert.equal(subjectOf('build', 'invented_tool', { thing: 'a value' }), 'a value');
  assert.equal(subjectOf('build', 'read_file', {}), null);
});

// --- one window ------------------------------------------------------------

test('both surfaces render the one chat component, and neither rebuilds it', () => {
  const loop = src('loop/LoopChat.jsx');
  const build = src('v2/BuildChat.jsx');
  for (const [name, source] of [['LoopChat', loop], ['BuildChat', build]]) {
    assert.match(source, /from '\.\.\/chat\/Chat\.jsx'/, `${name} renders the shared window`);
    assert.match(source, /<Chat\b/, `${name} renders it rather than reimplementing it`);
    // The pieces that must exist once. A surface that grows its own thread
    // list or compose box is a surface a fix will stop reaching.
    for (const shared of ['chatThreads', 'chatSend', 'flyt-composer', 'flyt-chat-body', 'flyt-chat-tool']) {
      assert.ok(!source.includes(shared), `${name} must not carry its own ${shared}`);
    }
  }
  // And what each is allowed to keep: its own proposal card, because that
  // card's button is where the human commits, and the two commit to different
  // things — task:add on the Loop, ctx.commands in Build.
  assert.match(loop, /addTask\(/);
  assert.match(build, /commands\.invoke\(/);
});

test('the chat is a text box, not a tutorial', () => {
  const chat = src('chat/Chat.jsx');
  const channels = src('chat/chatChannels.js');
  // The three things that used to occupy the pane before anyone typed: a list
  // of suggested questions, a sentence describing the chat to its user, and a
  // heading over an empty transcript.
  for (const gone of ['Starters', 'starters', 'starterNote']) {
    assert.ok(!chat.includes(gone), `the chat must not reintroduce ${gone}`);
    assert.ok(!channels.includes(gone), `no channel may carry ${gone}`);
  }
  assert.ok(!src('loop/LoopChat.jsx').includes('starters'));
  assert.ok(!/\bnote\s*:/.test(channels), 'a channel describes itself with a ceiling, not a paragraph');
  // The transcript exists only once there is one.
  assert.match(chat, /const transcript = turns\.length > 0 \|\| busy/);
  assert.match(chat, /\{transcript && \(/);
});

test('the composer is the loop designer\u2019s, widget and all', () => {
  const chat = src('chat/Chat.jsx');
  // The same pill component, not a lookalike: a change to its keyboard handling
  // or its popover lands on both composers.
  assert.match(chat, /from '\.\.\/v2\/ComposerMenu\.jsx'/);
  assert.match(chat, /<ComposerMenu\b/);
  assert.match(chat, /flyt-composer-foot/);
  assert.match(chat, /className="flyt-chat-send"/);
  // And the widget's shape travels with the widget, so a surface that renders
  // it gets it whether or not the Goals route was ever opened.
  assert.match(src('v2/ComposerMenu.jsx'), /import '\.\/composerMenu\.css'/);
  const shape = src('v2/composerMenu.css');
  const goalCss = src('v2/goalStyles.css');
  for (const rule of ['.goal-menu-pop', '.goal-menu-caret', '.goal-menu-dot']) {
    assert.ok(shape.includes(rule), `${rule} belongs with the widget`);
    // Unscoped, at the start of a line: the goal page may still SKIN the widget
    // (`.goal-page .goal-menu-option ... .goal-menu-dot`), it may not define it.
    assert.ok(!new RegExp(`^\\${rule}[\\s,{]`, 'm').test(goalCss),
      `${rule} must not also be defined on the goal page`);
  }
  // The skin stays per-surface, because each sets its own control base.
  assert.match(src('v2/goalStyles.css'), /\.goal-page \.goal-menu-trigger \{/);
  assert.match(src('chat/chatStyles.css'), /\.flyt-chat \.goal-menu-trigger \{/);
});

test('the chat’s rules live with the chat, not in the Loop’s stylesheet', () => {
  const shared = src('chat/chatStyles.css');
  assert.match(shared, /\.flyt-chat-compose/);
  assert.match(shared, /\[data-channel="build"\]/);
  // styles.css keeps the DRAWER that holds the Loop's chat, and nothing else:
  // a `.loop-chat` rule left behind is a rule Build would never get.
  assert.ok(!/\.loop-chat[\s.{]/.test(src('styles.css')), 'no orphaned .loop-chat rules');
  assert.match(src('styles.css'), /\.loop-drawer \{/, 'the drawer itself stays');
});

test('Build’s chat is a modal over the canvas, dismissable without navigating', () => {
  const build = src('v2/BuildChat.jsx');
  const css = src('v2/blockEditorStyles.css');
  assert.match(build, /role="dialog"/);
  assert.match(build, /aria-modal="true"/);
  assert.match(build, /event\.key === 'Escape'/, 'Escape closes it');
  assert.match(css, /\.be-chat-backdrop/);
  assert.match(css, /backdrop-filter: blur/, 'the canvas behind it is blurred, not merely dimmed');
});
