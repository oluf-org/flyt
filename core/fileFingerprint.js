import fs from 'node:fs';

// A change detector for rebuildable display caches, never execution authority.
export function fileFingerprint(file) {
  try {
    const s = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
    return s ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : null;
  } catch { return null; }
}
