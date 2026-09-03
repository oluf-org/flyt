// A shell result that never ran is a failure for progress accounting even
// though the tool completed without throwing (BLOCKS.md, D86).
import test from 'node:test';
import assert from 'node:assert/strict';
import { refusedResult } from '../core/tools/index.js';

test('refused and unconfinable shell results carry their reason as an error', () => {
  assert.equal(refusedResult({ command: 'ls', exitCode: null, errorCode: 'SANDBOX_UNAVAILABLE', stdout: '', stderr: 'Confined command tools are unavailable for this Windows sign-in.' }),
    'SANDBOX_UNAVAILABLE: Confined command tools are unavailable for this Windows sign-in.');
  assert.equal(refusedResult({ command: 'ls', exitCode: null, errorCode: 'SANDBOX_DENIED', refused: 'sandbox escalation refused', stderr: 'must request a strictly wider mode.' }),
    'sandbox escalation refused');
  assert.equal(refusedResult({ command: 'npm test', exitCode: 1, stdout: '', stderr: '1 failing' }), null,
    'a command that ran and failed its own check is still a command that ran');
  assert.equal(refusedResult({ path: 'a.txt', content: 'x' }), null);
  assert.equal(refusedResult('text'), null);
  assert.equal(refusedResult(null), null);
});
