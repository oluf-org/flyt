// Unit tests for the subscription (CLI-delegation) providers
// (SUBSCRIPTION-AUTH-GUIDE): the pure parts of the two adapters — argv
// construction, stream-JSON reduction, credential detection, executable
// resolution — plus their integration into the provider registry, the
// priority walk, the default-worker tables, and the safety-model pick.
// Nothing here spawns a CLI or touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findOnPath, npmShimScript, resolveCli,
  claudeCredentialStatus, codexCredentialStatus, cliEnv
} from '../core/adapters/cliDelegate.js';
import { buildClaudeArgs, claudeStreamReducer } from '../core/adapters/claudeCode.js';
import { buildCodexArgs, composeCodexPrompt, codexStreamReducer } from '../core/adapters/codexCli.js';
import { canServe } from '../core/adapters/index.js';
import {
  migrateSettings, createResolver,
  PROVIDER_IDS, KEYED_PROVIDERS, SUBSCRIPTION_PROVIDERS, DEFAULT_PRIORITY, CURATED_MODELS
} from '../core/modelSource.js';
import { pickDefaultWorker, PROVIDER_ORDER, PROVIDER_MODEL_PRIORITY } from '../core/modelPriority.js';
import { pickSafetyModel, SAFETY_MODEL_CANDIDATES } from '../core/safetyCheck.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llmflow-sub-'));

// --- registry & id rules -----------------------------------------------------

test('subscription providers are registered, prioritized after their API sibling, and never keyed', () => {
  for (const p of SUBSCRIPTION_PROVIDERS) {
    assert.ok(PROVIDER_IDS.includes(p), `${p} in PROVIDER_IDS`);
    assert.ok(!KEYED_PROVIDERS.includes(p), `${p} is not a keyed provider`);
    assert.ok(CURATED_MODELS[p]?.length, `${p} has a curated model list`);
  }
  assert.equal(DEFAULT_PRIORITY.indexOf('claude-code'), DEFAULT_PRIORITY.indexOf('anthropic') + 1);
  assert.equal(DEFAULT_PRIORITY.indexOf('codex'), DEFAULT_PRIORITY.indexOf('openai') + 1);
});

test('canServe: claude-code takes claude-* ids, codex takes gpt-/o-/codex ids', () => {
  assert.equal(canServe('claude-code', 'claude-sonnet-5'), true);
  assert.equal(canServe('claude-code', 'gpt-5.2'), false);
  assert.equal(canServe('codex', 'gpt-5.2-codex'), true);
  assert.equal(canServe('codex', 'o4'), true);
  assert.equal(canServe('codex', 'claude-sonnet-5'), false);
});

test('resolver: a claude id falls through to the subscription when no Anthropic key is saved', () => {
  const connected = ['claude-code', 'openrouter'];
  const resolve = createResolver({
    hasKey: p => connected.includes(p) || p === 'mock',
    canServe,
    priority: DEFAULT_PRIORITY
  });
  assert.deepEqual(resolve('claude-sonnet-5'), { provider: 'claude-code', model: 'claude-sonnet-5' });
});

test('migration normalizes subscription entries: opt-in boolean, trimmed overrides, unknown providers dropped', () => {
  const s = migrateSettings({
    subscriptions: {
      'claude-code': { enabled: true, home: '  D:\\claude-home  ', cliPath: '', junk: 1 },
      codex: { enabled: 'yes' },
      bogus: { enabled: true }
    }
  });
  assert.deepEqual(s.subscriptions, {
    'claude-code': { enabled: true, home: 'D:\\claude-home' },
    codex: { enabled: false }
  });
  assert.deepEqual(migrateSettings({}).subscriptions, {});
});

// --- default-worker tables ---------------------------------------------------

test('PROVIDER_ORDER slots each subscription runtime right after its API sibling', () => {
  for (const [kind, efforts] of Object.entries(PROVIDER_ORDER)) {
    for (const [effort, order] of Object.entries(efforts)) {
      assert.equal(order.indexOf('claude-code'), order.indexOf('anthropic') + 1, `${kind}/${effort} claude-code`);
      assert.equal(order.indexOf('codex'), order.indexOf('openai') + 1, `${kind}/${effort} codex`);
    }
  }
});

test('pickDefaultWorker: a subscription-only user gets that runtime\'s best model', () => {
  const codeHigh = { type: 'aiStep', data: { role: 'execute', category: 'Code general', effort: 'high' } };
  assert.deepEqual(
    pickDefaultWorker(codeHigh, { providerKeys: { 'claude-code': 'subscription' } }),
    { provider: 'claude-code', model: PROVIDER_MODEL_PRIORITY.anthropic.code.high[0] }
  );
  assert.deepEqual(
    pickDefaultWorker(codeHigh, { providerKeys: { codex: 'subscription' } }),
    { provider: 'codex', model: 'gpt-5.2-codex' }
  );
  // With an Anthropic key alongside, the metered key still wins by default.
  assert.equal(
    pickDefaultWorker(codeHigh, { providerKeys: { anthropic: 'k', 'claude-code': 'subscription' } }).provider,
    'anthropic'
  );
});

test('pickSafetyModel: Haiku is picked for a Claude-subscription-only user (altProviders)', () => {
  const connected = p => p === 'claude-code';
  assert.equal(pickSafetyModel('auto', connected), 'claude-haiku-4-5');
  const haiku = SAFETY_MODEL_CANDIDATES.find(c => c.id === 'claude-haiku-4-5');
  assert.deepEqual(haiku.altProviders, ['claude-code']);
});

// --- claude adapter: argv + stream reduction --------------------------------

test('buildClaudeArgs: single-shot model call — replaced system prompt, all tools disabled, streaming JSON', () => {
  const args = buildClaudeArgs({ model: 'claude-sonnet-5', system: 'Be terse.' });
  assert.ok(args.includes('-p'));
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
  assert.ok(args.includes('--include-partial-messages'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'claude-sonnet-5']);
  assert.deepEqual(args.slice(args.indexOf('--system-prompt'), args.indexOf('--system-prompt') + 2), ['--system-prompt', 'Be terse.']);
  // --tools '' is last so the variadic flag can't swallow another argument.
  assert.deepEqual(args.slice(-2), ['--tools', '']);
  // No system prompt -> no --system-prompt flag at all.
  assert.ok(!buildClaudeArgs({ model: 'claude-haiku-4-5' }).includes('--system-prompt'));
});

test('claudeStreamReducer: deltas stream, the result envelope is authoritative, usage is captured', () => {
  const r = claudeStreamReducer();
  assert.equal(r.push(JSON.stringify({ type: 'system', subtype: 'init' })), false);
  assert.equal(r.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } })), true);
  assert.equal(r.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } })), true);
  assert.equal(r.state.text, 'Hello');
  r.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello.' }], usage: { input_tokens: 10 } } }));
  assert.equal(r.state.text, 'Hello.');
  r.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hello.', usage: { input_tokens: 10, output_tokens: 3 } }));
  assert.equal(r.state.resultText, 'Hello.');
  assert.equal(r.state.isError, false);
  assert.deepEqual(r.state.usage, { input_tokens: 10, output_tokens: 3 });
  assert.equal(r.push('not json'), false, 'garbage lines are ignored');
});

test('claudeStreamReducer: an error result is flagged and carries its text', () => {
  const r = claudeStreamReducer();
  r.push(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Usage limit reached' }));
  assert.equal(r.state.isError, true);
  assert.equal(r.state.errorText, 'Usage limit reached');
});

// --- codex adapter: argv + prompt + stream reduction -------------------------

test('buildCodexArgs: fenced non-interactive exec — read-only sandbox, ephemeral, stdin prompt', () => {
  const args = buildCodexArgs({ model: 'gpt-5.2-codex', cwd: 'C:\\neutral', lastMessageFile: 'C:\\out.txt' });
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.deepEqual(args.slice(args.indexOf('-s'), args.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.deepEqual(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2), ['-C', 'C:\\neutral']);
  assert.deepEqual(args.slice(args.indexOf('-o'), args.indexOf('-o') + 2), ['-o', 'C:\\out.txt']);
  assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', 'gpt-5.2-codex']);
  assert.equal(args.at(-1), '-', 'prompt arrives on stdin');
});

test('composeCodexPrompt: system rides ahead of the task; absent system passes the prompt through', () => {
  assert.equal(composeCodexPrompt('', 'do x'), 'do x');
  const composed = composeCodexPrompt('Be terse.', 'do x');
  assert.ok(composed.startsWith('SYSTEM INSTRUCTIONS'));
  assert.ok(composed.includes('Be terse.'));
  assert.ok(composed.endsWith('TASK:\ndo x'));
});

test('codexStreamReducer: agent messages stream, turn usage folds cached input, failures surface', () => {
  const r = codexStreamReducer();
  assert.equal(r.push(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } })), false);
  assert.equal(r.push(JSON.stringify({ type: 'item.updated', item: { type: 'agent_message', text: 'partial' } })), true);
  assert.equal(r.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } })), true);
  assert.equal(r.state.text, 'final answer');
  r.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 7, output_tokens: 11 } }));
  assert.deepEqual(r.state.usage, { input_tokens: 12, output_tokens: 11 });

  const legacy = codexStreamReducer();
  assert.equal(legacy.push(JSON.stringify({ msg: { type: 'agent_message', message: 'old shape' } })), true);
  assert.equal(legacy.state.text, 'old shape');

  const failed = codexStreamReducer();
  failed.push(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit' } }));
  assert.equal(failed.state.errorText, 'usage limit');
});

// --- credential detection ----------------------------------------------------

test('claudeCredentialStatus: .claude/.credentials.json or an oauthAccount in .claude.json means signed in', () => {
  const home = tmp();
  assert.equal(claudeCredentialStatus(home).signedIn, false);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
  assert.equal(claudeCredentialStatus(home).signedIn, true);

  const macish = tmp(); // keychain-style: no credentials file, oauthAccount in state
  fs.writeFileSync(path.join(macish, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' } }));
  assert.equal(claudeCredentialStatus(macish).signedIn, true);
});

test('codexCredentialStatus: auth.json under the (overridable) codex home', () => {
  const home = tmp();
  assert.equal(codexCredentialStatus(home).signedIn, false);
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  assert.equal(codexCredentialStatus(home).signedIn, true);
});

// --- executable resolution ---------------------------------------------------

test('findOnPath + npmShimScript + resolveCli: real exes win over shims; shims dispatch to their JS entry via node', () => {
  const shimDir = tmp();
  const exeDir = tmp();
  fs.writeFileSync(path.join(shimDir, 'fake.cmd'), '@echo off');
  fs.mkdirSync(path.join(shimDir, 'node_modules', '@vendor', 'fake'), { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'node_modules', '@vendor', 'fake', 'cli.js'), '// entry');
  fs.writeFileSync(path.join(exeDir, 'fake.exe'), 'MZ');

  const envPath = [shimDir, exeDir].join(path.delimiter);
  const hits = findOnPath(['fake.exe', 'fake.cmd'], envPath);
  assert.equal(hits.length, 2);

  assert.equal(
    npmShimScript(path.join(shimDir, 'fake.cmd'), '@vendor/fake', 'cli.js'),
    path.join(shimDir, 'node_modules', '@vendor', 'fake', 'cli.js')
  );

  // A .cmd override resolves to node + the JS entry, never to cmd.exe.
  const viaShim = resolveCli({
    override: path.join(shimDir, 'fake.cmd'),
    names: ['fake'], npmPkg: '@vendor/fake', npmEntry: 'cli.js'
  });
  assert.equal(viaShim.command, process.execPath);
  assert.ok(viaShim.viaNode);
  assert.ok(viaShim.args[0].endsWith('cli.js'));

  // A direct exe override spawns as-is.
  const viaExe = resolveCli({ override: path.join(exeDir, 'fake.exe'), names: ['fake'] });
  assert.deepEqual(viaExe, { command: path.join(exeDir, 'fake.exe'), args: [] });
});

test('cliEnv: strips the provider API key and repoints the home variables', () => {
  const before = process.env.FAKE_STRIP_ME;
  process.env.FAKE_STRIP_ME = 'secret';
  try {
    const env = cliEnv({ stripVars: ['FAKE_STRIP_ME'], home: 'D:\\alt-home', homeVars: ['HOME', 'USERPROFILE'] });
    assert.ok(!('FAKE_STRIP_ME' in env));
    assert.equal(env.HOME, 'D:\\alt-home');
    assert.equal(env.USERPROFILE, 'D:\\alt-home');
    assert.equal(process.env.FAKE_STRIP_ME, 'secret', 'the real environment is untouched');
  } finally {
    if (before === undefined) delete process.env.FAKE_STRIP_ME; else process.env.FAKE_STRIP_ME = before;
  }
});
