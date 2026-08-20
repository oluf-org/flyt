// extract_page: the trafilatura sidecar, and the three things about it that
// are not incidental (core/tools/extract_page.js).
//
// Nothing here reaches the network or needs Python: the bridge is stubbed, so
// what is under test is the tool's own contract — that untrusted content says
// so, that a missing environment is a RESULT with a remedy rather than a throw,
// and that the parameters map onto trafilatura's extract arguments honestly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, getTools } from '../core/tools/index.js';
import { pythonBridge } from '../core/tools/extract_page.js';

const store = { appendLog: () => {} };
const ctx = { store, runId: 'r1', config: { userDataDir: '/fake/userdata', python: {} } };

// Swap the bridge for the duration of one call, through the same seam
// web_search and scrape_page expose: ES module bindings cannot be reassigned
// from outside, so the indirection is what makes the sidecar testable without
// a network.
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

test('extract_page is in the library, bound, and declares what it costs you', () => {
  const [tool] = getTools(['extract_page']);
  assert.ok(tool, 'the module must be in BUILTIN_MODULES or nothing can call it');
  assert.deepEqual(tool.effects, ['network']);
  assert.equal(tool.trust, 'untrusted', 'the article is somebody else\'s writing');
  assert.equal(tool.risk, 'caution');
  assert.equal(tool.autoExecute, false);
  // The description is a prompt: it has to say there is no browser or stealth
  // mode and route to scrape_page for a page that needs either, or a model
  // will reach for the wrong tool.
  assert.match(tool.description, /scrape_page/);
  assert.match(tool.description, /no browser|NO browser/i);
  assert.match(tool.description, /no stealth|NO stealth/i);
});

test('a URL that is not one is refused with an instruction, not a stack trace', async () => {
  for (const url of ['not-a-url', 'file:///etc/passwd', 'ftp://example.com/x']) {
    const rec = await executeTool('extract_page', { url }, ctx);
    assert.equal(rec.ok, false, `${url} must not be fetched`);
    assert.match(rec.error, /http/i, 'the error should say what a good argument looks like');
  }
});

test('no interpreter is a result with a remedy naming trafilatura, never a throw', async () => {
  await withPython({
    bin: null,
    result: { ok: false, code: null, error: 'no Python interpreter is configured', remedy: 'Run `flyt python setup` to build it.' }
  }, async () => {
    const rec = await executeTool('extract_page', { url: 'https://example.com' }, ctx);
    assert.equal(rec.ok, true, 'the TOOL worked; the machine is not set up');
    assert.equal(rec.result.available, false);
    assert.ok(rec.result.reason, 'a refusal a model can read is one it can route around');
    assert.match(rec.result.remedy, /flyt python setup --packages trafilatura/,
      'the remedy has to name the exact command that fixes it');
  });
});

test('a missing trafilatura package is a result with the setup remedy, not a throw', async () => {
  await withPython({
    result: {
      available: false,
      reason: 'trafilatura is not importable in the resolved Python environment: ModuleNotFoundError: No module named \'trafilatura\'',
      remedy: 'Run `flyt python setup --packages trafilatura` to install the extraction library into Flyt\'s managed Python environment.',
      trust: 'untrusted'
    }
  }, async () => {
    const rec = await executeTool('extract_page', { url: 'https://example.com' }, ctx);
    assert.equal(rec.ok, true);
    assert.equal(rec.result.available, false);
    assert.match(rec.result.remedy, /flyt python setup --packages trafilatura/);
  });
});

test('an extracted article comes back as untrusted, and says so in its own result', async () => {
  await withPython({
    result: {
      ok: true, available: true, url: 'https://en.wikipedia.org/wiki/Web_scraping',
      text: '# Web scraping\n\nWeb scraping, web harvesting, or web data extraction is data scraping used for extracting data from websites.',
      format: 'markdown', includeLinks: true, includeTables: true,
      bytes: 180, truncated: false, trust: 'untrusted'
    }
  }, async () => {
    const rec = await executeTool('extract_page', { url: 'https://en.wikipedia.org/wiki/Web_scraping' }, ctx);
    assert.equal(rec.ok, true);
    assert.equal(rec.result.available, true);
    assert.equal(rec.result.trust, 'untrusted');
    assert.match(rec.result.text, /Web scraping/);
    // The whole reason this tool exists: the article, not the chrome.
    assert.doesNotMatch(rec.result.text, /Jump to content|Privacy policy|Create account/);
    assert.match(String(rec.result.note ?? ''), /instruction/i,
      'a policy document does not travel into the model context; this note does');
  });
});

test('format and the include flags reach the Python script as trafilatura\'s switches', async () => {
  let seen = null;
  await withPython({
    result: {
      ok: true, available: true, url: 'https://example.com/', text: 'plain text body',
      format: 'text', includeLinks: false, includeTables: false,
      bytes: 20, truncated: false, trust: 'untrusted'
    }
  }, async () => {
    const oldRun = pythonBridge.runPythonScript;
    pythonBridge.runPythonScript = async (script, payload) => {
      seen = payload;
      return {
        ok: true, available: true, url: 'https://example.com/', text: 'plain text body',
        format: 'text', includeLinks: false, includeTables: false,
        bytes: 20, truncated: false, trust: 'untrusted'
      };
    };
    try {
      const rec = await executeTool('extract_page', {
        url: 'https://example.com', format: 'text', includeLinks: false, includeTables: false
      }, ctx);
      assert.equal(rec.ok, true);
      assert.equal(rec.result.format, 'text');
    } finally { pythonBridge.runPythonScript = oldRun; }
  });
  assert.deepEqual(seen, { url: 'https://example.com/', format: 'text', includeLinks: false, includeTables: false });
});

test('a page with no main content is an understood failure pointing at scrape_page', async () => {
  await withPython({
    result: {
      ok: false,
      error: 'fetched https://blocked.example/ but trafilatura extracted no main content (likely a login wall, a redirect, or a page that needs JavaScript — try scrape_page with mode dynamic)',
      url: 'https://blocked.example/', trust: 'untrusted'
    }
  }, async () => {
    const rec = await executeTool('extract_page', { url: 'https://blocked.example/' }, ctx);
    assert.equal(rec.ok, false);
    assert.match(rec.error, /scrape_page/);
    assert.match(rec.error, /no main content/);
  });
});

// The helpers the tests above use, so the stubbing is one shape through the
// file rather than five inline variations.
async function executeRun(args, ctx) {
  return executeTool('extract_page', args, ctx);
}
const execute = executeRun;