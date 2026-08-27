// The v2 shell (t-0073): Work and Build and Trace, behind the flag. The
// routing contract lives in src/v2/shellRouting.js as pure functions so it is
// testable without a browser; Shell.jsx is the thin renderer over them. These
// tests hold that renderer to the contract: two permanent destinations, one
// transient trace carried across navigation, and a location that says whether
// a run stays in view.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORK, BUILD, DESTINATIONS, INITIAL, navigate, heading, traceOf, state, adjacent,
} from '../src/v2/shellRouting.js';

test('Work and Build are the only permanent destinations', () => {
  assert.deepEqual(DESTINATIONS, [WORK, BUILD]);
  // Trace is not a peer: it is reached by a run address, never by picking it.
  assert.ok(!DESTINATIONS.includes('trace'));
});

test('the shell starts on Work, no run addressed', () => {
  assert.equal(INITIAL.dest, WORK);
  assert.equal(INITIAL.run, null);
  assert.equal(traceOf(INITIAL), null);
});

test('headings are the two permanent surfaces', () => {
  assert.equal(heading(WORK), 'Work');
  assert.equal(heading(BUILD), 'Build');
  assert.equal(heading('nonexistent'), null);
  assert.equal(heading('trace'), null);
});

test('Work and Build are reachable from each other in one hop', () => {
  assert.deepEqual(adjacent({ dest: WORK, run: null }), [BUILD]);
  assert.deepEqual(adjacent({ dest: BUILD, run: null }), [WORK]);
  // A run address is carried across either hop — that is the whole point of
  // it being a property of the location rather than of a destination.
  const watched = { dest: WORK, run: 'run-42' };
  assert.deepEqual(navigate(watched, BUILD), { dest: BUILD, run: 'run-42' });
  assert.equal(traceOf(navigate(watched, BUILD)).run, 'run-42');
});

test('a run addressed once stays addressed across navigation', () => {
  let loc = navigate(INITIAL, WORK);           // no run yet
  assert.equal(traceOf(loc), null);
  loc = { ...loc, run: 'run-7' };              // a run is addressed
  assert.deepEqual(traceOf(loc), { run: 'run-7' });
  const inBuild = navigate(loc, BUILD);        // walk across to Build
  assert.equal(state(inBuild).surface, 'build');
  assert.equal(state(inBuild).run, 'run-7');   // the run did not get lost
  const back = navigate(inBuild, WORK);
  assert.equal(state(back).surface, 'work');
  assert.equal(state(back).run, 'run-7');
});

test('state is a judgement-proof view of the location', () => {
  assert.deepEqual(state(INITIAL), { dest: WORK, run: null, trace: null, surface: 'work' });
  assert.deepEqual(state({ dest: BUILD, run: 'r' }),
    { dest: BUILD, run: 'r', trace: { run: 'r' }, surface: 'build' });
});
// --- the flag, which is the half a reviewer rejected the first attempt for ---
//
// The routing above is sound and none of it matters if nothing mounts it, and
// the first attempt at this task shipped exactly that: two well-tested modules
// under `src/v2/` that no code path could reach. `Root.jsx` is the one place
// that decides, and these hold it to the promise `core/v2.js` makes main-side.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = p => fs.readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8');

test('the window mounts the cutover Root and no renderer reads the retired flag', () => {
  assert.match(src('main.jsx'), /render\(<Root \/>\)/);
  const roots = fs.readdirSync(fileURLToPath(new URL('../src', import.meta.url)))
    .filter(f => f.endsWith('.jsx') || f.endsWith('.js'))
    .filter(f => f !== 'Root.jsx' && /getSettings\(\)[\s\S]{0,400}\.v2\b/.test(src(f)));
  assert.deepEqual(roots, [], 'a second reader of the flag is a second answer to it');
  assert.doesNotMatch(src('Root.jsx'), /getSettings|settings\.v2|<App/);
});



test('the shipping shell keeps a lazy startup boundary', () => {
  const dir = fileURLToPath(new URL('../src', import.meta.url));
  const offenders = [];
  const walk = d => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'v2') walk(full); continue; }
      if (!/\.jsx?$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      // A static `import … from './v2/…'` evaluates the module at startup
      // whatever the flag says. `lazy(() => import(...))` does not, which is
      // the renderer's version of the rule bootKernel keeps in the main process.
      for (const [line] of text.matchAll(/^import\s[^\n]*from\s+'[^']*\/?v2\/[^']*';$/gm)) {
        offenders.push(`${path.relative(dir, full)}: ${line.trim()}`);
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [],
    'behind a flag has to mean not loaded, not rendered conditionally');
  assert.match(src('Root.jsx'), /lazy\(\(\) => import\('\.\/v2\/Shell\.jsx'\)\)/);
});



test('an uncontrolled shell renders its own state, not the prop default', async () => {
  const { resolveLocation } = await import('../src/v2/shellRouting.js');
  const own = { dest: BUILD, run: null };
  assert.deepEqual(resolveLocation(null, own), own,
    'with no host driving it, its own state is what renders — otherwise every click is discarded');
  assert.deepEqual(resolveLocation({ dest: WORK, run: 'r' }, own), { dest: WORK, run: 'r' },
    'a host that is driving wins');
  assert.deepEqual(resolveLocation(null, null), INITIAL);
  // And the component asks the question rather than answering it inline, which
  // is what let the wrong answer live behind a full set of passing tests.
  assert.match(src('v2/Shell.jsx'), /location = null/,
    'defaulting the prop to INITIAL makes the fallback unreachable');
});

test('the host re-reads the stack when a command settles, so an edit redraws', () => {
  // Found by driving an agent edit in a browser: the node lit up and did not
  // move. The animation comes from `commands/invoke`, which the editor hears;
  // the geometry came from a `stack` prop captured on the render before, which
  // nothing had told anybody to take again. The host owns "the stack changed" —
  // an editor re-reading a mutable surface behind React's back would be a
  // second source of truth for the tree.
  const root = src('Root.jsx');
  assert.match(root, /commands\.subscribe\(\(\) => setEdits/,
    'something has to count the edits, or nothing re-renders');
  assert.match(root, /stack: build\.stack/,
    'and the stack is taken again on each of them, not held from the first render');
});
