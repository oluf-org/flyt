// The prompt host loads first; secondary destinations have their own boundaries.
// The retired renderer is not behind this boundary; DailyRoot composes the
// surviving v1 entry controls around the canonical v2 surfaces.
import React, { Suspense, lazy } from 'react';

const DailyRoot = lazy(() => import('./v2/DailyRoot.jsx'));

export default function Root() {
  return (
    <Suspense fallback={<main role="status" className="daily-loading">Opening Flyt…</main>}>
      <DailyRoot />
    </Suspense>
  );
}
