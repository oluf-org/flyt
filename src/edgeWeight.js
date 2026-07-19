// How heavy an edge is drawn, from how much context actually flowed along it.
// Pure + string/number-only so it unit-tests without a DOM (bucket mapping is
// the one thing here worth pinning down).
//
// Buckets, not a linear scale: one giant upstream output would otherwise swamp
// the range and flatten every other edge to a hairline. The buckets:
//   • no measurement yet (authoring, or a run predating edge sizing) → 2px,
//     i.e. exactly the old uniform edge — nothing regresses.
//   • measured 0 → 1px: this edge carried ~nothing (a contextSpec node ignored
//     its upstream outputs and pulled only its declared files).
//   • then 2.5 / 4 / 6px as the payload grows.

export function edgeWidth(bytes) {
  if (bytes == null) return 2;      // unmeasured — the authoring default
  if (bytes <= 0) return 1;         // measured, but nothing flowed
  if (bytes < 1500) return 2.5;
  if (bytes < 6000) return 4;
  return 6;
}

// Only the "nothing flowed" hairline fades; every measured-payload edge (and the
// unmeasured default) stays full strength so the canvas reads the same as before.
export function edgeOpacity(bytes) {
  return edgeWidth(bytes) <= 1 ? 0.5 : 1;
}

// Human-readable size for the edge tooltip. null = unmeasured (no tooltip).
export function formatBytes(bytes) {
  if (bytes == null) return null;
  if (bytes <= 0) return 'no context carried';
  if (bytes < 1024) return `${bytes} B of context`;
  return `${(bytes / 1024).toFixed(1)} KB of context`;
}
