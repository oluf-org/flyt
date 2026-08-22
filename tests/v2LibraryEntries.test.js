// Six registries, one list of entries (t-0076).
//
// The constraint that makes this worth having: every converter reads only what
// its kind ALREADY PUBLISHES. A description written here for the library's
// benefit would go stale the first time the real one changed and nothing would
// notice — which is what the four lists this replaces did.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS, libraryEntries, fromBlocks, fromTools, fromSkills, fromModels, fromPlugins, fromStacks,
} from '../src/v2/libraryEntries.js';

const blocksRegistry = list => ({ list: () => list });

test('a block describes itself from its registry entry, and nothing else', () => {
  const [e] = fromBlocks(blocksRegistry([{
    use: 'flyt-blocks-core:work',
    title: 'Work',
    description: 'Does the work, with tools.',
    category: 'work',
    settings: { type: 'object' },
    ceiling: ['read_file', 'bash'],
  }]));
  assert.equal(e.kind, 'block');
  assert.equal(e.id, 'flyt-blocks-core:work');
  assert.equal(e.title, 'Work');
  assert.equal(e.description, 'Does the work, with tools.');
  assert.equal(e.action, 'insert');
  assert.deepEqual(e.tags, ['work', 'read_file', 'bash'],
    'the category is a tag too, so one search finds every judgement block');
  assert.deepEqual(e.detail.settings, { type: 'object' }, 'the form the editor renders comes with it');
});

test('a tool with no declared effects is marked unclassified', () => {
  // Unclassified means it is in no toolset and no ceiling can reach it (D57).
  // A library that shows it as ordinary invites somebody to plan around it.
  const [plain, unclassified] = fromTools([
    { id: 'read_file', title: 'Read a file', description: 'Read it.', effects: ['read'], risk: 'safe', scope: 'workspace' },
    { id: 'from_a_plugin', description: 'Who knows.' },
  ]);
  assert.equal(plain.detail.unclassified, false);
  assert.deepEqual(plain.tags, ['read', 'safe', 'workspace']);
  assert.equal(unclassified.detail.unclassified, true);
  assert.equal(unclassified.title, 'from_a_plugin', 'an untitled tool is still findable by its id');
});

test('a skill carries the tools it REQUESTS, because that is part of what it is', () => {
  // D58: a skill may request tools, a human grants them, and the grant moment
  // should be loud. It starts by being visible here.
  const [e] = fromSkills([{ name: 'impeccable', description: 'Critique it.', requiresTools: ['bash'] }]);
  assert.equal(e.kind, 'skill');
  assert.equal(e.action, 'attach');
  assert.deepEqual(e.detail.requiresTools, ['bash']);
});

test('a model describes itself from the catalog, prices included', () => {
  const [e] = fromModels(
    [{ id: 'z-ai/glm-5.2:free', source: 'openrouter' }],
    { 'z-ai/glm-5.2:free': { name: 'GLM 5.2 (free)', contextLength: 256_000, supportsTools: true, inUsdPerM: 0, outUsdPerM: 0 } },
  );
  assert.equal(e.title, 'GLM 5.2 (free)');
  assert.match(e.description, /256k context/);
  assert.match(e.description, /tools/);
  assert.ok(e.tags.includes('free'), 'free is a facet somebody searches by');
  assert.equal(e.action, 'pin');
});

test('a plugin that is not installed offers install, and one that is offers configure', () => {
  const [there, notThere] = fromPlugins([
    { id: 'flyt-tools-repo', name: 'Repo tools', contributes: ['tools'], source: 'bundled' },
    { id: 'dsh-skill-badge', name: 'Skill badge', installed: false, contributes: ['skills'] },
  ]);
  assert.equal(there.action, 'configure');
  assert.equal(notThere.action, 'install');
});

test('a stack is opened, not inserted', () => {
  const [e] = fromStacks([{ id: 'loop-task', name: 'Loop task', description: 'One work block.', blockCount: 1 }]);
  assert.equal(e.kind, 'stack');
  assert.equal(e.action, 'open');
  assert.equal(e.detail.blocks, 1);
});

test('every kind lands in one list, and the empty ones are named', () => {
  const { entries, empty } = libraryEntries({
    blocks: blocksRegistry([{ use: 'a:b', title: 'B', description: '', category: 'work', settings: {}, ceiling: null }]),
    tools: [{ id: 'bash', description: 'Run it.', effects: ['shell'] }],
    models: ['x/y'],
  });
  assert.deepEqual([...new Set(entries.map(e => e.kind))].sort(), ['block', 'model', 'tool']);
  assert.deepEqual(empty, ['stack', 'plugin', 'skill'],
    '"nothing installed" and "nothing matched" are different sentences, and only the first is about the project');
  assert.ok(empty.every(k => KINDS.includes(k)));
});

test('an absent source contributes nothing rather than requiring an empty array', () => {
  const { entries, empty } = libraryEntries();
  assert.deepEqual(entries, []);
  assert.deepEqual(empty, KINDS, 'a project with nothing in it is not a broken library');
});
