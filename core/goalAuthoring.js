// Definition authoring has a separate read-only tool surface. Grants and review history
// live in application data, independently of the executable Goal workspace.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serializeStack } from './stackstore.js';
import { parseGoalReply, validateGoalTools } from './goalController.js';
import { AUTHORING_SYSTEM, authoringCapabilities, conversationContext, selectProjectFiles, readSelectedFile } from './goalAuthoringContext.js';
import { boundedResponse, decodeAuthoringResponse, responseProblem, repairContext, REPAIR_SYSTEM, authoringEditContract } from './goalAuthoringProtocol.js';
import { goalRequirements, referencedGoalPaths, validateRequiredPaths } from './goalRequirements.js';
import { validateEvaluation } from './evaluation.js';

const copy = value => structuredClone(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}. No changes applied.`), { code }); };
const fields = ['name', 'objective', 'constraints', 'criteria', 'tests', 'evaluation', 'requiredPaths', 'limits', 'worker', 'tools', 'folder', 'folderMode', 'createFolder', 'maxParallel', 'plateau', 'selfRedesign', 'reviewResults'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safeId = value => { if (!/^[\w-]{1,100}$/.test(value)) fail('INVALID_ID', 'Invalid record identity'); return value; };

export function semanticFields(definition, parse) {
  const result = new Map(fields.map(field => [`goal/${field}`, definition[field] ?? null]));
  for (const phase of ['recipe', 'setup']) {
    const source = definition[phase];
    if (!source) { result.set(`${phase}/structure`, null); continue; }
    const stack = parse(source);
    const structure = [];
    const visit = (node, parent, branch, index) => {
      structure.push({ id: node.id, kind: node.kind, use: node.use ?? null, parent, branch, index });
      result.set(`${phase}/${node.id}/title`, node.title ?? '');
      for (const [key, value] of Object.entries(node.config ?? {})) result.set(`${phase}/${node.id}/config/${key}`, value);
      for (const [key, value] of Object.entries(node)) {
        if (!['id', 'kind', 'use', 'title', 'config', 'children', 'else'].includes(key)) result.set(`${phase}/${node.id}/${key}`, value);
      }
      node.children?.forEach((child, i) => visit(child, node.id, 'children', i));
      node.else?.forEach((child, i) => visit(child, node.id, 'else', i));
    };
    visit(stack.root, null, null, 0);
    const { root, ...metadata } = stack;
    result.set(`${phase}/structure`, { ...metadata, nodes: structure });
  }
  return result;
}
export function definitionDiff(before, after, parse) {
  const a = semanticFields(before, parse), b = semanticFields(after, parse);
  return [...new Set([...a.keys(), ...b.keys()])].filter(key => !same(a.get(key), b.get(key))).map(address => ({
    address, before: a.get(address) ?? null, after: b.get(address) ?? null,
    kind: !a.has(address) ? 'added' : !b.has(address) ? 'removed' : 'changed',
  }));
}
function applyOperations(definition, operations, parse) {
  const next = copy(definition);
  if (!Array.isArray(operations) || !operations.length || operations.length > 40) fail('INVALID_WORKFLOW', 'Use 1–40 replace operations');
  const used = new Set();
  for (const operation of operations) {
    if (operation.op !== 'replace' || typeof operation.address !== 'string' || used.has(operation.address)) fail('INVALID_WORKFLOW', 'Invalid or duplicate operation');
    used.add(operation.address);
    const { address, value } = operation;
    const parts = address.split('/');
    if (parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) fail('INVALID_WORKFLOW', 'Invalid field');
    if (parts[0] === 'goal' && parts.length === 2 && fields.includes(parts[1])) next[parts[1]] = copy(value);
    else if (['recipe', 'setup'].includes(address)) next[address] = value;
    else if (['recipe', 'setup'].includes(parts[0]) && ((parts.length === 3 && parts[2] === 'title') || (parts.length === 4 && parts[2] === 'config'))) {
      const stack = parse(next[parts[0]]);
      const nodes = [];
      const visit = node => { nodes.push(node); node.children?.forEach(visit); node.else?.forEach(visit); };
      visit(stack.root);
      const node = nodes.find(item => item.id === parts[1]);
      if (!node) fail('STALE_QUOTE', 'The quoted step no longer exists');
      if (parts[2] === 'title') node.title = value;
      else { node.config ??= {}; node.config[parts[3]] = copy(value); }
      next[parts[0]] = serializeStack(stack);
    } else fail('EDIT_OUT_OF_SCOPE', `Unsupported field ${address}`);
  }
  return next;
}

export class GoalAuthoring {
  constructor({ root, goals, call, models = () => [] }) { this.root = root; this.goals = goals; this.call = call; this.models = models; this.requests = new Map(); this.transactions = new Map(); this.requestStarts = new Map(); this.deliveries = new Set(); }
  file(projectId, draftId) { return path.join(this.root, digest(this.goals.project(projectId).id), `${safeId(draftId)}.json`); }
  list({ projectId }) {
    const directory = path.dirname(this.file(projectId, 'listing'));
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(file => file.endsWith('.json')).map(file => {
      const state = this.read({ projectId, draftId: file.slice(0, -5) });
      return { id: state.id, name: state.definition.name, revision: state.revision, goalId: state.goalId };
    });
  }
  // Definitions are shared; mutable authoring sessions and runtime state remain
  // local. Reading the persisted catalogue works even if the source project is
  // closed, moved or removed from the project registry. Existing drafts appear
  // automatically, so there is no migration or second copy to get out of sync.
  library() {
    if (!fs.existsSync(this.root)) return [];
    const result = [];
    for (const directory of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[a-f0-9]{64}$/.test(directory.name)) continue;
      for (const file of fs.readdirSync(path.join(this.root, directory.name))) {
        if (!/^[\w-]{1,100}\.json$/.test(file)) continue;
        try {
          const state = JSON.parse(fs.readFileSync(path.join(this.root, directory.name, file), 'utf8'));
          if (!state.definition?.objective?.trim() || !state.definition.recipe) continue;
          result.push({ id: `${directory.name}:${file.slice(0, -5)}`, name: state.definition.name,
            objective: state.definition.objective.slice(0, 300), revision: state.revision,
            projectId: state.projectId, projectName: state.projectName || path.basename(state.projectId),
            draftId: state.id });
        } catch { /* One damaged record must not hide the rest of the library. */ }
      }
    }
    return result.sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id));
  }
  async reuse({ projectId, libraryId }) {
    if (typeof libraryId !== 'string' || !/^[a-f0-9]{64}:[\w-]{1,100}$/.test(libraryId)) fail('INVALID_ID', 'Invalid library identity');
    const [directory, draftId] = libraryId.split(':');
    const original = JSON.parse(fs.readFileSync(path.join(this.root, directory, `${draftId}.json`), 'utf8'));
    // Whitelist only definition fields. Never copy approvals, grants, requests,
    // selected context files, runtime IDs, folder identity, memory or spending.
    const definition = Object.fromEntries([...fields, 'recipe', 'setup'].filter(key => Object.hasOwn(original.definition, key)).map(key => [key, copy(original.definition[key])]));
    definition.folder = ''; // Bind to the destination project, never the source.
    const state = await this.open({ projectId, definition });
    state.origin = { libraryId, name: original.definition.name, revision: original.revision };
    return this.save(state);
  }
  async requirements({ projectId, draftId, definition }) {
    const state = draftId ? this.read({ projectId, draftId }) : null;
    definition ??= state?.definition;
    if (!definition || JSON.stringify(definition).length > 150000) fail('INVALID_WORKFLOW', 'Invalid definition');
    const fields = semanticFields(definition, await this.parser());
    const workspace = state?.goalId ? this.goals.get(projectId, state.goalId).workspace?.path : null;
    const report = goalRequirements(definition, this.goals.project(projectId), { workspace, references: referencedGoalPaths(fields) });
    if (definition.worker?.model && !(await this.models()).some(model => model.id === definition.worker.model)) report.warnings.push({ code: 'model', address: 'goal/worker', message: `The saved model ${definition.worker.model} is not enabled. Choose an available model before starting.` });
    return report;
  }
  read(args) {
    const state = JSON.parse(fs.readFileSync(this.file(args.projectId, args.draftId), 'utf8'));
    // A process restart cannot accidentally replay a paid request.
    for (const request of state.requests) if (request.status === 'working' && !this.requests.has(`${state.id}:${request.id}`)) {
      let running = false;
      if (request.pid && request.pid !== process.pid) { try { process.kill(request.pid, 0); running = true; } catch (error) { running = error.code === 'EPERM'; } }
      if (!running) { request.status = 'interrupted'; request.error = 'Request interrupted. Submit a new request to retry.'; }
    }
    return state;
  }
  /**
   * Delete a draft that never became a Goal.
   *
   * Serialised like every other mutation: an edit already in flight would
   * otherwise write the file back after the delete removed it, leaving a draft
   * that reappears on the next poll.
   *
   * Two refusals, both about not destroying something else's record. A draft
   * carrying a `goalId` is the authoring record of a started Goal — the
   * contract, the history and the revision it is running are all in here, and
   * the Goal has no other copy. A draft with a request still working is one an
   * AI call is about to write to; deleting it turns a paid request into an
   * error nobody asked for.
   */
  async remove(args) {
    return this.serial(args, async () => {
      const state = this.read(args);
      if (state.goalId) fail('LOCKED_RECORD', 'This draft is the record of a started Goal and cannot be deleted');
      if (state.requests.some(item => item.status === 'working')) {
        fail('DRAFT_BUSY', 'An AI request is still running on this draft. Cancel it, then delete.');
      }
      fs.rmSync(this.file(state.projectId, state.id));
      return { removed: state.id, name: state.definition.name };
    });
  }
  save(state) {
    state.sequence = (state.sequence ?? 0) + 1;
    const file = this.file(state.projectId, state.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2)); fs.renameSync(temp, file);
    return copy(state);
  }
  async serial(args, action) {
    const key = this.file(args.projectId, args.draftId);
    const prior = this.transactions.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
      const lock = `${key}.lock`;
      if (fs.existsSync(lock)) {
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
        let running = true;
        try { process.kill(owner.pid, 0); } catch (error) { running = error.code === 'EPERM'; }
        if (running) fail('DRAFT_BUSY', 'Another authoring process owns this transaction');
        fs.unlinkSync(lock);
      }
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      try { return await action(); } finally { fs.unlinkSync(lock); }
    });
    this.transactions.set(key, next);
    try { return await next; } finally { if (this.transactions.get(key) === next) this.transactions.delete(key); }
  }
  async parser() { return (await this.goals.blocks()).kernel.parseStack; }
  async open({ projectId, goalId, definition }) {
    projectId = this.goals.project(projectId).id;
    const draftId = goalId ? `goal-${safeId(goalId)}` : crypto.randomUUID();
    if (goalId) {
      const existing = this.goals.get(projectId, goalId);
      if (existing.contract.authoringId) return this.read({ projectId, draftId: existing.contract.authoringId });
    }
    if (fs.existsSync(this.file(projectId, draftId))) return this.read({ projectId, draftId });
    let runtimeRevision = null;
    if (goalId) {
      const goal = this.goals.get(projectId, goalId);
      runtimeRevision = goal.pendingRevision ?? goal.activeRevision;
      definition = { ...goal.contract, ...goal.definition, name: goal.name,
        recipe: this.goals.inspect({ projectId, goalId, record: `recipe-${runtimeRevision}` }).source };
    }
    definition = { name: 'New goal', objective: '', constraints: '', criteria: [], tests: [], requiredPaths: [], tools: [], folder: '', folderMode: 'focus', createFolder: false, maxParallel: 1, plateau: 3, selfRedesign: false, reviewResults: false, worker: null, setup: null, ...definition,
      limits: { iterations: 10, calls: 100, minutes: 30, usd: null, ...definition?.limits } };
    await this.validate(definition, projectId, false);
    return this.save({ id: draftId, projectId, projectName: this.goals.project(projectId).name, goalId: goalId ?? null, runtimeRevision, definition: copy(definition), revision: 1,
      hash: digest(definition), policyRevision: 1, locks: [], baseline: goalId ? 'existing' : 'human', approvedHash: null,
      grants: [], proposals: [], requests: [], history: [], ui: { composer: '', quotes: [] }, authoringCalls: 0, knownUsd: 0, unknownCostCalls: 0 });
  }
  async validate(definition, projectId, complete = true) {
    if (definition?.evaluation) validateEvaluation(definition.evaluation);
    if (!definition || JSON.stringify(definition).length > 150000) fail('INVALID_WORKFLOW', 'Definition is missing or too large');
    try { validateRequiredPaths(definition.requiredPaths); } catch (error) { fail('INVALID_WORKFLOW', error.message); }
    for (const [field, maximum] of [['name', 120], ['objective', 12000], ['constraints', 8000], ['folder', 1000]]) {
      if (definition[field] != null && (typeof definition[field] !== 'string' || definition[field].length > maximum)) fail('INVALID_WORKFLOW', `Invalid ${field}`);
    }
    if (!Array.isArray(definition.criteria) || definition.criteria.length > 30 || definition.criteria.some(item => !item || !['output_contains', 'file_contains'].includes(item.type) || typeof item.value !== 'string' || item.value.length > 2000 || (item.type === 'file_contains' && typeof item.path !== 'string'))) fail('INVALID_WORKFLOW', 'Invalid acceptance checks');
    if (definition.tests != null && (!Array.isArray(definition.tests) || definition.tests.length > 20 || definition.tests.some(item => !item || typeof item.input !== 'string' || typeof item.contains !== 'string'))) fail('INVALID_WORKFLOW', 'Invalid workflow tests');
    if (!Array.isArray(definition.tools) || definition.tools.length > 30 || definition.tools.some(item => typeof item !== 'string')) fail('INVALID_WORKFLOW', 'Invalid tools');
    try { validateGoalTools(definition.tools); } catch (error) { fail('INVALID_WORKFLOW', error.message); }
    if (definition.worker != null && (typeof definition.worker !== 'object' || typeof definition.worker.provider !== 'string' || typeof definition.worker.model !== 'string')) fail('INVALID_WORKFLOW', 'Invalid model binding');
    if (definition.folderMode != null && definition.folderMode !== 'focus') fail('UNSUPPORTED_EXECUTOR', 'Only folder focus is available');
    for (const field of ['createFolder', 'selfRedesign', 'reviewResults']) if (definition[field] != null && typeof definition[field] !== 'boolean') fail('INVALID_WORKFLOW', `Invalid ${field}`);
    for (const [field, max] of [['iterations', 1000], ['calls', 10000], ['minutes', 1440]]) if (!Number.isInteger(definition.limits?.[field]) || definition.limits[field] < 1 || definition.limits[field] > max) fail('INVALID_WORKFLOW', `Invalid ${field} limit`);
    if (definition.limits.usd != null && (!Number.isFinite(definition.limits.usd) || definition.limits.usd <= 0)) fail('INVALID_WORKFLOW', 'Invalid dollar threshold');
    for (const [field, max] of [['maxParallel', 4], ['plateau', 1000]]) if (definition[field] != null && (!Number.isInteger(definition[field]) || definition[field] < 1 || definition[field] > max)) fail('INVALID_WORKFLOW', `Invalid ${field}`);
    try {
      await this.goals.validateSource(definition.recipe, { maxParallel: definition.maxParallel ?? 1 });
      if (definition.setup) await this.goals.validateSource(definition.setup, { maxParallel: definition.maxParallel ?? 1 });
      if (complete) {
        if (!definition.worker?.model) fail('UNSUPPORTED_EXECUTOR', 'Choose an exact Goal model before starting');
        this.goals.contract(definition, projectId);
      }
    } catch (error) { fail('INVALID_WORKFLOW', error.message); }
  }
  checkVersion(state, revision) { if (revision !== state.revision) fail('STALE_REVISION', 'Reload the draft and refresh the proposal'); }
  async edit(args) {
    return this.serial(args, async () => {
      const state = this.read(args); this.checkVersion(state, args.baseRevision);
      const parse = await this.parser();
      const next = applyOperations(state.definition, args.operations, parse);
      await this.validate(next, state.projectId, false);
      if (state.goalId && args.operations.some(op => op.address.startsWith('goal/') || op.address === 'setup' || op.address.startsWith('setup/'))) fail('LOCKED_FIELD', 'The started instance contract and setup are fixed; create a new instance');
      const diff = definitionDiff(state.definition, next, parse);
      if (!diff.length) return state;
      state.history.push({ author: 'human', diff, at: Date.now(), revision: state.revision + 1 });
      state.definition = next; state.hash = digest(next); state.revision++; state.approvedHash = null;
      return this.save(state);
    });
  }
  async setLock(args) {
    return this.serial(args, async () => {
      const state = this.read(args); this.checkVersion(state, args.baseRevision);
      const map = semanticFields(state.definition, await this.parser());
      if (!map.has(args.address) && ![...map.keys()].some(key => key.startsWith(`${args.address}/`))) fail('STALE_QUOTE', 'Lock target does not exist');
      state.locks = args.locked ? [...new Set([...state.locks, args.address])] : state.locks.filter(item => item !== args.address);
      state.policyRevision++; state.approvedHash = null;
      state.history.push({ author: 'human', action: args.locked ? 'lock' : 'unlock', address: args.address, at: Date.now() });
      return this.save(state);
    });
  }
  async ui(args) {
    return this.serial(args, () => { const state = this.read(args); state.ui = { composer: String(args.ui?.composer ?? '').slice(0, 8000), quotes: copy(args.ui?.quotes ?? []).slice(0, 20), scope: copy(args.ui?.scope ?? { type: 'loop' }), selectedFiles: String(args.ui?.selectedFiles ?? '').slice(0, 8000) }; return this.save(state); });
  }
  async grant(args) {
    return this.serial(args, async () => {
      const state = this.read(args); this.checkVersion(state, args.baseRevision);
      const map = semanticFields(state.definition, await this.parser());
      const quotes = args.quotes ?? [];
      if (!Array.isArray(quotes) || quotes.length > 20) fail('INVALID_WORKFLOW', 'Too many quote targets');
      for (const quote of quotes) {
        if (!map.has(quote.address) || !same(map.get(quote.address), quote.value)) fail('STALE_QUOTE', 'The quoted field changed; select it again');
        if (quote.range) {
          const { start, end, text } = quote.range;
          if (typeof quote.value !== 'string' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > quote.value.length || quote.value.slice(start, end) !== text) fail('STALE_QUOTE', 'Invalid text selection');
        }
      }
      const scope = copy(args.scope ?? { type: quotes.length ? 'fields' : 'loop' });
      if (!scope || !['fields', 'step', 'loop'].includes(scope.type)) fail('EDIT_OUT_OF_SCOPE', 'Choose an edit scope');
      if (scope.type === 'fields' && !quotes.length) fail('EDIT_OUT_OF_SCOPE', 'Select at least one field');
      if (scope.type !== 'fields' && quotes.length) fail('EDIT_OUT_OF_SCOPE', 'Remove field quotes before widening scope');
      if (scope.type === 'step' && (typeof scope.address !== 'string' || !/^(recipe|setup)\/[^/]+$/.test(scope.address) || !map.has(`${scope.address}/title`))) fail('STALE_QUOTE', 'Select an existing step');
      const grant = { id: crypto.randomUUID(), baseRevision: state.revision, hash: state.hash, policyRevision: state.policyRevision, scope, quotes: copy(quotes), expires: Date.now() + 30 * 60000 };
      state.grants.push(grant); this.save(state); return grant;
    });
  }
  async checkProposal(state, args) {
      const grant = state.grants.find(item => item.id === args.grantId);
      if (!grant || grant.expires < Date.now()) fail('GRANT_EXPIRED', 'Select the target again');
      this.checkVersion(state, grant.baseRevision);
      if (state.hash !== grant.hash || state.policyRevision !== grant.policyRevision) fail('STALE_REVISION', 'The definition or locks changed');
      const parse = await this.parser();
      const next = applyOperations(state.definition, args.operations, parse);
      const diff = definitionDiff(state.definition, next, parse);
      // Check both the submitted operations and the computed diff. An equivalent
      // parent replacement is never a way to gain structural write authority.
      if (grant.quotes.length && (args.operations.some(op => !grant.quotes.some(q => q.address === op.address)) || diff.some(change => !grant.quotes.some(q => q.address === change.address)))) fail('EDIT_OUT_OF_SCOPE', 'The proposal changes fields outside the quoted scope');
      if (grant.scope?.type === 'step') {
        const allowed = address => address === `${grant.scope.address}/title` || (address.startsWith(`${grant.scope.address}/config/`) && address.split('/').length === 4);
        if (args.operations.some(op => !allowed(op.address)) || diff.some(change => !allowed(change.address))) fail('EDIT_OUT_OF_SCOPE', 'The proposal changes fields outside this step');
      }
      for (const quote of grant.quotes.filter(q => q.range)) {
        const value = semanticFields(next, parse).get(quote.address), { start, end } = quote.range;
        if (typeof value !== 'string' || !value.startsWith(quote.value.slice(0, start)) || !value.endsWith(quote.value.slice(end)) || value.length < start + quote.value.length - end) fail('EDIT_OUT_OF_SCOPE', 'Text outside the selected range changed');
      }
      if (state.goalId && diff.some(change => change.address.startsWith('goal/') || change.address.startsWith('setup/'))) fail('LOCKED_FIELD', 'The instance contract and setup cannot change');
      const inherited = new Set(['goal/worker', 'goal/tools', 'goal/folder', 'goal/folderMode', 'goal/createFolder', 'goal/maxParallel']);
      if (diff.some(change => state.locks.some(lock => change.address === lock || change.address.startsWith(`${lock}/`))) || diff.some(change => change.address.endsWith('/structure') && state.locks.some(lock => lock.startsWith(`${change.address.split('/')[0]}/`))) || (state.locks.some(lock => !lock.startsWith('goal/')) && diff.some(change => inherited.has(change.address)))) fail('LOCKED_FIELD', 'The proposal changes a lock or an effective dependency of a locked target');
      await this.validate(next, state.projectId, false);
      return { grant, next, diff };
  }
  async preview(args) {
    return this.serial(args, async () => {
      const state = this.read(args);
      const { next, diff } = await this.checkProposal(state, args);
      let readinessError = null;
      try { await this.validate(next, state.projectId, true); } catch (error) { readinessError = error.message.replace(/\b[A-Z_]+: /g, '').replace(/ No changes applied\./g, '').trim(); }
      return { valid: true, readyToStart: !readinessError, readinessError, runtimeVerified: false,
        requirements: goalRequirements(next, this.goals.project(state.projectId), { references: referencedGoalPaths(semanticFields(next, await this.parser())) }),
        changes: diff.map(({ address, kind }) => ({ address, kind })) };
    });
  }
  async propose(args) {
    return this.serial(args, async () => {
      const state = this.read(args);
      const existing = state.proposals.find(item => item.grantId === args.grantId);
      if (existing) return existing;
      const { grant, next, diff } = await this.checkProposal(state, args);
      args.signal?.throwIfAborted();
      const proposal = { id: crypto.randomUUID(), grantId: grant.id, baseRevision: state.revision, policyRevision: state.policyRevision,
        hash: digest(next), definition: next, diff, rationale: String(args.rationale ?? '').slice(0, 2000), author: 'model', status: diff.length ? 'pending' : 'no_change', initial: state.baseline === 'human' && !state.goalId && !state.history.length, at: Date.now() };
      state.proposals.push(proposal); this.save(state); return proposal;
    });
  }
  async review(args) {
    return this.serial(args, () => {
      const state = this.read(args), proposal = state.proposals.find(item => item.id === args.proposalId);
      if (!proposal) fail('INVALID_ID', 'Proposal does not exist');
      if (!['accept', 'reject'].includes(args.decision)) fail('INVALID_WORKFLOW', 'Choose accept or reject');
      if (proposal.status !== 'pending') return state;
      if (args.decision === 'accept') {
        this.checkVersion(state, proposal.baseRevision);
        if (state.policyRevision !== proposal.policyRevision) fail('STALE_REVISION', 'Locks changed after this proposal');
        state.definition = proposal.definition; state.hash = proposal.hash; state.revision++; state.approvedHash = null;
        if (proposal.initial) state.baseline = 'ai';
      }
      proposal.status = args.decision === 'accept' ? 'accepted' : 'rejected';
      state.history.push({ author: 'human', proposalId: proposal.id, decision: args.decision, hash: proposal.hash, at: Date.now() });
      return this.save(state);
    });
  }
  async author(args) {
    const key = `${this.file(args.projectId, args.draftId)}:${args.requestId}`;
    if (this.requestStarts.has(key)) return this.requestStarts.get(key);
    const start = this.startAuthor(args); this.requestStarts.set(key, start);
    try { return await start; } finally { this.requestStarts.delete(key); }
  }
  async modelTurn(args, requestId, options) {
    const began = Date.now();
    const attempt = { startedAt: began, status: 'working', correction: Boolean(options.correction),
      model: args.worker?.model, promptChars: options.system.length + options.prompt.length,
      maxTokens: options.correction ? 4096 : 12000, contentChars: 0, reasoningChars: 0 };
    let lastSave = 0, pendingSave = null, content = '', closed = false;
    let progress = { phase: options.correction ? 'correcting' : 'waiting', at: began, startedAt: began, contentChars: 0, reasoningChars: 0 };
    const persist = () => this.serial(args, () => {
      const state = this.read(args), request = state.requests.find(item => item.id === requestId);
      request.progress = copy(progress);
      request.attempts[request.attempts.length - 1] = { ...copy(attempt), ...boundedResponse(content) };
      this.save(state);
    });
    const queueProgress = () => {
      if (closed || pendingSave || Date.now() - lastSave < 750) return;
      lastSave = Date.now();
      pendingSave = persist().catch(() => { /* Final persistence below remains authoritative. */ }).finally(() => { pendingSave = null; });
    };
    await this.serial(args, () => {
      const state = this.read(args), request = state.requests.find(item => item.id === requestId);
      state.authoringCalls++; request.calls++; (request.attempts ??= []).push(copy(attempt));
      request.progress = copy(progress); this.save(state);
    });
    let result, failure;
    try {
      result = await this.call({ ...options, worker: args.worker,
        onFormat: format => { attempt.responseMode = format.mode; attempt.capabilitySource = format.source; if (format.capabilityError) attempt.capabilityError = format.capabilityError; },
        onText: (text, meta = {}) => {
          if (closed) return;
          // Never persist or render private reasoning text. Only its length is
          // needed to distinguish model activity from an empty response.
          if (typeof meta.content === 'string') content = meta.content;
          else if (!meta.reasoning && !meta.telemetry?.reasoningChars && !String(text).startsWith('⟢ thinking')) content = String(text ?? '');
          attempt.contentChars = Math.max(attempt.contentChars, content.length, Number(meta.telemetry?.contentChars) || 0);
          attempt.reasoningChars = Math.max(attempt.reasoningChars, Number(meta.telemetry?.reasoningChars) || String(meta.reasoning ?? '').length);
          attempt.firstProgressAt ??= Date.now();
          progress = { ...progress, phase: content ? 'receiving' : attempt.reasoningChars ? 'thinking' : progress.phase,
            at: Date.now(), contentChars: attempt.contentChars, reasoningChars: attempt.reasoningChars };
          queueProgress();
        },
        onCall: record => {
          const keys = ['provider', 'model', 'servedBy', 'maxTokens', 'promptChars', 'finishReason', 'contentChars', 'reasoningChars', 'usage', 'responseMode', 'capabilitySource', 'httpStatus', 'firstByteMs', 'firstReasoningMs', 'firstVisibleMs', 'ms', 'attemptMs', 'failure', 'error'];
          for (const key of keys) if (record[key] !== undefined) attempt[key] = copy(record[key]);
        },
      });
      return result;
    } catch (error) { failure = error; throw error; }
    finally {
      closed = true;
      if (pendingSave) await pendingSave;
      if (result?.text != null) content = String(result.text);
      attempt.contentChars = Math.max(attempt.contentChars, content.length);
      attempt.reasoningChars = Math.max(attempt.reasoningChars, String(result?.reasoning ?? '').length);
      attempt.finishReason = result?.finishReason ?? attempt.finishReason ?? null;
      attempt.usage = result?.usage ?? attempt.usage ?? null;
      attempt.status = failure ? 'failed' : 'complete'; attempt.completedAt = Date.now(); attempt.elapsedMs = Date.now() - began;
      if (failure) attempt.error = String(failure.message ?? failure);
      if (result?.message?.refusal) attempt.refusal = String(result.message.refusal).slice(0, 2000);
      attempt.completionProblem = result ? responseProblem(result)?.code ?? null : 'CALL_FAILED';
      await this.serial(args, () => {
        const state = this.read(args), request = state.requests.find(item => item.id === requestId);
        request.attempts[request.attempts.length - 1] = { ...copy(attempt), ...boundedResponse(content) };
        request.progress = { ...progress, phase: failure ? 'failed' : 'validating', at: Date.now(), contentChars: attempt.contentChars, reasoningChars: attempt.reasoningChars };
        const cost = result?.usage?.cost;
        if (Number.isFinite(cost)) state.knownUsd += cost; else state.unknownCostCalls++;
        this.save(state);
      });
    }
  }
  async startAuthor(args) {
    const requestId = safeId(args.requestId);
    const existing = this.read(args).requests.find(item => item.id === requestId);
    if (existing) return existing;
    const previous = this.read(args);
    if (previous.requests.some(item => item.status === 'working')) fail('DRAFT_BUSY', 'An authoring request is already working');
    if (previous.requests.length >= 100) fail('AUTHORING_LIMIT', 'This draft has reached its 100-request authoring limit');
    if (!args.text?.trim() || args.text.length > 8000) fail('INVALID_WORKFLOW', 'Write a request of up to 8000 characters');
    const selection = selectProjectFiles(this.goals.project(previous.projectId), args.selectedFiles);
    const grant = await this.grant(args);
    const requestKey = `${args.draftId}:${requestId}`;
    const ctl = new AbortController(); this.requests.set(requestKey, ctl);
    try { await this.serial(args, () => {
      const state = this.read(args);
      if (state.requests.some(item => item.status === 'working')) fail('DRAFT_BUSY', 'An authoring request is already working');
      state.requests.push({ id: requestId, text: args.text, grantId: grant.id, quotes: grant.quotes, scope: grant.scope,
        selectedFiles: selection.files.map(file => file.path), toolCalls: [], calls: 0, status: 'working', at: Date.now(), pid: process.pid, model: args.worker?.model });
      this.save(state);
    }); } catch (error) { this.requests.delete(requestKey); throw error; }
    // Delivery belongs to the controller, not the dialog's component lifetime.
    const delivery = (async () => {
      let error, proposal, response;
      try {
        const state = this.read(args);
        const capabilities = await authoringCapabilities(this.goals, await this.models());
        const editContract = authoringEditContract(state.definition, grant, state.locks, semanticFields(state.definition, await this.parser()), capabilities.blocks, Boolean(state.goalId));
        const context = { request: args.text, grant, locks: state.locks, definition: state.definition,
          projectRequirements: await this.requirements(args),
          started: Boolean(state.goalId), editContract,
          capabilities, conversation: conversationContext(state, requestId), selectedFiles: selection.files.map(file => file.path) };
        const exchanges = [];
        let repairs = 0, repair = null, disableStructuredOutput = false;
        for (let round = 0; round < 6; round++) {
          ctl.signal.throwIfAborted();
          let result;
          try {
            result = await this.modelTurn(args, requestId, { signal: ctl.signal,
              system: repair ? REPAIR_SYSTEM : AUTHORING_SYSTEM, correction: Boolean(repair), disableStructuredOutput,
              writableAddresses: editContract.addresses,
              prompt: JSON.stringify(repair ? repairContext(context, exchanges, repair) : { ...context, exchanges, callsRemaining: 6 - round, toolsAvailable: round < 5 }) });
          } catch (caught) {
            if (caught.authoringFormatUnsupported && !disableStructuredOutput && round < 5 && !ctl.signal.aborted) {
              disableStructuredOutput = true; continue;
            }
            throw caught;
          }
          ctl.signal.throwIfAborted();
          let envelope;
          try {
            const problem = responseProblem(result);
            if (problem) fail(problem.code, problem.message);
            envelope = decodeAuthoringResponse(parseGoalReply(result?.text ?? ''));
            if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail('INVALID_WORKFLOW', 'Return one JSON response object');
            // Existing persisted fixtures/providers may still return the old proposal shape.
            const type = envelope.type ?? (Array.isArray(envelope.operations) ? 'proposal' : null);
            if (['message', 'question'].includes(type)) {
              if (typeof envelope.text !== 'string' || !envelope.text.trim() || envelope.text.length > 8000 || envelope.operations !== undefined) fail('INVALID_WORKFLOW', 'A conversational reply needs text and cannot contain edits');
              response = { type, text: envelope.text }; break;
            }
            if (type === 'proposal') {
              const proposalArgs = { ...args, signal: ctl.signal, grantId: grant.id, operations: envelope.operations, rationale: envelope.rationale };
              const validation = await this.preview(proposalArgs);
              ctl.signal.throwIfAborted();
              proposal = await this.propose(proposalArgs);
              response = { type, text: proposal.rationale, validation }; break;
            }
            if (type !== 'tool' || round === 5 || repair) fail('INVALID_WORKFLOW', 'Return a message, question or proposal; inspection calls are bounded');
            const input = envelope.arguments;
            if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_WORKFLOW', 'Tool arguments must be an object');
            const trace = { name: envelope.name, arguments: input, at: Date.now() };
            try {
              if (envelope.name === 'read_project_file') trace.result = readSelectedFile(selection, input.path);
              else if (envelope.name === 'inspect_block') {
                const block = capabilities.blocks.find(item => item.use === input.use);
                if (!block) throw new Error('Unavailable Goal block');
                trace.result = block;
              } else if (envelope.name === 'validate_proposal') trace.result = await this.preview({ ...args, grantId: grant.id, operations: input.operations });
              else throw new Error('Unknown authoring tool; only read_project_file, inspect_block and validate_proposal are available');
              trace.ok = true;
            } catch (caught) { trace.ok = false; trace.error = String(caught.message ?? caught); }
            ctl.signal.throwIfAborted();
            exchanges.push({ assistant: envelope, tool: trace });
            await this.serial(args, () => {
              const current = this.read(args); current.requests.find(item => item.id === requestId).toolCalls.push(trace); this.save(current);
            });
          } catch (caught) {
            const feedback = String(caught.message ?? caught);
            await this.serial(args, () => {
              const current = this.read(args), request = current.requests.find(item => item.id === requestId);
              request.attempts.at(-1).validationError = feedback;
              request.toolCalls.push({ name: 'validate_response', ok: false, error: feedback, at: Date.now() }); this.save(current);
            });
            if (ctl.signal.aborted || caught.code === 'MODEL_REFUSAL' || repairs++ >= 1 || round === 5) throw caught;
            repair = { code: caught.code ?? 'INVALID_RESPONSE', error: feedback, finishReason: result?.finishReason ?? null,
              response: boundedResponse(result?.text, 24000).rawResponse, responseTruncated: String(result?.text ?? '').length > 24000 };
          }
        }
        if (!response) fail('AUTHORING_LIMIT', 'The authoring request reached its six-call limit');
      } catch (caught) { error = String(caught.message ?? caught); }
      await this.serial(args, () => {
        const state = this.read(args), request = state.requests.find(item => item.id === requestId);
        request.status = error ? 'failed' : 'complete'; request.error = error; request.proposalId = proposal?.id;
        request.response = response;
        this.save(state);
      });
    })().catch(() => { /* A persistence failure is recovered as interrupted on reload. */ }).finally(() => { this.requests.delete(requestKey); this.deliveries.delete(delivery); });
    this.deliveries.add(delivery);
    return this.read(args).requests.find(item => item.id === requestId);
  }
  async shutdown() {
    for (const ctl of this.requests.values()) ctl.abort();
    await Promise.allSettled([...this.deliveries]);
  }
  cancel(args) {
    const request = this.read(args).requests.find(item => item.id === args.requestId);
    if (request?.status === 'working') this.requests.get(`${args.draftId}:${args.requestId}`)?.abort();
    return request;
  }
  async publish(args) {
    return this.serial(args, async () => {
      const state = this.read(args); this.checkVersion(state, args.baseRevision);
      if (state.proposals.some(item => item.status === 'pending') || state.requests.some(item => item.status === 'working')) fail('REVIEW_REQUIRED', 'Resolve pending AI changes first');
      if (state.goalId && state.approvedHash === state.hash) return state;
      await this.validate(state.definition, state.projectId);
      if (!state.goalId) {
        // A crash after instance creation but before the authoring projection is
        // repaired by its durable authoring identity, never a second instance.
        const goal = this.goals.list(state.projectId).find(item => item.contract.authoringId === state.id)
          ?? await this.goals.create({ projectId: state.projectId, definition: { ...state.definition, reviewAi: true, authoringId: state.id } });
        state.goalId = goal.id; state.runtimeRevision = 1;
      } else if (state.approvedHash !== state.hash) {
        const goal = await this.goals.editSource({ projectId: state.projectId, goalId: state.goalId, baseRevision: state.runtimeRevision, source: state.definition.recipe, rationale: 'Human reviewed Goal draft' });
        state.runtimeRevision = goal.pendingRevision ?? goal.activeRevision;
      }
      state.approvedHash = state.hash;
      state.history.push({ author: 'human', action: 'approve-definition', hash: state.hash, revision: state.revision, at: Date.now() });
      return this.save(state);
    });
  }
  async queueRuntime(state, proposal) {
    const draftId = state.contract.authoringId;
    if (!draftId) fail('REVIEW_REQUIRED', 'Open the Goal in the authoring surface');
    const args = { projectId: state.projectId, draftId };
    const draft = this.read(args);
    if (draft.runtimeRevision !== state.activeRevision || draft.approvedHash !== draft.hash) fail('STALE_REVISION', 'A human draft is already pending');
    if (!state.contract.selfRedesign) fail('LOCKED_FIELD', 'Self redesign is disabled');
    if (proposal.baseRevision !== state.activeRevision) fail('STALE_REVISION', 'Runtime proposal has the wrong recipe revision');
    const source = proposal.commands ? (await this.goals.draft({ source: draft.definition.recipe, commands: proposal.commands })).source : proposal.source;
    const grant = await this.grant({ ...args, baseRevision: draft.revision });
    return this.propose({ ...args, grantId: grant.id, operations: [{ op: 'replace', address: 'recipe', value: source }], rationale: proposal.rationale });
  }
}
