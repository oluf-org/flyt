// A tool call the adapter cannot parse must be visible, not prose.
//
// In run 2026-08-23T18-55-27-794Z-87sh an interrogate node on
// ~deepseek/deepseek-v4-flash-latest emitted DeepSeek's native tool-call markup
// as message CONTENT. core/adapters/http.js only assembles
// choice.delta.tool_calls, so the turn recorded zero parsed calls, the
// search_files call never ran, and the raw markup landed in the delivered
// specification where a reader takes it for the deliverable.
//
// The fix: detection beside the empty-stream guard in core/adapters/http.js,
// surfaced as `unparsedToolCall` (the dialect name) on the adapter result, and
// recorded as a problem in the node's retrospective by core/flowRunner.js —
// the same path `interrogation emitted no parseable status JSON` already takes.
//
// The separator in the DSML dialect below is U+FF5C FULLWIDTH VERTICAL LINE,
// NOT an ASCII pipe. The literals here are transcribed from that run; a
// detection written from memory used '|' and matched nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unparsedToolDialect, UNPARSED_TOOL_DIALECTS } from '../core/adapters/http.js';
import { callModel, registerProvider } from '../core/adapters/index.js';

// --- the exact markup, codepoint-checked -----------------------------------

test('the deepseek DSML literal uses U+FF5C FULLWIDTH VERTICAL LINE, not an ASCII pipe', () => {
  const dsml = UNPARSED_TOOL_DIALECTS.find(([d]) => d === 'deepseek-dsml');
  assert.ok(dsml, 'deepseek-dsml dialect must exist');
  // The pattern must contain the fullwidth vertical line and no bare ASCII pipe
  // outside the llama python_tag alternative (which legitimately uses ASCII).
  const asciiPipes = dsml[1].source.match(/\|/g) ?? [];
  assert.ok(dsml[1].source.includes('\\u{FF5C}'),
    'pattern must match U+FF5C via \\u{FF5C} escape');
  assert.equal(asciiPipes.length, 1, 'only the regex alternation pipe expected');
});

test('detects the exact markup observed in run 2026-08-23T18-55-27-794Z-87sh', () => {
  const opening = '<\uFF5CDSML\uFF5Ctool_calls>';
  const invoke = '<\uFF5CDSML\uFF5Cinvoke name="search_files">';
  assert.equal(unparsedToolDialect(`Sure!\n${opening}\n${invoke}\n{"path":"src"}`),
    'deepseek-dsml');
  assert.notEqual(opening, '<|DSML|tool_calls>',
    'guard against anyone "fixing" the literal to ASCII');
});

// --- every known dialect fires ----------------------------------------------

test('each supported dialect is detected when it appears as live content', () => {
  assert.equal(unparsedToolDialect('<tool_call>\n{"name":"read_file"}\n</tool_call>'),
    'hermes-qwen-tool-call');
  assert.equal(unparsedToolDialect('<function_calls>\n<invoke name="search_files">\n</invoke>\n</function_calls>'),
    'anthropic-xml-invoke');
  assert.equal(unparsedToolDialect('partial answer<|python_tag|>{"tool":"bash"}'),
    'llama3-python-tag');
});

// --- never fires when tool calls DID parse ----------------------------------

test('a model narrating alongside real parsed tool calls stays silent', () => {
  // This is what a HEALTHY tool-using turn looks like: prose plus a call that
  // arrived through message.tool_calls. The adapter gates on toolCalls.length,
  // so the same text with calls present produces nothing.
  const text = 'Let me look at the plan. <tool_call>{"name":"read_file"}</tool_call>';
  // Direct check: the detector alone would fire...
  assert.equal(unparsedToolDialect(text), 'hermes-qwen-tool-call');
  // ...but the adapter-level gate suppresses it when calls DID parse. Verified
  // through the non-streaming branch below with tool_calls attached.
});

// --- false positives: prose ABOUT tool calls must stay silent ----------------

test('markup quoted inside a fenced code block does not fire', () => {
  const explaining = [
    'The model emitted its call in the wrong dialect:',
    '',
    '```',
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="search_files">',
    '```',
    '',
    'so the search never ran.'
  ].join('\n');
  assert.equal(unparsedToolDialect(explaining), null,
    'this repository documents these dialects; documenting them must not read as doing one');

  const jsonFence = [
    'Use this shape for the call:',
    '',
    '```json',
    '{ "invoke": "<invoke name=\\"search_files\\">" }',
    '```'
  ].join('\n');
  assert.equal(unparsedToolDialect(jsonFence), null);
});

test('prose merely discussing tool-call syntax does not fire', () => {
  assert.equal(unparsedToolDialect(
    'When a model writes `<tool_call>` tags instead of using the API field, the call is lost.'),
    null);
  assert.equal(unparsedToolDialect(
    'Hermes models use <tool_call>...</tool_call>; Llama uses <|python_tag|>.'),
    null);
  assert.equal(unparsedToolDialect('plain answer, no markup at all'), null);
  assert.equal(unparsedToolDialect(''), null);
  assert.equal(unparsedToolDialect(null), null);
});

// --- end to end at the adapter boundary (streaming + non-streaming) ---------

let calls = [];
const realFetch = globalThis.fetch;
const stubFetch = handler => {
  calls = [];
  globalThis.fetch = async (url, init) => handler({ url, init, body: init?.body ? JSON.parse(init.body) : null });
};
const restoreFetch = () => { globalThis.fetch = realFetch; };
test.afterEach(restoreFetch);

const sseRes = lines => ({
  ok: true, status: 200,
  body: (async function* () {
    const enc = new TextEncoder();
    for (const l of lines) yield enc.encode(`data: ${typeof l === 'string' ? l : JSON.stringify(l)}\n\n`);
  })()
});
const jsonRes = data => ({
  ok: true, status: 200,
  json: async () => data,
  text: async () => JSON.stringify(data)
});
const finishChunk = (finish = 'stop') =>
  ({ choices: [{ delta: {}, finish_reason: finish }] });

test('streamed turn: zero parsed calls + native markup -> unparsedToolCall names the dialect', async () => {
  stubFetch(() => sseRes([
    { choices: [{ delta: { content: 'Looking it up.\n' } }] },
    { choices: [{ delta: { content: '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="search_files">' } }] },
    finishChunk()
  ]));
  const r = await callModel({
    provider: 'openrouter', model: '~deepseek/deepseek-v4-flash-latest',
    system: 'SYS', prompt: 'P', apiKey: 'sk-test', onText: () => {}
  });
  assert.equal(r.text.includes('<｜DSML｜tool_calls>'), true, 'markup still delivered verbatim — visibility, not recovery');
  assert.equal(r.message.tool_calls, undefined, 'no call was parsed, so none may be echoed');
  assert.equal(r.unparsedToolCall, 'deepseek-dsml');
});

test('streamed turn: a REAL parsed tool call alongside similar prose -> silent', async () => {
  stubFetch(() => sseRes([
    { choices: [{ delta: { content: 'I will use the ```tool fence or <tool_call> syntax next time.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search_files', arguments: '{"pattern":"x"}' } }] } }] },
    finishChunk()
  ]));
  const r = await callModel({
    provider: 'openrouter', model: 'any/model',
    system: 'SYS', prompt: 'P', apiKey: 'sk-test', onText: () => {}
  });
  assert.equal(r.unparsedToolCall ?? null, null,
    'a model may legitimately narrate alongside a real call');
});

test('non-streamed turn: zero parsed calls + hermes markup -> unparsedToolCall set', async () => {
  stubFetch(() => jsonRes({
    choices: [{
      message: { role: 'assistant', content: '<tool_call>\n{"name":"read_file","arguments":{"path":"README.md"}}\n</tool_call>' },
      finish_reason: 'stop'
    }]
  }));
  const r = await callModel({
    provider: 'openai', model: 'gpt-x', system: 'SYS', prompt: 'P', apiKey: 'sk-test'
  });
  assert.equal(r.unparsedToolCall, 'hermes-qwen-tool-call');
});

test('non-streamed turn: healthy content -> no unparsedToolCall key at all', async () => {
  stubFetch(() => jsonRes({
    choices: [{ message: { role: 'assistant', content: 'All done.' }, finish_reason: 'stop' }]
  }));
  const r = await callModel({
    provider: 'openai', model: 'gpt-x', system: 'SYS', prompt: 'P', apiKey: 'sk-test'
  });
  assert.equal('unparsedToolCall' in r, false);
});

// --- end to end through the runner: the problem reaches the retrospective ---

import { FlowRunner } from '../core/flowRunner.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

// A fake provider that returns the exact DeepSeek markup as CONTENT — no
// tool_calls field, which is precisely what the real run did.
registerProvider('script', async call => ({
  text: '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="search_files">\n{"pattern":"x"}',
  usage: null
}));

const probeFlow = () => makeFlow(
  [node('in', 'input', { text: 'brief' }),
   node('step', 'aiStep', { role: 'interrogate' }),
   node('out', 'output')],
  [edge('in', 'step'), edge('step', 'out')]);

test('a turn whose markup was not parsed is recorded as a problem in the node retrospective', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(probeFlow(), { userInput: 'a thing' });
  await waitForStage(store, runId, ['done', 'failed']);

  const retro = store.readRetrospectives(runId).step;
  assert.ok(retro, 'the node wrote a retrospective');
  assert.equal(retro.status, 'partial');
  // The interrogate contract itself also failed to parse (the markup is not
  // status JSON), so other problems may sit alongside this one.
  const mine = retro.problems.filter(p => /deepseek-dsml/.test(String(p)));
  assert.equal(mine.length, 1);
  assert.match(mine[0], /no tool ran/);

  // `flyt why` reads these retrospectives (core/diagnostics.js), so naming the
  // dialect here is what surfaces it without reading the call trace.
});

test('prose quoting the markup inside a code fence does NOT report a problem', async () => {
  const store = makeStore();
  // Re-register script for this test only; afterEach of fetch does not cover it.
  registerProvider('script', async () => ({
    text: [
      'The upstream model failed like this:',
      '',
      '```',
      '<｜DSML｜tool_calls>',
      '<｜DSML｜invoke name="search_files">',
      '```',
      '',
      'so plan for it.'
    ].join('\n'),
    usage: null
  }));
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(probeFlow(), { userInput: 'a thing' });
  await waitForStage(store, runId, ['done', 'failed']);

  const retro = store.readRetrospectives(runId).step;
  assert.equal(retro.status, 'success');
  assert.deepEqual(retro.problems, []);
});

