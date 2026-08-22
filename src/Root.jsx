// Which shell the window mounts (t-0073, D62).
//
// One flag decides, and it is read in exactly one place. `App.jsx` is not
// touched at all: with the flag off this renders it, unchanged, which is the
// strongest form of "the old surfaces still work" — there is no branch inside
// it that could drift.
//
// The v2 tree is reached through a LAZY import, and that is the renderer's
// version of the rule `core/v2.js` keeps main-side. A static import would
// evaluate `Shell.jsx` and everything under it on every startup, flag or no
// flag, and "behind a flag" would mean "rendered conditionally" rather than
// "not loaded". A test asserts there is no static one.
import React, { Suspense, lazy, useEffect, useState } from 'react';
import App from './App.jsx';

const V2Shell = lazy(() => import('./v2/Shell.jsx'));

/**
 * @param flag — the flag, when the caller already knows it (a test, or a host
 *   that resolved it elsewhere). Omitted, it is read from settings, where the
 *   main process has already resolved call > environment > settings > default.
 */
export default function Root({ flag = null }) {
  // `null` is a third state and it matters: until settings answer we do not
  // know which shell to mount, and mounting v1 for that instant would tear the
  // whole app down and rebuild it when the answer arrived.
  const [v2, setV2] = useState(flag);

  useEffect(() => {
    if (flag !== null) return undefined;
    let live = true;
    window.flyt?.getSettings?.()
      .then(s => { if (live) setV2(Boolean(s?.v2)); })
      // A settings read that fails is not permission to turn a rebuild on.
      .catch(() => { if (live) setV2(false); });
    return () => { live = false; };
  }, [flag]);

  if (v2 === null) return null;
  if (!v2) return <App />;
  return (
    <Suspense fallback={null}>
      <V2Root />
    </Suspense>
  );
}

/**
 * The v2 shell, with whatever the host gives Build to edit.
 *
 * Separate from `Root` so the `buildSurface` import is inside the lazy chunk:
 * importing it at the top of this file would pull a v2 module into the startup
 * bundle, which is the thing the flag exists to prevent.
 */
function V2Root() {
  const [build, setBuild] = useState(null);
  // Every settled command, counted. The HOST owns "the stack changed" — the
  // editor renders what it is given, and a component that had to re-read a
  // mutable surface behind React's back would be a second source of truth for
  // the tree.
  //
  // Found by driving an agent edit in a browser: the node lit up and did not
  // move. The animation came from `commands/invoke`, which the editor hears;
  // the geometry came from a `stack` prop captured on the render before, which
  // nothing had told anybody to take again.
  const [edits, setEdits] = useState(0);

  useEffect(() => {
    let live = true;
    import('./v2/buildSurface.js')
      .then(m => m.buildSurface())
      .then(surface => { if (live) setBuild(surface); })
      .catch(() => { if (live) setBuild(null); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!build?.commands?.subscribe) return undefined;
    return build.commands.subscribe(() => setEdits(n => n + 1));
  }, [build]);

  // Read through on every edit. `stack` may be a live view of a tree the
  // command surface owns, so taking it again is the point rather than an
  // accident of rendering.
  const view = build ? { ...build, stack: build.stack, edits } : null;
  return <V2Shell build={view} />;
}
