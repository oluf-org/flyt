import test from 'node:test';
import assert from 'node:assert/strict';

import { projectWindowChrome, STOCK_WINDOW_CHROME } from '../src/lib/projectChrome.js';

test('native chrome keeps the stock palette without an active project', () => {
  assert.deepEqual(projectWindowChrome('light'), STOCK_WINDOW_CHROME.light);
  assert.deepEqual(projectWindowChrome('dark', 'not-a-color'), STOCK_WINDOW_CHROME.dark);
});

test('native chrome follows the project family and current color scheme', () => {
  const redLight = projectWindowChrome('light', '#dc4a3a');
  const blueLight = projectWindowChrome('light', '#3e7fd4');
  const redDark = projectWindowChrome('dark', '#dc4a3a');
  assert.notEqual(redLight.color, blueLight.color);
  assert.notEqual(redLight.color, redDark.color);
  assert.equal(redLight.symbolColor, '#f3f3f3');
  assert.equal(redLight.height, 40);
  assert.match(redLight.color, /^#[0-9a-f]{6}$/);
});
