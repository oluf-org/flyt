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

test('an installed plugin is managed, and one that is not is installed', () => {
  const [there, notThere] = fromPlugins([
    {
      id: 'flyt-tools-repo', name: 'Repo tools', specifier: '@flyt/tools-repo',
      contributes: ['tools'], source: 'bundle:@flyt/tools-repo', state: 'failed', builtin: false,
    },
    { id: 'dsh-skill-badge', name: 'Skill badge', installed: false, contributes: ['skills'] },
  ]);
  // One verb for every installed plugin, because which verbs a plugin can
  // actually offer depends on state the catalog row does not carry — built-in,
  // group, failed — and a button refused on press is worse than no button.
  assert.equal(there.action, 'manage');
  assert.equal(notThere.action, 'install');
  assert.equal(there.detail.state, 'failed', 'the row can say a plugin is broken without opening the manager');
  assert.ok(there.tags.includes('@flyt/tools-repo'),
    'the specifier is what somebody has in hand when they are looking for a package they installed');
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

// --- the library rendered ----------------------------------------------------

test('the search and the entries meet: six registries, one ranked list', async () => {
  // The two halves of t-0076, held together. `libraryEntries` knows six
  // registries and no ranking; `librarySearch` knows ranking and no registry.
  // This is the only place both are true at once, so it is where the seam
  // between them is worth asserting.
  const { librarySearch } = await import('../src/v2/librarySearch.js');
  const { entries, empty } = libraryEntries({
    blocks: blocksRegistry([
      { use: 'flyt-blocks-core:work', title: 'Work', description: 'Change the repository.', category: 'work', settings: {}, ceiling: ['bash'] },
    ]),
    stacks: [{ id: 'loop-task', name: 'Work one backlog task', description: 'One work block.' }],
    tools: [{ id: 'from_a_plugin', description: 'Contributed, unclassified.' }],
    skills: [{ name: 'impeccable', description: 'Critique the work.', requiresTools: ['bash'] }],
  });

  const { matches, facets } = librarySearch(entries, 'work');
  assert.deepEqual(matches.map(m => m.kind), ['block', 'stack', 'skill'],
    'the block titled Work first, then the stack, then the skill that mentions it');
  assert.equal(facets.plugin, 0, 'and a kind with nothing in it is still counted');
  assert.ok(empty.includes('plugin'));

  // The two warnings the library exists to surface survive the round trip.
  const all = librarySearch(entries, '').matches;
  assert.equal(all.find(m => m.id === 'from_a_plugin').detail.unclassified, true);
  assert.deepEqual(all.find(m => m.id === 'impeccable').detail.requiresTools, ['bash']);
});
