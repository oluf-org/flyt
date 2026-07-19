// Slug derivation for the projectless lander's auto-created projects (L5/Q-L4).
// Deterministic, instant, always non-empty, and deduped with a numeric suffix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { slugFromPrompt, dedupeSlug } from '../core/projectName.js';

test('projectName: drops stop words, keeps the imperative verb', () => {
  assert.equal(slugFromPrompt('Fix the auth flow'), 'fix-auth-flow');
  assert.equal(slugFromPrompt('Add a dark mode toggle'), 'add-dark-mode-toggle');
  assert.equal(slugFromPrompt('Build a snake game in Python'), 'build-snake-game-python');
});

test('projectName: lowercases, strips punctuation, caps word count', () => {
  assert.equal(slugFromPrompt('Refactor the Parser, Renderer, and Store modules today'),
    'refactor-parser-renderer-store');
  assert.equal(slugFromPrompt('WRITE tests!!!'), 'write-tests');
});

test('projectName: uses only the first line', () => {
  assert.equal(slugFromPrompt('Fix login\nand also logout'), 'fix-login');
});

test('projectName: is deterministic', () => {
  assert.equal(slugFromPrompt('Add search'), slugFromPrompt('Add search'));
});

test('projectName: never empty — falls back for stop-word-only or blank input', () => {
  assert.equal(slugFromPrompt('the a of to'), 'the-a-of-to'); // all stop words → keep raw
  assert.equal(slugFromPrompt(''), 'project');
  assert.equal(slugFromPrompt('   \n  '), 'project');
  assert.equal(slugFromPrompt('!!!@#$'), 'project');
});

test('projectName: caps overall length', () => {
  const slug = slugFromPrompt('supercalifragilisticexpialidocious antidisestablishmentarianism now');
  assert.ok(slug.length <= 40);
  assert.ok(!slug.endsWith('-'));
});

test('projectName: dedupeSlug appends a numeric suffix', () => {
  assert.equal(dedupeSlug('fix-auth', new Set()), 'fix-auth');
  assert.equal(dedupeSlug('fix-auth', new Set(['fix-auth'])), 'fix-auth-2');
  assert.equal(dedupeSlug('fix-auth', new Set(['fix-auth', 'fix-auth-2'])), 'fix-auth-3');
  assert.equal(dedupeSlug('scratch', ['scratch', 'scratch-2']), 'scratch-3');
});
