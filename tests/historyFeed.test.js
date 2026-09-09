import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryFeed } from '../src/v2/historyFeed.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let activity, visibility, calls = 0;
  const requests = [], timers = new Map();
  const page = { hidden: false, addEventListener: (_name, fn) => { visibility = fn; }, removeEventListener: () => { visibility = null; } };
  const api = {
    chatHistory: () => { calls++; return new Promise((resolve, reject) => requests.push({ resolve, reject })); },
    onProjectActivity: fn => { activity = fn; return () => { activity = null; }; },
  };
  const feed = createHistoryFeed(api, 'project', {
    document: page, setTimeout: (fn, ms) => { timers.set(fn, ms); return fn; }, clearTimeout: id => timers.delete(id),
  });
  return { feed, page, requests, timers, calls: () => calls, activity: projectId => activity?.({ projectId }), visibility: () => visibility?.() };
}

test('consumers share a request and invalidation bursts get one trailing refresh', async () => {
  const h = harness();
  const a = h.feed.subscribe(() => {}), b = h.feed.subscribe(() => {});
  await settle(); assert.equal(h.calls(), 1);
  h.activity('other'); h.activity('project'); h.activity('project');
  assert.equal(h.calls(), 1);
  h.requests.shift().resolve([{ id: 'one' }]); await settle();
  assert.deepEqual([...h.timers.values()], [0]);
  const [next] = h.timers.keys(); await nextTick(next);
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.feed.getSnapshot().rows, [{ id: 'one' }]);
  h.requests.shift().resolve([{ id: 'two' }]); await settle();
  assert.deepEqual([...h.timers.values()], [5000]);
  a(); assert.equal(h.timers.size, 1);
  b(); assert.equal(h.timers.size, 0);
});
async function nextTick(fn) { fn(); await settle(); }

test('hidden pages pause reads and refresh when visible; errors retain rows', async () => {
  const h = harness(); h.page.hidden = true;
  const stop = h.feed.subscribe(() => {});
  await settle(); assert.equal(h.calls(), 0);
  h.page.hidden = false; h.visibility(); await settle();
  h.requests.shift().resolve([{ id: 'loaded' }]); await settle();
  h.page.hidden = true; h.visibility();
  assert.equal(h.timers.size, 0);
  h.activity('project'); await settle(); assert.equal(h.calls(), 1);
  h.page.hidden = false; h.visibility(); await settle();
  h.requests.shift().reject(new Error('offline')); await settle();
  assert.deepEqual(h.feed.getSnapshot(), { rows: [{ id: 'loaded' }], busy: false, error: 'offline' });
  stop();
});

test('unsubscribed and StrictMode-era requests cannot overwrite a new subscription', async () => {
  const h = harness(); const stop = h.feed.subscribe(() => {}); await settle(); stop();
  const stopAgain = h.feed.subscribe(() => {}); await settle();
  h.requests[1].resolve([{ id: 'new' }]); await settle();
  h.requests[0].resolve([{ id: 'stale' }]); await settle();
  assert.deepEqual(h.feed.getSnapshot().rows, [{ id: 'new' }]);
  stopAgain(); assert.equal(h.timers.size, 0);
});
