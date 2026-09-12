import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
const origin = process.argv[2];
if (!origin || new URL(origin).protocol !== 'https:') throw new Error('Supply an HTTPS service origin');
async function check() {
  const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(15000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  for (const channel of ['stable', 'beta']) {
    const response = await fetch(`${origin}/v1/releases/${channel}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.channel, channel);
    assert.equal(data.platforms.length, 3);
  }
  const write = await fetch(`${origin}/v1/releases/stable`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(15000) });
  assert.equal(write.status, 405);
}
for (let attempt = 0; ; attempt++) {
  try { await check(); break; }
  catch (err) { if (attempt >= 11) throw err; console.log(`Waiting for endpoint readiness (${attempt + 1}/12)`); await setTimeout(5000); }
}
console.log(`Verified ${origin}: health, catalogs, cache policy, write rejection`);
