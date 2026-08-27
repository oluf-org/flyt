// Workspace write tracking for concurrent tasks (V1 task 6, Q-D1 hazard 3).
//
// What this IS: detection. When several agentTasks run at once against one real
// workspace, two of them writing the same file is a genuine interference the
// user must be able to see. The ledger remembers which still-running task last
// wrote each path, so a second writer can be flagged to log.jsonl and into the
// tool record (and from there the retrospective + inspector).
//
// What this is NOT: isolation. Each individual write is already atomic — the
// file tools use synchronous whole-file writes, so bytes never interleave and a
// same-path collision is a clean last-writer-wins, not corruption. Preventing
// the collision outright (per-task worktrees + a merge step) is a much larger
// design decision and deliberately post-V1. `bash` can also write files and is
// invisible to this ledger.
//
// One ledger is created per parallel batch (see StackRunner.runPendingTasks) and
// passed down through the tool ctx, so `active` is exactly the set of tasks
// running concurrently — tasks in different waves are never in flight together
// and so can't conflict by definition. No module-global state.

const norm = p => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

export function createWriteLedger() {
  const active = new Set();        // task ids currently executing
  const writers = new Map();       // normalized path -> last task id to write it

  return {
    begin(taskId) { active.add(taskId); },
    end(taskId) { active.delete(taskId); },

    // Record a write and report interference: returns the id of a *still
    // running* other task that already wrote this path, else null.
    noteWrite(taskId, relPath) {
      const key = norm(relPath);
      const prev = writers.get(key);
      writers.set(key, taskId);
      return prev && prev !== taskId && active.has(prev) ? prev : null;
    }
  };
}
