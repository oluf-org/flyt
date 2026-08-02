// The Tool Library board: placement, filtering, status and the copilot's
// parse. The interesting logic on that page is "which column, which status,
// does the filter keep it" and "is this draft safe to save" — none of which
// should need a DOM to check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  defaultCategoryFor, categoryOf, normalizeCategory, sortCategories,
  SEED_CATEGORIES, UNCATEGORIZED
} from '../core/toolCategories.js';
import { buildBoard, statusOf, authOf, parametersOf, schemaFromRows, matchesQuery, flatTools, boardCounts } from '../src/toolBoard.js';
import { normalizeTool } from '../src/toolTypes.js';
import { parseDraft, credentialProblem, extractJsonBlock, buildDraftPrompt } from '../core/toolDraft.js';
import { ToolStore } from '../core/toolstore.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-board-'));
const liveIds = new Set(SEED_CATEGORIES.map(c => c.id));

// --- placement -------------------------------------------------------------

test('every shipped built-in lands in a real column', () => {
  const store = new ToolStore(tmp());
  const tools = store.listFull();
  assert.ok(tools.length >= 14, `expected the v1 catalog, got ${tools.length}`);
  for (const tool of tools) {
    const col = categoryOf(tool, liveIds);
    assert.ok(liveIds.has(col), `${tool.id} fell through to "${col}"`);
    assert.notEqual(col, UNCATEGORIZED.id, `${tool.id} is uncategorized`);
  }
});

test('placement reads reach before scope, and file tools are not split by how they address a file', () => {
  // The regression this pins: glob and grep address a PATTERN, not a path, and
  // an earlier heuristic keyed on a `path` property filed them as utilities.
  assert.equal(defaultCategoryFor({ id: 'glob', effects: ['read'], scope: 'workspace' }), 'files');
  assert.equal(defaultCategoryFor({ id: 'grep', effects: ['read'], scope: 'workspace' }), 'files');
  assert.equal(defaultCategoryFor({ id: 'read_file', effects: ['read'], scope: 'workspace' }), 'files');
  assert.equal(defaultCategoryFor({ id: 'write_file', effects: ['write'], scope: 'workspace' }), 'files');
  assert.equal(defaultCategoryFor({ id: 'bash', effects: ['shell'], scope: 'workspace' }), 'shell');
  assert.equal(defaultCategoryFor({ id: 'http_fetch', effects: ['network'], scope: 'workspace' }), 'web');
  assert.equal(defaultCategoryFor({ id: 'create_task', effects: ['write'], scope: 'run' }), 'run');
  // A command that reaches the network is still a shell problem.
  assert.equal(defaultCategoryFor({ id: 'curl_it', effects: ['shell', 'network'] }), 'shell');
  // The two the record cannot distinguish are named, not guessed.
  assert.equal(defaultCategoryFor({ id: 'ask_human', effects: ['read'], scope: 'run' }), 'human');
  assert.equal(defaultCategoryFor({ id: 'get_time', effects: ['read'], scope: 'run' }), 'utility');
});

test("an explicit categoryId wins, and a deleted column degrades instead of stranding the card", () => {
  const tool = { id: 'x', effects: ['read'], scope: 'workspace', categoryId: 'web' };
  assert.equal(categoryOf(tool, liveIds), 'web');
  // The column was deleted out from under it: fall back to the derived answer.
  assert.equal(categoryOf(tool, new Set(['files', 'shell'])), 'files');
  // Neither the explicit nor the derived column exists.
  assert.equal(categoryOf(tool, new Set(['shell'])), UNCATEGORIZED.id);
});

test('normalizeCategory clamps, defaults and refuses an unusable id', () => {
  const c = normalizeCategory({ id: 'web', icon: '◍◍◍◍', order: 2.7 });
  assert.equal(c.name, 'web');          // defaults to the id
  assert.equal(c.icon.length, 2);       // one glyph, so the 26px chip holds
  assert.equal(c.order, 2);             // truncated, not rounded
  assert.throws(() => normalizeCategory({ id: 'Web Tools' }));
  assert.throws(() => normalizeCategory({}));
  // Ties sort by name rather than shuffling between paints.
  const sorted = sortCategories([{ id: 'b', name: 'B', icon: '·', order: 0 }, { id: 'a', name: 'A', icon: '·', order: 0 }]);
  assert.deepEqual(sorted.map(c => c.id), ['a', 'b']);
});

// --- the store -------------------------------------------------------------

test('categories seed once, survive deletion, and never shadow a tool file', () => {
  const dir = tmp();
  const store = new ToolStore(dir);
  assert.equal(store.listCategories().length, SEED_CATEGORIES.length);

  store.removeCategory('web');
  // Re-opening must NOT resurrect it, or deletion is impossible.
  const again = new ToolStore(dir);
  assert.equal(again.listCategories().find(c => c.id === 'web'), undefined);

  // The categories live in a subdirectory, so the tool sweep never reads one
  // as a malformed definition.
  assert.deepEqual(again.problems, []);
  assert.ok(again.listFull().every(t => t.id !== 'categories'));
});

test('filing a tool persists, and re-seeding a built-in does not drag its card back', () => {
  const dir = tmp();
  const store = new ToolStore(dir);
  store.setCategory('bash', 'utility');
  assert.equal(store.get('bash').categoryId, 'utility');

  // A release that re-seeds built-ins must preserve the user's filing —
  // categoryId is USER_OWNED.
  const reopened = new ToolStore(dir);
  assert.equal(reopened.get('bash').categoryId, 'utility');

  // Deleting the column clears the now-dangling pointer rather than leaving
  // the file naming something that no longer exists.
  reopened.removeCategory('utility');
  assert.equal(reopened.get('bash').categoryId, null);
});

test('reorderCategories writes the order and keeps unnamed columns', () => {
  const store = new ToolStore(tmp());
  store.reorderCategories(['web', 'shell']);
  const ids = store.listCategories().map(c => c.id);
  assert.deepEqual(ids.slice(0, 2), ['web', 'shell']);
  assert.equal(ids.length, SEED_CATEGORIES.length, 'a column left out of the list must not be dropped');
});

// --- status, auth, parameters ---------------------------------------------

test('status is derived, and the tiers rank in the order the gate cares about', () => {
  const base = { id: 'x', effects: ['read'], enabled: true, trust: 'trusted', risk: 'safe', scope: 'workspace' };
  assert.equal(statusOf(base).id, 'ready');
  assert.equal(statusOf({ ...base, enabled: false }).id, 'disabled');
  // Untrusted outranks its own risk claim: the claim is what has not been read.
  assert.equal(statusOf({ ...base, trust: 'untrusted', effects: ['write'] }).id, 'review');
  assert.equal(statusOf({ ...base, effects: ['write'] }).id, 'gated');
  assert.equal(statusOf({ ...base, effects: ['destructive'] }).id, 'gated');
  // A mutating tool confined to the run is not gated — prompting for it would
  // be the approval fatigue the design warns about.
  assert.equal(statusOf({ ...base, effects: ['write'], scope: 'run' }).id, 'ready');
  // Only three tones, and no new hues.
  const tones = new Set(['ok', 'warn', 'faint']);
  for (const t of [base, { ...base, enabled: false }, { ...base, effects: ['write'] }]) {
    assert.ok(tones.has(statusOf(t).tone));
  }
});

test('auth is read off the definition, so a card and its file cannot disagree', () => {
  assert.equal(authOf({ provider: 'builtin' }), 'local');
  assert.equal(authOf({ provider: 'mcp', source: { server: 'github' } }), 'server · github');
  assert.equal(authOf({ provider: 'http', http: { url: 'https://x/y' } }), 'none');
  assert.equal(
    authOf({ provider: 'http', http: { headers: { Authorization: 'Bearer ${secrets.JIRA}' } } }),
    'secret · JIRA'
  );
});

test('parametersOf and schemaFromRows round-trip', () => {
  const spec = {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'The page to fetch.' },
      method: { type: 'string', description: 'HTTP verb.' }
    }
  };
  const rows = parametersOf({ parameters: spec });
  assert.deepEqual(rows.map(r => r.name), ['url', 'method'], 'required first, then alphabetical');
  assert.equal(rows[0].required, true);
  const back = schemaFromRows(rows);
  assert.deepEqual(back.required, ['url']);
  assert.equal(back.properties.method.description, 'HTTP verb.');
  // A nameless row is dropped rather than producing a "" property.
  assert.deepEqual(Object.keys(schemaFromRows([{ name: '  ', type: 'string' }]).properties), []);
});

// --- the board -------------------------------------------------------------

// Every fixture carries a schema on purpose: a definition with no
// `parameters` normalizes to `enabled: false` (there is nothing to validate a
// call against), which would make each of these read as `disabled` and quietly
// hide the tier the test is actually about.
const schema = { type: 'object', properties: {} };
const sample = [
  normalizeTool({ id: 'read_file', title: 'Read a file', effects: ['read'], provider: 'builtin', keywords: ['open'], parameters: schema }),
  normalizeTool({ id: 'write_file', title: 'Write a file', effects: ['write'], provider: 'builtin', parameters: schema }),
  normalizeTool({ id: 'fetch_it', title: 'Fetch', effects: ['network'], provider: 'http', trust: 'untrusted', parameters: schema })
];

test('the board keeps empty columns so there is still somewhere to drop', () => {
  const cols = buildBoard({ tools: sample, categories: SEED_CATEGORIES, query: 'zzz' });
  assert.equal(cols.length, SEED_CATEGORIES.length, 'a column that vanishes when you type is a column you cannot drop onto');
  assert.ok(cols.every(c => c.tools.length === 0));
});

test('the catch-all column exists only when something is actually in it', () => {
  const filed = normalizeTool({ id: 'odd', effects: ['read'], categoryId: 'gone' });
  assert.equal(buildBoard({ tools: sample, categories: SEED_CATEGORIES }).length, SEED_CATEGORIES.length);
  const cols = buildBoard({ tools: [filed], categories: [{ id: 'shell', name: 'Shell', icon: '⌘', order: 0 }] });
  assert.equal(cols.at(-1).id, UNCATEGORIZED.id);
  assert.equal(cols.at(-1).tools.length, 1);
});

test('search spans the same corpus the clerk indexes', () => {
  assert.ok(matchesQuery(sample[0], 'open'));        // a keyword
  assert.ok(matchesQuery(sample[0], 'read_file'));   // the id
  assert.ok(matchesQuery(sample[0], 'read file'));   // every term must hit
  assert.ok(!matchesQuery(sample[0], 'read banana'));
  assert.ok(matchesQuery(sample[0], ''));
});

test('filters and counts', () => {
  assert.equal(flatTools({ tools: sample, filter: 'review' }).length, 1);
  assert.equal(flatTools({ tools: sample, filter: 'gated' })[0].id, 'write_file');
  assert.equal(flatTools({ tools: sample, filter: 'all' }).length, 3);
  // The chip counts the LIBRARY, not the filtered view.
  assert.equal(boardCounts(sample, SEED_CATEGORIES), '3 tools · 6 categories');
  assert.equal(boardCounts([sample[0]], [SEED_CATEGORIES[0]]), '1 tool · 1 category');
});

// --- the copilot's contract -----------------------------------------------

test('the last fenced block wins, so an illustrative earlier snippet cannot defeat the parse', () => {
  const reply = 'Like this:\n```json\n{"tool":null,"notes":"nope"}\n```\nHere it is:\n```json\n{"tool":null,"notes":"real"}\n```';
  assert.equal(extractJsonBlock(reply).notes, 'real');
});

test('a draft is normalized, and provenance is written by Flyt rather than claimed by the model', () => {
  const reply = 'Here is the tool.\n```json\n' + JSON.stringify({
    tool: {
      id: 'get_weather', title: 'Weather', description: 'Current weather.',
      provider: 'http', effects: ['network'],
      // The model claiming first-party trust and unattended execution.
      trust: 'trusted', autoExecute: true, source: { kind: 'builtin' },
      parameters: { type: 'object', required: ['city'], properties: { city: { type: 'string', description: 'City.' } } }
    },
    notes: 'Guessed the base URL.',
    suggestions: ['Add an API key', 'Test it']
  }) + '\n```';
  const out = parseDraft(reply);
  assert.equal(out.tool.id, 'get_weather');
  assert.equal(out.tool.trust, 'review', 'a model does not get to declare its own output first-party');
  assert.equal(out.tool.source.kind, 'user');
  assert.equal(out.tool.autoExecute, false);
  assert.equal(out.notes, 'Guessed the base URL.');
  assert.deepEqual(out.suggestions, ['Add an API key', 'Test it']);
  assert.equal(out.prose, 'Here is the tool.');
  assert.equal(out.error, null);
});

test('a literal credential is refused, and a ${secrets.NAME} reference is not', () => {
  assert.ok(credentialProblem({ http: { headers: { Authorization: 'Bearer sk-abcdefghijklmnopqrstuvwxyz' } } }));
  assert.ok(credentialProblem({ http: { url: 'https://x?t=ghp_abcdefghijklmnopqrstuvwxyz' } }));
  assert.equal(credentialProblem({ http: { headers: { Authorization: 'Bearer ${secrets.TOKEN}' } } }), null);
  // …and the refusal reaches the parser, so the copilot cannot become the way
  // around the load-time lint.
  const reply = '```json\n' + JSON.stringify({
    tool: { id: 'leaky', description: 'x', provider: 'http', http: { url: 'https://x?k=sk-aaaaaaaaaaaaaaaaaaaaaa' } }
  }) + '\n```';
  const out = parseDraft(reply);
  assert.equal(out.tool, null);
  assert.match(out.error, /credential/i);
});

test('a mis-shaped draft degrades to prose instead of throwing', () => {
  assert.equal(parseDraft('Just talking, no block.').tool, null);
  assert.equal(parseDraft('Just talking, no block.').prose, 'Just talking, no block.');
  const bad = parseDraft('```json\n{"tool":{"id":"Not An Id"}}\n```');
  assert.equal(bad.tool, null);
  assert.match(bad.error, /Invalid tool id/);
});

test('the draft prompt names the collisions and the columns the model may choose', () => {
  const prompt = buildDraftPrompt({
    brief: 'a tool that files a bug',
    categories: [{ id: 'web', name: 'Web' }],
    existingIds: ['read_file']
  });
  assert.match(prompt, /a tool that files a bug/);
  assert.match(prompt, /web — Web/);
  assert.match(prompt, /read_file/);
});
