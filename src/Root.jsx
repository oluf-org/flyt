// The shipping shell after the Phase 5 cutover (D62). The old renderer has
// been retired, so a stale persisted `v2: false` cannot select a surface that
// no longer exists. The lazy boundary remains useful for startup chunking; it
// is no longer a feature-flag boundary.
import React, { Suspense, lazy, useEffect, useState } from 'react';

const V2Shell = lazy(() => import('./v2/Shell.jsx'));

export default function Root() {
  return (
    <Suspense fallback={null}>
      <V2Root />
    </Suspense>
  );
}

/**
 * The v2 shell, with whatever the host gives Build to edit.
 *
 * Separate from `Root` so the `buildSurface` import remains inside the lazy
 * startup chunk rather than pulling the editor bridge into the entry module.
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
  const [reviewRevision, setReviewRevision] = useState(0);
  const [uiExtensionRevision, setUiExtensionRevision] = useState(0);

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

  useEffect(() => {
    if (!build?.subscribePluginReview) return undefined;
    return build.subscribePluginReview(() => setReviewRevision(n => n + 1));
  }, [build]);

  useEffect(() => {
    if (!build?.subscribeUiExtensions) return undefined;
    return build.subscribeUiExtensions(() => setUiExtensionRevision(n => n + 1));
  }, [build]);

  // The run being watched, when the host has one. Trace is transient: it is
  // addressed by run rather than navigated to, so it arrives the same way the
  // stack does — from the host, not found by a component.
  const [watching, setWatching] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.resolve(window.flyt?.v2Watching?.())
      .then(w => { if (live) setWatching(w ?? null); })
      .catch(() => { if (live) setWatching(null); });
    return () => { live = false; };
  }, []);

  // Read through on every edit. `stack` may be a live view of a tree the
  // command surface owns, so taking it again is the point rather than an
  // accident of rendering.
  const view = build ? {
    ...build, stack: build.stack, edits, reviewRevision, uiExtensionRevision,
    pluginReview: build.pluginReview ?? null,
  } : null;
  return <V2Shell build={view} watching={watching} />;
}
