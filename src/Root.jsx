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
      <V2Shell />
    </Suspense>
  );
}
