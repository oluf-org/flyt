// What Build's gallery shows, decided without a renderer.
//
// The same split the Library page makes between `librarySearch.js` and
// `Library.jsx`: ordering, filtering and the words on a date are answers a test
// can hold without mounting React, and the component is then only arrangement.

/** "3 days ago", or nothing at all rather than a fabricated date. */
export function changedLabel(iso, now = Date.now()) {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString();
}

/**
 * The rows a query keeps, most recently edited first.
 *
 * Modes are searchable text: the thing somebody remembers is often the mode
 * rather than the workflow around it, and "high" should find Pipeline.
 */
export function galleryRows(stacks = [], query = '') {
  const needle = String(query ?? '').trim().toLowerCase();
  const matches = (stacks ?? []).filter(row => {
    if (!needle) return true;
    const haystack = [row.id, row.name, row.description,
      ...(row.presets ?? []).flatMap(preset => [preset.id, preset.name, preset.description])]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(needle);
  });
  return [...matches].sort((a, b) => {
    const left = Date.parse(a.updatedAt ?? '') || 0;
    const right = Date.parse(b.updatedAt ?? '') || 0;
    if (left !== right) return right - left;
    return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id));
  });
}
