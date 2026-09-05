import test from 'node:test';
import assert from 'node:assert/strict';

import { projectWindowChrome, STOCK_WINDOW_CHROME } from '../src/lib/projectChrome.js';

test('native chrome keeps the stock palette without an active project', () => {
  assert.deepEqual(projectWindowChrome('light'), STOCK_WINDOW_CHROME.light);
  assert.deepEqual(projectWindowChrome('dark', 'not-a-color'), STOCK_WINDOW_CHROME.dark);
});

test('project identity never recolors native chrome', () => {
  assert.deepEqual(projectWindowChrome('light', '#dc4a3a'), STOCK_WINDOW_CHROME.light);
  assert.deepEqual(projectWindowChrome('light', '#3e7fd4'), STOCK_WINDOW_CHROME.light);
  assert.deepEqual(projectWindowChrome('dark', '#dc4a3a'), STOCK_WINDOW_CHROME.dark);
});
