import fs from 'node:fs';

// Rebuildable display index. Watch events invalidate individual directories;
// discovery still runs on every request and a full sweep bounds missed events.
// Unsupported/failed watchers fall back to fingerprinting every row each time.
export class HistoryDirectoryIndex {
  rows = new Map();
  #dirty = new Set();
  #watcher = null;
  #all = true;
  #swept = 0;
  constructor(root, { watch = fs.watch, now = Date.now, sweepMs = 30000, platform = process.platform } = {}) {
    this.root = root; this.now = now; this.sweepMs = sweepMs;
    // macOS coalesces recursive watch notifications beyond an event-loop turn.
    // Scan fingerprints in the worker on each read so immediate external edits
    // are visible; unchanged session and summary bodies remain cached.
    if (platform === 'darwin') return;
    try {
      this.#watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) { this.#all = true; return; }
        const id = String(filename).split(/[\\/]/)[0];
        if (id && id !== '.' && id !== '..') this.#dirty.add(id);
        else this.#all = true;
        if (this.#dirty.size > 10000) { this.#dirty.clear(); this.#all = true; }
      });
      this.#watcher.on('error', () => { this.#watcher?.close(); this.#watcher = null; this.#all = true; });
      this.#watcher.unref();
    } catch { /* Full sweeps are the portable fallback. */ }
  }
  async changes() {
    // Drain pending filesystem notifications before serving a display read.
    await new Promise(resolve => setImmediate(resolve));
    const ids = fs.existsSync(this.root) ? fs.readdirSync(this.root) : [];
    const present = new Set(ids);
    for (const id of this.rows.keys()) if (!present.has(id)) this.rows.delete(id);
    const full = this.#all || !this.#watcher || this.now() - this.#swept >= this.sweepMs;
    const changed = ids.filter(id => full || this.#dirty.has(id) || !this.rows.has(id)
      || this.rows.get(id).hasOwner || this.rows.get(id).inspection?.terminal === false);
    this.#dirty.clear(); this.#all = false;
    if (full) this.#swept = this.now();
    return changed;
  }
  close() { this.#watcher?.close(); this.#watcher = null; this.rows.clear(); }
}
