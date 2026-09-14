// Trusted, bounded workspace observations and durable workflow call accounting.
// Project commands still enter through ctx.tools; this adapter only reads Git/files.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureRepoFiles, repoSnapshotDigest } from './repoChanges.js';
import { readProjectGateConfig } from './gates.js';
import { scrubbedParentEnv } from '#kernel';

const exec = promisify(execFile);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const MAX_DIFF = 80_000;
const numberLines = text => text.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n');
const safeId = value => { if (!/^[\w.-]+$/.test(value)) throw new Error('Invalid workflow evidence identity'); return value; };

export function createWorkflowSupport({ workspace, sessions, runsRoot, now = Date.now }) {
  const file = (runId, id) => path.join(runsRoot, safeId(runId), 'workflow-evidence', `${safeId(id)}.json`);
  const write = async (runId, id, record) => {
    const target = file(runId, id);
    try { await fs.access(target); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(record));
    await fs.rename(temp, target);
  };
  const read = async (runId, id) => JSON.parse(await fs.readFile(file(runId, id), 'utf8'));
  const locks = new Map();
  const boundRuns = new Set();
  const locked = async (id, action) => {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(id, next);
    try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); }
  };
  const support = {
    tracks(request) { return boundRuns.has(request.executionContext?.runId); },
    async capture(runId, _key) {
      const snapshot = await captureRepoFiles(workspace);
      const files = [...snapshot.files].sort(([a], [b]) => a.localeCompare(b));
      const digest = repoSnapshotDigest(snapshot);
      // Several stages inspect the same version. Store its content once rather
      // than copying the entire workspace for every check and review label.
      const id = `${snapshot.partial ? 'partial' : 'complete'}-${digest}`;
      const record = { id, digest, partial: snapshot.partial, files: Object.fromEntries(files.map(([name, value]) => [name, {
        hash: value.hash, text: value.content && !value.content.includes(0) ? value.content.toString('utf8') : null,
      }])) };
      await write(runId, id, record);
      return { id, digest, partial: record.partial, files: Object.keys(record.files) };
    },
    async changes(runId, before, after) {
      const left = await read(runId, before.id), right = await read(runId, after.id);
      if (left.digest !== before.digest || right.digest !== after.digest) throw new Error('Workspace evidence digest does not match its record');
      const files = [...new Set([...Object.keys(left.files), ...Object.keys(right.files)])]
        .filter(name => left.files[name]?.hash !== right.files[name]?.hash).sort();
      let text = '', truncated = false;
      for (const name of files) {
        const a = left.files[name], b = right.files[name];
        const section = `\nFILE ${name}\nBEFORE (${a?.hash ?? 'absent'}):\n${a ? a.text == null ? '[binary or unavailable]' : numberLines(a.text) : '[absent]'}\nAFTER (${b?.hash ?? 'absent'}):\n${b ? b.text == null ? '[binary or unavailable]' : numberLines(b.text) : '[absent]'}\n`;
        const remaining = MAX_DIFF - text.length;
        text += section.slice(0, Math.max(0, remaining));
        if (section.length > remaining) truncated = true;
      }
      return { before, after, files, text, truncated };
    },
    async comparison(runId, key, base = 'HEAD') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_./~^{}@-]{0,199}$/.test(base) || base.includes('..')) throw new Error('Review base must be a single local Git revision');
      const options = { cwd: workspace, env: scrubbedParentEnv(), windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' };
      const resolved = (await exec('git', ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], options)).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(resolved)) throw new Error('Could not pin review base');
      const before = await support.capture(runId, `${key}-before`);
      const diff = (await exec('git', ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', resolved, '--'], options)).stdout;
      const untracked = (await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], options)).stdout.split('\0').filter(Boolean);
      const names = (await exec('git', ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', resolved, '--'], options)).stdout.split('\0').filter(Boolean);
      const snapshot = await read(runId, before.id);
      let text = `Pinned base: ${resolved}\n${diff}`;
      for (const name of untracked) if (snapshot.files[name]) text += `\nNEW FILE ${name}\n${numberLines(snapshot.files[name].text ?? '[binary]')}`;
      const after = await support.capture(runId, `${key}-after`);
      if (before.digest !== after.digest) throw new Error('Workspace changed while capturing the review comparison');
      return { before, after, files: [...new Set([...names, ...untracked])], text: text.slice(0, MAX_DIFF), truncated: text.length > MAX_DIFF };
    },
    gates() { const gates = readProjectGateConfig(workspace).gates; return Array.isArray(gates) ? gates.map(String).filter(Boolean) : []; },
    async bindBudget(runId, blockId, after, limits) {
      boundRuns.add(runId);
      return locked(runId, async () => {
        const session = await sessions.open(runId);
        let saved;
        for await (const event of session.read(after)) if (event.type === 'workflow.budget' && event.data.blockId === blockId) saved = event.data;
        if (!saved) {
          saved = { blockId, after, limits, startedAt: now(), deadline: now() + limits.minutes * 60_000 };
          await session.append({ type: 'workflow.budget', data: saved });
        }
        return { deadline: saved.deadline };
      });
    },
    async beforeCall(request) {
      const context = request.executionContext;
      if (!context) return null;
      return locked(context.runId, async () => {
        const session = await sessions.open(context.runId);
        let budget; const records = [];
        for await (const event of session.read()) {
          const data = event.data;
          if (event.type === 'workflow.budget' && (context.blockId === data.blockId || context.blockId.startsWith(`${data.blockId}.`))) budget = data;
          if (event.type === 'workflow.call' || event.type === 'workflow.call-result') records.push(event);
        }
        if (!budget) return null;
        const owned = records.filter(e => e.seq > budget.after && e.data.owner === budget.blockId);
        const calls = owned.filter(e => e.type === 'workflow.call');
        const results = owned.filter(e => e.type === 'workflow.call-result');
        const knownUsd = results.reduce((sum, e) => sum + (e.data.costUsd ?? 0), 0);
        const unknown = calls.length - results.filter(e => e.data.costUsd != null).length;
        const reason = calls.length >= budget.limits.calls ? 'model call limit reached'
          : now() >= budget.deadline ? 'elapsed time limit reached'
            : budget.limits.usd != null && unknown > 0 ? 'a provider attempt has unknown cost; cannot enforce the selected dollar limit'
              : budget.limits.usd != null && knownUsd >= budget.limits.usd ? 'settled cost limit reached' : null;
        if (reason) throw Object.assign(new Error(`Workflow stopped: ${reason}. Saved work and usage are retained.`), { code: 'workflow_limit', failure: { code: 'workflow_limit', source: 'scheduler', retryable: false, userInitiated: false, detail: reason } });
        const id = crypto.randomUUID();
        await session.append({ type: 'workflow.call', data: { id, owner: budget.blockId, blockId: context.blockId, model: request.model } });
        return { runId: context.runId, id, owner: budget.blockId };
      });
    },
    async afterCall(ticket, result) {
      if (!ticket) return;
      const session = await sessions.open(ticket.runId);
      const cost = result?.usage?.cost ?? result?.usage?.costUsd;
      await session.append({ type: 'workflow.call-result', data: { id: ticket.id, owner: ticket.owner,
        costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null } });
    },
  };
  return support;
}
