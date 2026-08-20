// scrape_page: the Scrapling sidecar, and the three things about it that are
// not incidental (core/tools/scrape_page.js).
//
// Nothing here reaches the network or needs Python: the bridge is stubbed, so
// what is under test is the tool's own contract — that untrusted content says
// so, that a missing environment is a RESULT with a remedy rather than a throw,
// and above all that a browser mode which cannot run NEVER quietly falls back
// to the plain fetcher. That last one is the safety property: falling back
// would hand the caller the very bot wall it was trying to get past, dressed as
// a successful result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, getTools } from '../core/tools/index.js';
import { pythonBridge } from '../core/tools/scrape_page.js';

const store = { appendLog: () => {} };
const ctx = { store, runId: 'r1', config: { userDataDir: '/fake/userdata', python: {} } };

// Swap the bridge for the duration of one call, through the same seam
// web_search exposes: ES module bindings cannot be reassigned from outside, so
// the indirection is what makes either tool testable without a network.
async function withPython({ bin = '/fake/python', result }, fn) {
  const oldFor = pythonBridge.pythonFor;
  const oldRun = pythonBridge.runPythonScript;
  pythonBridge.pythonFor = () => ({ bin, source: 'test' });
  pythonBridge.runPythonScript = async () => result;
  try { return await fn(); }
  finally {
    pythonBridge.pythonFor = oldFor;
    pythonBridge.runPythonScript = oldRun;
  }
}

test('scrape_page is in the library, bound, and declares what it costs you', () => {
  const [tool] = getTools(['scrape_page']);
  assert.ok(tool, 'the module must be in BUILTIN_MODULES or nothing can call it');
  assert.deepEqual(tool.effects, ['network']);
  assert.equal(tool.trust, 'untrusted', 'the pages this exists for are the ones that said no');
  assert.equal(tool.risk, 'caution');
  assert.equal(tool.autoExecute, false);
  // The description is a prompt: it has to route between this tool and its
  // neighbour, or a model will never know which to reach for.
  assert.match(tool.description, /web_fetch/);
  assert.match(tool.description, /never silently downgrades|never silently/i);
});

test('the mode is validated against what the tool actually has', async () => {
  const rec = await executeTool('scrape_page', { url: 'https://example.com', mode: 'telepathy' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /mode/i);
});

test('a URL that is not one is refused with an instruction, not a stack trace', async () => {
  for (const url of ['not-a-url', 'file:///etc/passwd', 'ftp://example.com/x']) {
    const rec = await executeTool('scrape_page', { url }, ctx);
    assert.equal(rec.ok, false, `${url} must not be fetched`);
    assert.match(rec.error, /http/i, 'the error should say what a good argument looks like');
  }
});

test('no interpreter is a result with a remedy, never a throw', async () => {
  // What the real bridge returns for a null bin (core/python.js), rather than
  // a fixture that flatters the tool: the tool does not short-circuit, it
  // delegates, so the delegated shape is the one under test.
  await withPython({
    bin: null,
    result: { ok: false, code: null, error: 'no Python interpreter is configured', remedy: 'Run `flyt python setup` to build it.' }
  }, async () => {
    const rec = await executeTool('scrape_page', { url: 'https://example.com' }, ctx);
    assert.equal(rec.ok, true, 'the TOOL worked; the machine is not set up');
    assert.equal(rec.result.available, false);
    assert.ok(rec.result.reason, 'a refusal a model can read is one it can route around');
    assert.match(rec.result.remedy, /flyt python setup/, 'the remedy has to name the command that fixes it');
  });
});

test('a scraped page comes back as untrusted, and says so in its own result', async () => {
  await withPython({
    result: {
      ok: true, available: true, url: 'https://example.com/', title: 'Example Domain',
      text: '# Example Domain\n\nThis domain is for use in documentation examples.',
      bytes: 180, truncated: false, challenge: false, matched: [], status: 200, mode: 'fetcher',
      trust: 'untrusted'
    }
  }, async () => {
    const rec = await executeTool('scrape_page', { url: 'https://example.com' }, ctx);
    assert.equal(rec.ok, true);
    assert.equal(rec.result.available, true);
    assert.equal(rec.result.trust, 'untrusted');
    assert.match(rec.result.text, /Example Domain/);
    assert.match(String(rec.result.note ?? ''), /instruction/i,
      'a policy document does not travel into the model context; this note does');
  });
});

// The heuristic exists so a caller learns that a 200 was not really a page —
// and learns it as a flag plus a named remedy, not as an empty string it has to
// interpret.
test('a bot wall is reported as a challenge, with the mode to retry on', async () => {
  await withPython({
    result: {
      ok: true, available: true, url: 'https://blocked.example/', text: '', bytes: 0,
      status: 403, mode: 'fetcher', challenge: true, matched: ['status:403'],
      note: 'This looks like a bot wall or a JavaScript-gated page (status:403). Retry with mode=stealth.',
      trust: 'untrusted'
    }
  }, async () => {
    const rec = await executeTool('scrape_page', { url: 'https://blocked.example/' }, ctx);
    assert.equal(rec.result.challenge, true);
    assert.deepEqual(rec.result.matched, ['status:403']);
    assert.match(rec.result.note, /stealth|dynamic/);
  });
});

// The safety property. Falling back to the plain fetcher would return the bot
// wall the caller was trying to get past, as a success.
test('a browser mode that cannot run says so and does NOT fall back', async () => {
  await withPython({
    result: {
      available: false,
      reason: 'the dynamic browser is not installed or could not launch: Executable does not exist',
      remedy: 'Install Chromium for Patchright into the managed environment: patchright install chromium',
      trust: 'untrusted'
    }
  }, async () => {
    const rec = await executeTool('scrape_page', { url: 'https://example.com', mode: 'dynamic' }, ctx);
    assert.equal(rec.ok, true);
    assert.equal(rec.result.available, false);
    assert.match(rec.result.remedy, /install/i, 'the remedy has to name the command');
    assert.equal(rec.result.text, undefined, 'a downgrade would return the wall as content');
  });
});
