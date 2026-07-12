// Pipeline orchestrator. Hardcoded linear MVP sequence:
//   prompt -> planning -> [human approval] -> routing -> execution (sequential) -> verification -> done
// The orchestrator only sequences stages and moves the stage pointer in
// meta.json; all real work happens in the node modules, and all data flows
// through the RunStore files. Extension point: replace this with a graph
// walker over an editable workflow definition.
import { runPlanner } from './nodes/planner.js';
import { runRouter } from './nodes/router.js';
import { runExecutorTask } from './nodes/executor.js';
import { runVerifier } from './nodes/verifier.js';

export class Pipeline {
  constructor(store, config, onUpdate = () => {}) {
    this.store = store;
    this.config = config;
    this.onUpdate = onUpdate; // called with runId after every state change (UI refresh)
  }

  notify(runId) { this.onUpdate(runId); }

  async start(prompt) {
    const runId = this.store.createRun(prompt);
    this.notify(runId);
    // Fire and forget — errors land in meta.json, never throw to caller.
    this.runUntilCheckpoint(runId).catch(err => this.fail(runId, err));
    return runId;
  }

  // Phase 1: plan, then stop at the human-in-the-loop checkpoint.
  async runUntilCheckpoint(runId) {
    this.store.setStage(runId, 'planning');
    this.notify(runId);
    await runPlanner(this.store, runId, this.config);
    this.store.setStage(runId, 'awaiting_approval');
    this.notify(runId);
    // Stops here. resume() is triggered by human approval via IPC.
  }

  approvePlan(runId) {
    const meta = this.store.readMeta(runId);
    if (meta.stage !== 'awaiting_approval') throw new Error(`Cannot approve in stage "${meta.stage}"`);
    this.store.appendLog(runId, { event: 'human_decision', decision: 'approved' });
    this.resume(runId).catch(err => this.fail(runId, err));
  }

  rejectPlan(runId, reason = '') {
    const meta = this.store.readMeta(runId);
    if (meta.stage !== 'awaiting_approval') throw new Error(`Cannot reject in stage "${meta.stage}"`);
    this.store.appendLog(runId, { event: 'human_decision', decision: 'rejected', reason });
    this.store.setStage(runId, 'rejected');
    this.notify(runId);
  }

  // Phase 2: routing -> sequential execution -> verification.
  async resume(runId) {
    this.store.setStage(runId, 'routing');
    this.notify(runId);
    await runRouter(this.store, runId, this.config);
    this.notify(runId);

    const tasks = this.store.readTasks(runId).tasks;
    this.store.setStage(runId, 'execution');
    for (const task of tasks) {
      this.store.setStage(runId, 'execution', { currentTaskId: task.id });
      this.notify(runId);
      const retro = await runExecutorTask(this.store, runId, task.id, this.config);
      this.notify(runId);
      if (retro.status === 'failed') {
        // Escalate: a failed task halts the MVP pipeline for human attention.
        this.store.setStage(runId, 'failed', { error: `Task ${task.id} failed: ${retro.problems.join('; ')}`, currentTaskId: null });
        this.notify(runId);
        return;
      }
    }

    this.store.setStage(runId, 'verification', { currentTaskId: null });
    this.notify(runId);
    const verifyRetro = await runVerifier(this.store, runId, this.config);
    this.store.setStage(runId, verifyRetro.status === 'success' ? 'done' : 'failed',
      verifyRetro.status === 'success' ? {} : { error: 'Verification failed: ' + verifyRetro.recommendation });
    this.notify(runId);
  }

  fail(runId, err) {
    this.store.appendLog(runId, { event: 'pipeline_error', error: String(err?.stack ?? err) });
    this.store.setStage(runId, 'failed', { error: String(err?.message ?? err) });
    this.notify(runId);
  }
}
