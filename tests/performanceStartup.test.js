import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateDaily } from '../src/v2/dailyStartup.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('slow or failed recents do not delay project/settings/workflow readiness', async () => {
  let finishRecents;
  const events = [];
  const cancel = hydrateDaily({ listProjects: async () => ({ active: 'p' }), listWorkflows: async () => ['flow'], getSettings: async () => ({}), projectRecents: () => new Promise(resolve => { finishRecents = resolve; }) }, {
    onProjects: () => events.push('projects'), onWorkflows: () => events.push('workflows'), onSettings: () => events.push('settings'), onReady: () => events.push('ready'), onRecents: () => events.push('recents'), onSelection: () => events.push('selection'),
  });
  await tick();
  assert(events.includes('ready')); assert(events.includes('selection')); assert(!events.includes('recents'));
  cancel(); finishRecents([]); await tick(); assert(!events.includes('recents'));
});
test('an essential startup failure keeps launch unavailable without dropping successful resources', async () => {
  const events = [];
  hydrateDaily({ listProjects: async () => ({}), listWorkflows: async () => [], getSettings: async () => { throw new Error('settings failed'); }, projectRecents: async () => [] }, {
    onProjects: () => events.push('projects'), onReady: () => events.push('ready'), onError: (error, key) => events.push(`${key}:${error.message}`),
  });
  await tick();
  assert(events.includes('projects')); assert(events.includes('settings:settings failed')); assert(!events.includes('ready'));
});
