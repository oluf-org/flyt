// The same call, failing the same way, again (core/agent.js).
//
// Tool errors here are written to be acted on: `edit_file` says which anchor
// missed and names the closest line it did find. A model that cannot use that
// sends the identical call back, gets the identical error, and does it again.
// Nothing in the loop noticed, and the round budget went on it — t-0087 made
// byte-identical `edit_file` calls three times against one file and ran out of
// rounds before writing anything.
//
// The CRLF failure before it had the same shape, and the difference is worth
// keeping in mind: there the tool was WRONG and the model was right to be
// confused. Here the tool was right and unheard. The loop cannot tell those
// apart, which is exactly why it should say the repetition is happening rather
// than decide who is at fault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatedToolFailure } from '../core/agent.js';

const fail = (tool, error) => ({ tool, ok: false, error });
const ok = tool => ({ tool, ok: true, result: {} });

test('the first failure is information, and says nothing extra', () => {
  assert.equal(repeatedToolFailure([], fail('edit_file', '`old` was not found')), null);
});

test('the second identical failure says the retry will not work, and what to do instead', () => {
  const prior = [fail('edit_file', '`old` was not found')];
  const said = repeatedToolFailure(prior, fail('edit_file', '`old` was not found'));

  assert.match(said, /exact `edit_file` call twice/);
  assert.match(said, /Sending it again will fail again/);
  assert.match(said, /re-read the file|different\s+anchor/,
    'a nudge with no instruction is just a complaint');
});

test('the third says stop, and names the cost of not stopping', () => {
  const prior = [fail('edit_file', 'x'), fail('edit_file', 'x')];
  const said = repeatedToolFailure(prior, fail('edit_file', 'x'));

  assert.match(said, /^STOP\./);
  assert.match(said, /3 times/);
  assert.match(said, /blocked/, 'saying you are stuck has to be an offered option');
  assert.match(said, /rounds you need for the actual work/);
});

test('a different error from the same tool is progress, not repetition', () => {
  // The model changed something and got a new answer. That is the loop working.
  const prior = [fail('edit_file', '`old` was not found')];
  assert.equal(repeatedToolFailure(prior, fail('edit_file', 'File not found in the workspace')), null);
});

test('the same error from a different tool is not repetition either', () => {
  const prior = [fail('read_file', 'not found')];
  assert.equal(repeatedToolFailure(prior, fail('edit_file', 'not found')), null);
});

test('a success is never nudged, however many failures came before it', () => {
  const prior = [fail('edit_file', 'x'), fail('edit_file', 'x'), fail('edit_file', 'x')];
  assert.equal(repeatedToolFailure(prior, ok('edit_file')), null);
});

test('failures that succeeded in between still count: the model went back to it', () => {
  // Trying something else and then returning to the call that does not work is
  // the same loop, spread out. Counting only consecutive failures would miss it.
  const prior = [fail('edit_file', 'x'), ok('read_file'), fail('edit_file', 'x')];
  const said = repeatedToolFailure(prior, fail('edit_file', 'x'));
  assert.match(said, /^STOP\./);
});

test('nothing is said about a record that is not a failure at all', () => {
  assert.equal(repeatedToolFailure([], null), null);
  assert.equal(repeatedToolFailure([], {}), null);
  assert.equal(repeatedToolFailure([], { ok: true }), null);
});
