// The v2 shell (t-0073): Work and Build and Trace, behind the flag. The
// routing contract lives in src/v2/shellRouting.js as pure functions so it is
// testable without a browser; Shell.jsx is the thin renderer over them. These
// tests hold that renderer to the contract: two permanent destinations, one
// transient trace carried across navigation, and a location that says whether
// a run stays in view.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORK, BUILD, LIBRARY, MODELS, HISTORY, DESTINATIONS, INITIAL, navigate, heading, hint, traceOf, state,
  adjacent,
} from '../src/v2/shellRouting.js';

test('Work, Build, Library, Models and History are permanent destinations', () => {
  assert.deepEqual(DESTINATIONS, [WORK, BUILD, LIBRARY, MODELS, HISTORY]);
  // Trace is not a peer: it is reached by a run address, never by picking it.
  assert.ok(!DESTINATIONS.includes('trace'));
  // The order is the rail's order, and the rail's sliding pill is positioned
  // from the index — so reordering this list moves the highlight off the
  // button it is meant to be under.
  assert.equal(DESTINATIONS.indexOf(LIBRARY), 2);
});

test('the shell starts on Work, no run addressed', () => {
  assert.equal(INITIAL.dest, WORK);
  assert.equal(INITIAL.run, null);
  assert.equal(traceOf(INITIAL), null);
});

test('headings name every permanent surface, and only those', () => {
  assert.equal(heading(WORK), 'Work');
  assert.equal(heading(BUILD), 'Build');
  assert.equal(heading(LIBRARY), 'Library');
  assert.equal(heading(MODELS), 'Models');
  assert.equal(heading(HISTORY), 'History');
  assert.equal(heading('nonexistent'), null);
  assert.equal(heading('trace'), null);
  // The rail is icons and one-word labels; the hint is the only
  // place a destination gets to say what it is FOR.
  for (const dest of DESTINATIONS) assert.match(hint(dest), /^\w+ —/);
  assert.equal(hint('trace'), null);
});

test('every destination is reachable from every other in one hop', () => {
  assert.deepEqual(adjacent({ dest: WORK, run: null }), [BUILD, LIBRARY, MODELS, HISTORY]);
  assert.deepEqual(adjacent({ dest: BUILD, run: null }), [WORK, LIBRARY, MODELS, HISTORY]);
  assert.deepEqual(adjacent({ dest: LIBRARY, run: null }), [WORK, BUILD, MODELS, HISTORY]);
  // A run address is carried across either hop — that is the whole point of
  // it being a property of the location rather than of a destination.
  const watched = { dest: WORK, run: 'run-42' };
  assert.deepEqual(navigate(watched, BUILD), { dest: BUILD, run: 'run-42', workflow: null });
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
  assert.deepEqual(state(INITIAL),
    { dest: WORK, run: null, workflow: null, trace: null, surface: 'work', builder: 'gallery' });
  assert.deepEqual(state({ dest: BUILD, run: 'r' }),
    { dest: BUILD, run: 'r', workflow: null, trace: { run: 'r' }, surface: 'build', builder: 'gallery' });
  assert.deepEqual(state({ dest: LIBRARY, run: null }),
    { dest: LIBRARY, run: null, workflow: null, trace: null, surface: 'library', builder: 'gallery' });
  assert.deepEqual(state({ dest: MODELS, run: null }),
    { dest: MODELS, run: null, workflow: null, trace: null, surface: 'models', builder: 'gallery' });
  assert.deepEqual(state({ dest: HISTORY, run: null }),
    { dest: HISTORY, run: null, workflow: null, trace: null, surface: 'history', builder: 'gallery' });
  // Build with a workflow addressed is the editor for it; with none, the
  // gallery. One question, one answer, so the rail and the back button cannot
  // disagree about which view Build is showing.
  assert.equal(state({ dest: BUILD, workflow: 'pipeline' }).builder, 'editor');
  // A destination nothing knows falls back to Work rather than styling the
  // panel for a surface that has no stylesheet.
  assert.equal(state({ dest: 'nonexistent' }).surface, 'work');
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
  assert.match(src('main.jsx'), /render\(<RendererBoundary><Root \/><\/RendererBoundary>\)/,
    'the cutover Root remains mounted inside the renderer crash boundary');
  const roots = fs.readdirSync(fileURLToPath(new URL('../src', import.meta.url)))
    .filter(f => f.endsWith('.jsx') || f.endsWith('.js'))
    .filter(f => f !== 'Root.jsx' && /getSettings\(\)[\s\S]{0,400}\.v2\b/.test(src(f)));
  assert.deepEqual(roots, [], 'a second reader of the flag is a second answer to it');
  assert.doesNotMatch(src('Root.jsx'), /getSettings|settings\.v2|<App/);
  assert.match(src('Root.jsx'), /lazy\(\(\) => import\('\.\/v2\/DailyRoot\.jsx'\)\)/);
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
  assert.match(src('Root.jsx'), /lazy\(\(\) => import\('\.\/v2\/DailyRoot\.jsx'\)\)/);
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
  const root = src('v2/DailyRoot.jsx');
  assert.match(root, /setEdits\(n => n \+ 1\)/,
    'something has to count the edits, or nothing re-renders');
  assert.match(root, /stack: build\.stack/,
    'and the stack is taken again on each of them, not held from the first render');
});

test('the daily host wires the surviving entry controls into the v2 shell', () => {
  const host = src('v2/DailyRoot.jsx');
  const shell = src('v2/Shell.jsx');
  assert.match(host, /<TabStrip/);
  assert.match(host, /<Lander/);
  assert.match(host, /<ModelsPage/);
  assert.match(host, /runWorkflow/);
  assert.match(host, /ModelMetaProvider/);
  assert.match(host, /modelOverrides/);
  assert.match(host, /workflowModelSelection/);
  assert.match(host, /workflowModelTiers/);
  assert.doesNotMatch(host, /launchDailyPrompt/);
  assert.match(host, /subscribeDailyRun/);
  assert.match(host, /restartBlock\(projectId, runId, blockId/);
  assert.match(host, /revealRunLog/);
  assert.match(shell, /composer=\{composer\}/);
  assert.match(shell, /loc\.dest === MODELS/);
  assert.doesNotMatch(host, /FlowCanvas|NodesPage|settings\.v2/);
});

test('Build exposes organized library groups, resize separators, and explicit drop slots', () => {
  const editor = src('v2/BlockEditor.jsx');
  const editorCss = src('v2/blockEditorStyles.css');
  const library = src('v2/Library.jsx');
  assert.match(editor, /role="separator"/);
  assert.match(editor, /aria-valuenow=\{value\}/);
  assert.match(editor, /className=\{`be-drop-zone/);
  assert.match(editorCss, /\.be-stack\.is-dragging \.be-drop-zone/);
  assert.match(editorCss, /\.be-container\.kind-parallel > header strong \{ color: var\(--accent\); \}/);
  assert.doesNotMatch(editorCss, /#8b5cf6/, 'the Builder does not introduce a separate purple control color');
  assert.match(library, /className="lib-group"/);
  assert.match(library, /KIND_LABEL/);
});
test('Work receives the manual stop path required by soft worker limits', () => {
  const shell = src('v2/Shell.jsx');
  const root = src('v2/DailyRoot.jsx');
  assert.match(shell, /onStopRun=\{onStopRun\}/);
  assert.match(root, /window\.flyt\.stopRun\(projectId, runId\)/);
  assert.match(root, /window\.flyt\.pauseRun\(projectId, runId\)/);
  assert.match(root, /window\.flyt\.resumeRun\(projectId, runId\)/);
});
