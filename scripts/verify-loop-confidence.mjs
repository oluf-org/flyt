// Real-provider acceptance exercises. Deliberately no mock provider or fake outputs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { serializeStack } from '../core/stackstore.js';
import { readSessionLogFile } from '#kernel';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, '.flyt', 'confidence-live');
const evidence = path.join(root, 'docs/reviews/loop-confidence');
fs.mkdirSync(base, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
const profile = path.join(base, 'profile'); fs.mkdirSync(profile, { recursive: true });
if (!fs.existsSync(path.join(profile, 'settings.json'))) {
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'flyt/settings.json'), 'utf8'));
  delete settings.projects; settings.mock = false;
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
}
delete process.env.FLYT_TEST_MOCK_PROVIDER;
const engine = createEngine({ projectRoot: root, dataRoot: path.join(base, 'data'), userDataDir: profile });
const api = createApi(engine);
const model = process.env.FLYT_VERIFY_MODEL || 'z-ai/glm-5.3-flash';
const collectOnly = process.argv.includes('--collect');
const resumeFailed = process.argv.includes('--resume');
const B = (id, use, instructions, config = {}) => ({ kind: 'block', id, use: `flyt-blocks-${use}`, title: id.replaceAll('-', ' '), config: { instructions, maxTokens: 6000, ...config },
  ...(use === 'core:plan-start' ? { outputs: [{ name: 'tasks', type: 'list' }] } : {}),
  ...(use === 'judgement:evaluation' ? { outputs: [{ name: 'success', type: 'boolean' }] } : {}),
});
const W = (id, file, instructions = '') => B(id, 'core:work', `${instructions} Write the complete useful deliverable to ${file}. Use file tools, not shell. Return only the Goal JSON envelope with candidate.text summarizing the actual result and naming ${file}; findings may hold short lessons.`, { effect: 'artifact', systemPrompt: 'Produce the requested document from the supplied evidence. Preserve facts, cite source files when applicable, and write only the requested output file. Do not build or execute project code.' });
const source = (id, children) => serializeStack({ id, name: id, root: { kind: 'sequence', id: 'root', children } });
const fileCheck = (file, value) => ({ type: 'file_contains', path: file, value });
const faqFacts = '# Support policy\nOffline notes app. Notes are stored on the device. There is no account and no cloud sync. Export creates a JSON backup; import replaces existing notes after confirmation. Uninstalling deletes local notes. Never promise recovery without an export.\n\n# Tickets\n1. How do I move to a new phone?\n2. I uninstalled and lost notes.\n3. Can I use the app offline?\n4. Why are notes not syncing?\n5. Does import merge notes?\n';
const cases = [
  { id: 'long-evidence', objective: 'Read all 18 local service maintenance records (service-01.md through service-18.md) and produce maintenance-priority.md: a table of every service and its recorded incident count, total incidents, top three priorities, and concrete actions. The records are fictional planning fixtures. Independently sum the counts; never infer unread records from their names. Include TOTAL_INCIDENTS=<computed sum> and TOP_PRIORITY=<service id>.',
    files: Object.fromEntries(Array.from({ length: 18 }, (_, i) => {
      const id = `service-${String(i + 1).padStart(2, '0')}`;
      const guidance = Array.from({ length: 45 }, (_, j) => `Operational check ${j + 1}: Preserve diagnostics before restarting ${id}. Verify the documented backup and restore procedure in a staging environment. Record ownership, expected recovery time, verification evidence and unresolved questions. A completed checklist is not proof of recovery; use recorded outcomes.`).join('\n');
      return [`${id}.md`, `# ${id} maintenance record\nOwner: Team ${i % 3 + 1}.\n${guidance}\n## Recorded outcomes\nINCIDENTS=${i + 1}\nAction: ${i % 2 ? 'rehearse rollback and restoration' : 'verify backup integrity and alert routing'}. These are observed counts, not estimates.\n`];
    })), output: 'maintenance-priority.md', checks: ['TOTAL_INCIDENTS=171', 'TOP_PRIORITY=service-18', 'service-01', 'service-17'], steps: [
      B('read-evidence', 'core:general-analysis', 'Read all 18 service records and extract the recorded outcomes near each file end. Work in batches of three file reads. Keep a running compact table of facts. Use read_tool_result or file offsets to recover any truncated result; do not repeat an entire large read. Return all 18 incident counts and the sum, plus priority actions.'),
      B('verify-priorities', 'judgement:compare', 'Check the supplied table has 18 distinct service IDs and recompute the sum. Compare priority candidates by recorded incidents; return the complete corrected table and top three actionable priorities.'),
      W('publish', 'maintenance-priority.md', 'Preserve every row and the computed TOTAL_INCIDENTS and TOP_PRIORITY markers. Do not reread all records if the complete evidence table is already supplied.'),
    ] },
  { id: 'support-faq', objective: 'Turn support-policy.md into a genuinely useful five-question customer FAQ. Cover migration, uninstall data loss, offline use, lack of sync, and replacement on import. State limitations honestly.', files: { 'support-policy.md': faqFacts }, output: 'faq.md', checks: ['offline', 'export', 'import'], steps: [
    B('orient', 'inquiry:orient', 'Read only support-policy.md; list the five customer questions and all policy facts. Do not broaden scope.'),
    B('analyze', 'core:general-analysis', 'Draft accurate answers to all five questions from the supplied policy. Carry all facts and answers downstream; identify dangerous recovery promises.'),
    B('combine', 'core:combine', 'Turn the supplied facts and answers into one concise FAQ. Preserve all five answers, especially data-loss limitations.'), W('publish', 'faq.md'),
  ] },
  { id: 'release-plan', objective: 'Create a feasible two-week release plan for the local notes app from release-brief.md. Include owners, dependencies, acceptance checks and the explicit cloud-sync exclusion.', files: { 'release-brief.md': '# Release brief\nTeam: Ada (Android), Ben (Dart), Cy (QA). Ten workdays. Priorities: fix import cancellation deleting notes (Ben, 2 days); add export progress (Ben, 2 days, after import fix); improve Android large-font layout (Ada, 3 days); regression test imports, exports and large fonts (Cy, 2 days, after implementation). Cloud sync is explicitly out of scope. Keep release day 10 free for rollback.\n' }, output: 'release-plan.md', checks: ['Ada', 'Ben', 'Cy', 'rollback'], steps: [
    B('plan', 'core:plan-start', 'Read release-brief.md. Return exactly three complete task objects, grouping Ben tasks, Ada task, Cy QA. Include owner, scope, dependencies, estimates and acceptance. No invented backlog IDs.'),
    { kind: 'foreach', id: 'detail-each', roster: 'plan.tasks', max: 3, children: [B('detail', 'core:general-analysis', 'Expand only this roster item into a concrete work package with owner, days, dependencies and acceptance. Preserve constraints in the item.')] },
    B('merge-plan', 'core:combine', 'Combine the three work packages into one dependency-aware day-by-day ten-day release plan. Preserve day 10 for rollback, no cloud sync.'), W('publish', 'release-plan.md'),
  ] },
  { id: 'storage-decision', objective: 'Recommend a storage option for a local mobile journal: 50000 entries, transactional imports, no backend, no cloud, one developer. Compare JSON files and SQLite using the facts below; favor correctness and low maintenance.', files: {}, output: 'storage-decision.md', checks: ['SQLite', 'JSON', 'transaction'], steps: [
    B('clarify', 'judgement:prompt-refiner', 'The requirements are complete. Produce a concise decision brief without questions or new requirements.'),
    { kind: 'parallel', id: 'options', maxParallel: 2, children: [B('json-option', 'core:general-analysis', 'Assess JSON file storage: whole-file rewrites, hand-built atomic replacement and recovery, simple exports. Address all requirements; return an evidence-based case under 350 words.'), B('sqlite-option', 'core:general-analysis', 'Assess SQLite: built-in transactions, indexes and migrations, local file, no backend. Address requirements and maintenance costs; under 350 words.')] },
    B('compare', 'judgement:compare', 'Compare both supplied options on transactional correctness, 50000-entry performance and maintenance. Make one explicit recommendation with tradeoffs and a migration/rollback outline.'), W('publish', 'storage-decision.md'),
  ] },
  { id: 'two-pass-runbook', objective: 'Create a safe import incident runbook from incident.md over two real iterations. In iteration 1 write runbook.md as a clearly labelled draft. In iteration 2 read and critically revise it, checking all facts and adding the heading Ready for review. Preserve user data; no destructive fixes.', files: { 'incident.md': '# Incident\nImport was interrupted; notes appear missing. Support must ask whether an exported JSON backup exists. First preserve a copy of current app data and diagnostic logs; never uninstall or clear storage. Work offline. Escalate to engineering if no verified backup exists. Restore only after explicit user confirmation, because import replaces notes. Verify record count and two sample notes. Do not claim a successful restore without verification.\n' }, output: 'runbook.md', checks: ['Ready for review', 'backup', 'confirmation'], setup: source('prepare-once', [B('read-incident', 'core:general-analysis', 'Read incident.md and return a compact factual source brief for the runbook. Do not write files.')]), steps: [
    B('draft-review', 'core:general-analysis', 'Read incident.md. If iteration 2 or later, also read runbook.md. Produce a complete runbook draft or corrected version, with numbered steps and explicit stop/escalation criteria. Follow the current iteration in the Goal context.'),
    B('critique', 'judgement:compare', 'Compare the supplied runbook against the fixed Goal objective and constraints. Return the full corrected runbook, not just criticisms. Preserve every safety condition. In iteration 1 label DRAFT; in iteration 2 include Ready for review.'), W('publish', 'runbook.md', 'Follow the current Goal iteration. Iteration 1 is DRAFT and must NOT contain Ready for review. Iteration 2 must review the existing file and include Ready for review.'),
  ] },
  { id: 'check-and-branch', objective: 'Write a concise data-import checklist for a local notes app. Must include backup, explicit confirmation, rollback and verification. Exercise a real evaluation and condition before publishing.', files: {}, output: 'checklist.md', checks: ['backup', 'confirmation', 'rollback', 'verification'], steps: [
    { kind: 'until', id: 'quality-loop', max: 3, condition: { source: 'evaluate.success', operator: 'is', literal: true }, children: [
      B('draft', 'core:general-analysis', 'Write a complete checklist with four labelled sections: backup, confirmation, rollback, verification. If supplied a prior critique, fix it. Include actionable steps. This step returns the checklist text, not a Goal envelope.'),
      B('evaluate', 'judgement:evaluation', 'Pass only if the supplied checklist includes actionable backup, confirmation, rollback and verification steps. In explanation include the full checklist so it survives the downstream handoff. Return the evaluation JSON required by this block.'),
    ] },
    { kind: 'if', id: 'publish-if-passed', predicate: { source: 'evaluate.success', operator: 'is', literal: true }, children: [W('publish', 'checklist.md', 'Extract and polish the complete checklist from the evaluation explanation. Preserve all four required sections in lowercase.')], else: [B('failure-note', 'core:general-analysis', 'Return a Goal envelope stating the checklist could not be verified; do not claim success.')] },
  ] },
  { id: 'migration-backlog', objective: 'Produce three actionable, independent backlog tasks for migrating a local settings file from version 1 to version 2, based only on migration.md. Include compatibility, testing, and rollback; no changes to application code.', files: { 'migration.md': '# Migration facts\nv1 stores theme as light/dark and fontSize as integer pixels. v2 stores appearance.theme with the same values and accessibility.fontScale as a decimal. Conversion is fontScale = fontSize / 16. Preserve unknown fields in legacyExtras. Write a backup before conversion, use atomic replacement, and leave v1 untouched if conversion fails. Need tests for 16 -> 1.0, 24 -> 1.5, corrupt JSON, unknown fields, and interrupted writes.\n' }, output: 'migration-tasks.md', checks: ['legacyExtras', 'rollback', '1.5'], steps: [
    B('research', 'core:research', 'Read only migration.md. Produce an accurate fact sheet of the data contract, conversion formula, examples and failure modes. This task needs no web research.'),
    B('backlog', 'loop:backlog-plan', 'Propose exactly three self-contained tasks covering conversion, atomic backup/rollback, and regression tests. Preserve the formula and examples. No queue side effects or invented task IDs; blastRadius may name future implementation/test files.'),
    B('split', 'core:split', 'Return the same three supplied tasks as three complete list items, keeping every important requirement. Do not fragment acceptance criteria into separate tasks.'), W('publish', 'migration-tasks.md', 'Present exactly three work-ready task cards with acceptance tests. Clearly label proposed paths as proposed, not existing.'),
  ] },
];
// A fresh regression instance for the iteration-boundary bug discovered by the
// first runbook trial. Keep its original evidence for comparison.
const runbook = cases.find(c => c.id === 'two-pass-runbook');
cases.push({ ...runbook, id: 'runbook-revision', steps: runbook.steps.map(step => ({ ...step, config: {
  ...step.config, maxTokens: 16384,
  instructions: `${step.config.instructions} Keep the complete runbook under 450 words. The Goal context iteration number is set by the controller: perform ONLY that iteration and return; never enact a future iteration yourself.`,
} })) });
const longEvidence = cases.find(c => c.id === 'long-evidence');
cases.push({ ...longEvidence, id: 'long-evidence-retest', minutes: 45,
  steps: longEvidence.steps.map(step => ({ ...step, config: { ...step.config, maxTokens: 16384 } })),
});
cases.push({ ...cases.find(c => c.id === 'runbook-revision'), id: 'runbook-completion', minutes: 45,
  setup: source('prepare-once', [B('read-incident', 'core:general-analysis', 'Read incident.md and return its factual constraints in under 150 words. Do not write files.', { maxTokens: 16384 })]),
});
const migration = cases.find(c => c.id === 'migration-backlog');
cases.push({ ...migration, id: 'migration-completion', minutes: 45,
  steps: migration.steps.map(step => ({ ...step, config: { ...step.config, maxTokens: 16384,
    instructions: `${step.config.instructions} Keep the complete result under 700 words. Do not repeat the original analysis; preserve the supplied facts and finish this block's handoff.`,
  } })),
});
let records = fs.existsSync(path.join(base, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(base, 'index.json'), 'utf8')) : [];
const save = () => fs.writeFileSync(path.join(base, 'index.json'), JSON.stringify(records, null, 2));
try {
  for (const c of cases) {
    if (collectOnly) break;
    if (records.some(r => r.id === c.id)) continue;
    const workspace = path.join(base, 'workspaces', c.id); fs.mkdirSync(workspace, { recursive: true });
    for (const [name, content] of Object.entries(c.files)) fs.writeFileSync(path.join(workspace, name), content);
    const p = await api.invoke('project:open', { folder: workspace });
    const definition = { name: `Confidence: ${c.id}`, objective: c.objective, constraints: 'Use only supplied/local facts. No project code execution. Do not invent source facts. Write only requested Markdown deliverables. The final recipe step returns exactly one Goal JSON envelope.', folder: workspace,
      recipe: source(c.id, c.steps), setup: c.setup ?? null, tools: ['read_file', 'glob', 'search_files', 'read_tool_result', 'create_file', 'write_file', 'edit_file'],
      criteria: c.checks.map(value => fileCheck(c.output, value)), limits: { iterations: 4, calls: 80, minutes: c.minutes ?? 15, usd: 2 }, maxParallel: 2, plateau: 3,
      worker: { provider: 'openrouter', model }, selfRedesign: false, reviewResults: false };
    const draft = await api.invoke('goal:author-open', { projectId: p.id, definition });
    const published = await api.invoke('goal:author-publish', { projectId: p.id, draftId: draft.id, baseRevision: draft.revision });
    records.push({ id: c.id, projectId: p.id, goalId: published.goalId, draftId: draft.id, output: c.output }); save();
    fs.writeFileSync(path.join(evidence, `${c.id}.stack.yaml`), definition.recipe);
  }
  const selected = process.argv.slice(2).filter(arg => !['--resume', '--collect'].includes(arg));
  const chosen = records.filter(r => !selected.length || selected.includes(r.id));
  const execute = async r => {
    await api.invoke('project:open', { folder: r.projectId });
    let state = await api.invoke('goal:get', { projectId: r.projectId, goalId: r.goalId });
    const resumable = ['failed', 'paused', 'stopped', 'interrupted'].includes(state.status);
    if (!collectOnly && (state.status === 'ready' || (resumeFailed && resumable))) {
      await api.invoke('goal:start', { projectId: r.projectId, goalId: r.goalId });
    }
    let last = '';
    do {
      state = await api.invoke('goal:get', { projectId: r.projectId, goalId: r.goalId });
      const key = `${state.status}:${state.calls}:${state.iteration}`;
      if (key !== last) { console.log(JSON.stringify({ case: r.id, status: state.status, calls: state.calls, iteration: state.iteration, reason: state.reason })); last = key; }
      if (state.live && !collectOnly) await new Promise(resolve => setTimeout(resolve, 3000));
    } while (state.live && !collectOnly);
    const runsDir = path.join(r.projectId, '.flyt/runs');
    const runs = fs.readdirSync(runsDir).filter(id => id.startsWith(`goal-${r.goalId}-`)).sort().map(runId => {
      const events = readSessionLogFile(path.join(runsDir, runId, 'session.jsonl')).events;
      return { runId, startedAt: events[0]?.at, endedAt: events.at(-1)?.at,
        blocks: events.filter(e => e.type === 'block.status').map(e => ({ blockId: e.data.blockId, executionId: e.data.executionId, status: e.data.status, use: e.data.use, error: e.data.error })),
        checkpoints: events.filter(e => e.type === 'context.checkpoint').length,
        toolCalls: events.filter(e => e.type === 'tool.call').length,
      };
    });
    const report = { ...r, status: state.status, reason: state.reason, iterations: state.iteration, calls: state.calls, knownUsd: state.knownUsd,
      unknownCostCalls: state.unknownCostCalls, elapsedMs: state.elapsedMs, history: state.history, outputRecovery: state.outputRecovery ?? null,
      runs, checkpoints: runs.reduce((n, run) => n + run.checkpoints, 0),
      result: state.current ? await api.invoke('goal:inspect', { projectId: r.projectId, goalId: r.goalId, record: state.current.artifact }) : null };
    fs.writeFileSync(path.join(evidence, `${r.id}.json`), JSON.stringify(report, null, 2));
    if (fs.existsSync(path.join(r.projectId, r.output))) fs.copyFileSync(path.join(r.projectId, r.output), path.join(evidence, `${r.id}.md`));
    return report;
  };
  for (let i = 0; i < chosen.length; i += 2) await Promise.all(chosen.slice(i, i + 2).map(execute));
} finally { await api.shutdown('Confidence verification finished'); engine.telemetry.close(); }
