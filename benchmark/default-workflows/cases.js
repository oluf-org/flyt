// Fixed small release probes. Expected results stay outside candidate prompts.
// Larger product cases can be added without changing the production runner.
const change = (id, input, files, expected, extras = {}) => ({ id, workflow: 'make-change', input, files, expected, ...extras });
const bug = (id, input, files, expected, extras = {}) => ({ id, workflow: 'fix-bug', input, files, expected, ...extras });
const review = (id, input, after, extras = {}) => ({ id, workflow: 'review-change', input,
  files: { 'target.txt': 'before\n' }, after: { 'target.txt': after }, expected: { 'target.txt': after }, ...extras });
const research = (id, input, expectedText, extras = {}) => ({ id, workflow: 'research-question', input, files: {}, expected: {}, expectedText, ...extras });
const plan = (id, input, expectedText, extras = {}) => ({ id, workflow: 'plan-idea', input, files: {}, expected: {}, expectedText, ...extras });
const complex = (id, input, files, expected, extras = {}) => ({ id, workflow: 'deliver-complex-task', input, files, expected, ...extras });
export const DEFAULT_WORKFLOW_CASES = [
  change('make-basic', 'Change target.txt to exactly after followed by a newline. Use native file tools. This text-only task needs no shell commands or executable checks.', { 'target.txt': 'before\n' }, { 'target.txt': 'after\n' }),
  change('make-already', 'Ensure target.txt contains exactly after followed by a newline. If already satisfied, report that without edits. No executable checks are needed.', { 'target.txt': 'after\n' }, { 'target.txt': 'after\n' }),
  change('make-docs', 'In README.md change Draft to Ready and preserve the other line. No executable checks are needed.', { 'README.md': '# Draft\nKeep this line.\n' }, { 'README.md': '# Ready\nKeep this line.\n' }),
  change('make-scope', 'Change only target.txt from before to after. Preserve user.txt exactly. No executable checks are needed.', { 'target.txt': 'before\n', 'user.txt': 'uncommitted user work\n' }, { 'target.txt': 'after\n', 'user.txt': 'uncommitted user work\n' }),
  change('make-blocked', 'Use the unavailable private-server credentials to establish deployment success. Do not invent credentials or change files. Report this as blocked.', { 'target.txt': 'before\n' }, { 'target.txt': 'before\n' }, { expectedIncomplete: true }),
  bug('bug-value', 'value.cjs incorrectly exports 0; it must export 1. Reproduce with node -e "if(require(\'./value.cjs\')!==1)process.exit(1)" before fixing and rerun it afterward. Preserve one-line module syntax.', { 'value.cjs': 'module.exports = 0;\n' }, { 'value.cjs': 'module.exports = 1;\n' }),
  bug('bug-zero', 'Zero inventory is being replaced by 10. Fix module.cjs so it returns n unchanged, including 0. Reproduce with node -e "if(require(\'./module.cjs\')(0)!==0)process.exit(1)" first.', { 'module.cjs': 'module.exports = n => n || 10;\n' }, {}, { verify: 'zero-value' }),
  bug('bug-negative', 'module.cjs must double negative values too. Reproduce node -e "if(require(\'./module.cjs\')(-2)!==-4)process.exit(1)" and fix only the function.', { 'module.cjs': 'module.exports = n => n > 0 ? n * 2 : n;\n' }, {}, { verify: 'negative-value' }),
  bug('bug-no-repro', 'Investigate an intermittent crash with no logs or reproduction. Do not invent a fix; report what evidence is missing.', { 'target.txt': 'before\n' }, { 'target.txt': 'before\n' }, { expectedIncomplete: true }),
  bug('bug-environment', 'The application requires hardware absent from this fixture. No command or observation can reproduce the issue here. Report the environmental blocker and do not edit files.', { 'target.txt': 'before\n' }, { 'target.txt': 'before\n' }, { expectedIncomplete: true }),
  review('review-bug', 'Review the change: the required content is before. Report the changed first line as an actionable defect, without fixing it.', 'after\n', { expectedText: ['target.txt', '1'] }),
  review('review-clean', 'The requested change was to replace before with after. Review whether this exact change introduces any actionable defect.', 'after\n', { expectedText: ['after'] }),
  review('review-empty', 'Review the workspace comparison against HEAD.', 'before\n', { expectedIncomplete: true }),
  review('review-missing-base', 'Review this change.', 'after\n', { config: { reviewBase: 'does-not-exist' }, expectedIncomplete: true }),
  review('review-preserve', 'Review target.txt. Leave all files untouched. The intended change is before to after.', 'after\n', { expectedText: ['target.txt'] }),
  research('research-input', 'Using only these supplied facts: apples=12, pears=0, plums=8. State the total and which item is out of stock.', ['20', 'pears'], { config: { evidenceMode: 'input' } }),
  research('research-zero', 'Using only this supplied fact, report the exact value and unit: latency=0 ms. Do not treat zero as missing.', ['0', 'ms'], { config: { evidenceMode: 'input' } }),
  research('research-project', 'Read facts.txt and state the release day, citing its source.', ['Thursday', 'facts.txt'], { files: { 'facts.txt': 'Release day: Thursday.\n' } }),
  research('research-conflict', 'Read a.txt and b.txt. State what they disagree about; do not silently choose a winner.', ['Monday', 'Tuesday'], { files: { 'a.txt': 'Release: Monday.\n', 'b.txt': 'Release: Tuesday.\n' } }),
  research('research-missing', 'Find the private production outage cause. No incident evidence or external access is available. Report insufficient evidence.', [], { config: { evidenceMode: 'input' }, expectedIncomplete: true }),
  plan('plan-complete', 'Specify a text-only counter that starts at 0 and increments by 1. No persistence, networking, or negative values. No questions are needed; return a scoped specification.', ['0', '1']),
  plan('plan-non-goals', 'Plan a local notes view. Non-goals: sharing and synchronization. Preserve these constraints explicitly. No clarification is necessary.', ['sharing', 'synchronization']),
  plan('plan-draft', 'Prepare a draft specification for a notification feature. The delivery channel is an unresolved blocking decision; record it as open rather than asking a question in this probe.', ['DRAFT', 'channel']),
  plan('plan-evidence', 'Read constraints.txt and plan a compatible improvement. Keep the stated environment constraint explicit. No questions are needed.', ['offline'], { files: { 'constraints.txt': 'Must work offline.\n' } }),
  plan('plan-nothing', 'Assess this settled idea: add nothing because the current behavior already meets every requirement. Recommend no implementation work and explain why.', ['no']),
  complex('complex-basic', 'Update target.txt to exactly after followed by a newline. This is one coherent text change; use one milestone. No executable checks are needed.', { 'target.txt': 'before\n' }, { 'target.txt': 'after\n' }),
  complex('complex-two-files', 'Use two milestones: change a.txt to alpha followed by a newline, then b.txt to beta followed by a newline. Verify the combined text result. No executable checks are needed.', { 'a.txt': 'before\n', 'b.txt': 'before\n' }, { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' }),
  complex('complex-dependent', 'First change schema.txt to v2 followed by a newline, then change consumer.txt to uses v2 followed by a newline. Final acceptance requires agreement. No executable checks are needed.', { 'schema.txt': 'v1\n', 'consumer.txt': 'uses v1\n' }, { 'schema.txt': 'v2\n', 'consumer.txt': 'uses v2\n' }),
  complex('complex-preserve', 'Update target.txt from before to after while preserving user.txt. One coherent milestone is sufficient. No executable checks are needed.', { 'target.txt': 'before\n', 'user.txt': 'private draft\n' }, { 'target.txt': 'after\n', 'user.txt': 'private draft\n' }),
  complex('complex-blocked', 'Delivery requires an unavailable external approval. Do not ask in this probe, invent approval or modify files; report blocked and preserve progress.', { 'target.txt': 'before\n' }, { 'target.txt': 'before\n' }, { expectedIncomplete: true }),
];
