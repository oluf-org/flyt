// The shipping root stays a lazy boundary: the everyday host, the v2 editor,
// and the model catalog are one application chunk rather than startup work.
// The retired renderer is not behind this boundary; DailyRoot composes the
// surviving v1 entry controls around the canonical v2 surfaces.
import React, { Suspense, lazy } from 'react';

const DailyRoot = lazy(() => import('./v2/DailyRoot.jsx'));

export default function Root() {
  return (
    <Suspense fallback={null}>
      <DailyRoot />
    </Suspense>
  );
}
