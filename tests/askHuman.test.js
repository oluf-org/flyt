// ask_human end to end (TOOLS-PLAN P4/§14.5): an agent mid-task asks the
// person running the flow, the run parks at the SAME awaiting_input gate the
// refiner uses, the composer's answer resumes it, and the answer survives a
// restart as a file.
//
// The restart story is deliberately not "keep the promise alive": a crash
// takes the call stack with it, as it always has. What survives is the ANSWER,
// so the re-run recalls it instead of asking the user the same thing twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner } from '../core/flowRunner.js';
import { executeTool } from '../core/tools/index.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

const toolBlock = (tool, args) => '```tool\n' + JSON.stringify({ tool, args }) + '\n```';

// input -> work(agentTask) -> output, with ask_human granted.
function askFlow() {
  return makeFlow(
    [
      node('input', 'input', {}),
      node('work', 'agentTask', {
        title: 'Do the thing', goal: 'Build it.',
        tools: ['ask_human', 'write_task_md'],
        worker: { provider: 'script', model: 'test-model' }
      }),
      node('output', 'output', {})
    ],
    [edge('input', 'work'), edge('work', 'output')]
  );
}

test('an agent asks mid-task: the run parks at awaiting_input and the answer reaches the model', async () => {
  const store = makeStore();
  let sawAnswer = null;
  setScript(({ prompt }) => {
    if (!prompt.includes('TOOL RESULT')) {
      return toolBlock('ask_human', { question: 'Which database?', options: ['Postgres', 'SQLite'] });
    }
    sawAnswer = prompt;
    return '## Done\nUsed the database they picked.';
  });

  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(askFlow(), { userInput: 'build it' });

  await waitForStage(store, runId, 'awaiting_input');
  const meta = store.readMeta(runId);
  // Same gate as the refiner's, told apart by kind so the composer can word it
  // as a question from a running agent.
  assert.equal(meta.pendingGateKind, 'tool');
  assert.equal(meta.pendingAsk.question, 'Which database?');
  assert.deepEqual(meta.pendingAsk.options, ['Postgres', 'SQLite']);
  assert.ok(store.readLog(runId).some(e => e.event === 'ask_human'));

  runner.answerInput(runId, 'Postgres, please.');
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'done');
  assert.match(sawAnswer, /Postgres, please\./, 'the answer came back as the tool result');
  assert.ok(store.readLog(runId).some(e => e.event === 'ask_human_answered'));
  // The gate is cleared, not left dangling.
  const done = store.readMeta(runId);
  assert.equal(done.pendingGateKind ?? null, null);
  assert.equal(done.pendingAsk ?? null, null);
});

test('the answer is a file, so a task re-run after a restart recalls it instead of asking again', async () => {
  const store = makeStore();
  const runId = store.createRun('restart');
  const ctx = { store, runId, taskId: 'task-1' };

  // First life of the process: the user answers.
  let asked = 0;
  ctx.askHuman = () => { asked += 1; return Promise.resolve('Postgres'); };
  const first = await executeTool('ask_human', { question: 'Which database?' }, ctx);
  assert.equal(first.result.answer, 'Postgres');
  assert.equal(asked, 1);

  // The app dies. A NEW store over the same directory is what a relaunch sees,
  // and the task is rewound to pending, so the tool call happens again.
  const relaunched = makeStore(store.rootDir);
  const afterRestart = { store: relaunched, runId, taskId: 'task-1', askHuman: () => { asked += 1; return Promise.resolve('SQLite'); } };
  const second = await executeTool('ask_human', { question: 'Which database?' }, afterRestart);

  assert.equal(second.result.recalled, true);
  assert.equal(second.result.answer, 'Postgres', 'what the user actually said survives the restart');
  assert.equal(asked, 1, 'the user is not asked the same question twice');
});

test('stopping a run while it waits for an answer fails the call honestly', async () => {
  const store = makeStore();
  setScript(() => toolBlock('ask_human', { question: 'Are you there?' }));
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(askFlow(), { userInput: 'build it' });

  await waitForStage(store, runId, 'awaiting_input');
  runner.stop(runId);
  await waitForStage(store, runId, ['cancelled', 'failed', 'done']);
  assert.equal(store.readMeta(runId).stage, 'cancelled');
  // No answer was invented on the user's behalf.
  assert.deepEqual(store.readAskAnswers(runId, 'task-1'), []);
});
