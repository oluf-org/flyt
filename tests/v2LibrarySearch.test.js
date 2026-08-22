// One query, every kind, one result list (t-0078).
//
// Pure, and it does not know where an entry came from — `libraryEntries.js`
// converts each registry and this ranks and filters. That split is why this
// file is six lines of fixture rather than six registries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { librarySearch, matchField, facetsOf, FIELDS } from '../src/v2/librarySearch.js';
import { KINDS } from '../src/v2/libraryEntries.js';

const entry = (kind, id, over = {}) => ({
  kind, id, title: id, description: '', tags: [], action: 'open', ...over,
});

const SHELF = [
  entry('stack', 'loop-task', { title: 'Work one backlog task', description: 'One work block.' }),
  entry('block', 'flyt-blocks-core:work', { title: 'Work', description: 'Change the repository.', tags: ['work'], action: 'insert' }),
  entry('tool', 'bash', { title: 'Run a command', description: 'A shell in the workspace.', tags: ['shell'], action: 'inspect' }),
  entry('model', 'z-ai/glm-5.2:free', { title: 'GLM 5.2 (free)', description: '256k context · tools', tags: ['free'], action: 'pin' }),
  entry('skill', 'impeccable', { title: 'Impeccable', description: 'Critique the work.', action: 'attach' }),
];

test('one query returns matches across every kind, in one list', () => {
  const { matches } = librarySearch(SHELF, 'work');
  assert.deepEqual(matches.map(m => m.kind), ['block', 'stack', 'skill', 'tool'],
    'four kinds, one list, ranked by WHERE the word was: a block titled Work and a stack'
    + ' whose title mentions it, then two descriptions');
  // `bash` is in there because "a shell in the workspace" contains "work".
  // Substring matching, and deliberately: a search box that would not find
  // `glm-5.2` inside `z-ai/glm-5.2:free` is a search box people stop using.
  assert.equal(matches.find(m => m.id === 'bash').matched, 'description');
  assert.ok(matches.every(m => m.action), 'each carries the action that belongs to it');
});

test('ranking is title, then tags, then description, and ties are stable', () => {
  assert.deepEqual(FIELDS, ['title', 'tags', 'description']);
  assert.equal(matchField(SHELF[1], 'Work'), 'title');
  assert.equal(matchField(SHELF[2], 'shell'), 'tags');
  assert.equal(matchField(SHELF[2], 'workspace'), 'description');
  assert.equal(matchField(SHELF[2], 'nothing here'), null);

  // The same search twice is the same order. A list that reshuffles when
  // nothing changed reads as a bug even when it is not.
  const once = librarySearch(SHELF, 'o').matches.map(m => m.id);
  const twice = librarySearch([...SHELF].reverse(), 'o').matches.map(m => m.id);
  assert.deepEqual(once, twice);
});

test('an id matches even when the title does not mention it', () => {
  const { matches } = librarySearch(SHELF, 'glm-5.2');
  assert.deepEqual(matches.map(m => m.id), ['z-ai/glm-5.2:free'],
    'people search for the thing they will type into a config file');
});

test('an empty query returns everything, so the library browses', () => {
  const { matches, total } = librarySearch(SHELF, '');
  assert.equal(matches.length, SHELF.length);
  assert.equal(total, SHELF.length);
});

test('facets narrow the same result set, and an empty one is still counted', () => {
  const all = librarySearch(SHELF, 'work');
  assert.equal(all.facets.block, 1);
  assert.equal(all.facets.stack, 1);
  assert.equal(all.facets.plugin, 0,
    'a facet that disappears when it is empty cannot answer "are there any plugins matching this"');
  assert.deepEqual(Object.keys(all.facets).sort(), [...KINDS].sort(), 'every kind, always');

  const narrowed = librarySearch(SHELF, 'work', { kinds: ['stack'] });
  assert.deepEqual(narrowed.matches.map(m => m.id), ['loop-task']);
  assert.deepEqual(narrowed.facets, all.facets,
    'the counts come from the unnarrowed matches — a facet counted after its own filter is always its own total');
});

test('a limit keeps the top of the ranking, not an arbitrary slice', () => {
  const { matches, total } = librarySearch(SHELF, '', { limit: 2 });
  assert.equal(matches.length, 2);
  assert.equal(total, SHELF.length, 'and the total still says how many there were');
});

test('an entry with a kind nobody declared is refused, naming the kinds there are', () => {
  assert.throws(
    () => librarySearch([...SHELF, entry('gadget', 'x')], ''),
    /Not a library kind: gadget\..*There is: stack, block, plugin, tool, skill, model/s);
});

test('facetsOf counts a set on its own, for a caller that already filtered', () => {
  assert.equal(facetsOf([]).tool, 0);
  assert.equal(facetsOf([entry('tool', 'a'), entry('tool', 'b')]).tool, 2);
});
