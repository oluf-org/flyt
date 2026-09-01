/** Resource-scoped policy beneath Flyt's classification and static tool ceiling. */
import path from 'node:path';
import fs from 'node:fs';
import type { JsonValue } from '../types.js';

export type PermissionEffect = 'read' | 'write' | 'shell';
export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  id: string;
  /** Tool name glob. `*` is the only wildcard and matches within the whole string. */
  action?: string | readonly string[];
  /** Resource/path glob. Relative paths are matched against the project root. */
  resource?: string | readonly string[];
  effect?: PermissionEffect | readonly PermissionEffect[];
  decision: PermissionDecision;
  /** A deny with this flag cannot be displaced by a later rule or saved approval. */
  unoverrideable?: boolean;
  /** An allow with this flag explicitly authorizes a resource outside the project. */
  externalDirectory?: boolean;
  reason?: string;
}

export interface SavedApproval {
  id: string;
  projectId: string;
  action: string;
  resource?: string;
  effect?: PermissionEffect;
  createdAt: string;
  expiresAt?: string;
}

export interface PermissionPolicy {
  projectId: string;
  projectRoot: string;
  rules?: readonly PermissionRule[];
  savedApprovals?: readonly SavedApproval[];
  /** Globs matched against resource paths and every string argument. */
  protectedSecrets?: readonly string[];
}

export interface PermissionRequest {
  action: string;
  effect: PermissionEffect;
  args: JsonValue;
  resource?: string;
}

export interface PermissionEvaluation {
  decision: PermissionDecision;
  reason: string;
  ruleId?: string;
  savedApprovalId?: string;
  resource?: string;
  external: boolean;
  unoverrideable: boolean;
}

/** Small project-owned persistence boundary for reusable approvals. */
export class SavedApprovalStore {
  constructor(readonly file: string, readonly projectId: string) {}

  list(): SavedApproval[] {
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedApproval => Boolean(item)
      && typeof item === 'object'
      && (item as SavedApproval).projectId === this.projectId
      && typeof (item as SavedApproval).id === 'string'
      && typeof (item as SavedApproval).action === 'string');
  }

  save(approval: Omit<SavedApproval, 'projectId'>): SavedApproval {
    const stored: SavedApproval = { ...approval, projectId: this.projectId };
    const approvals = [...this.list().filter(item => item.id !== stored.id), stored];
    this.write(approvals);
    return stored;
  }

  revoke(id: string): boolean {
    const approvals = this.list();
    const remaining = approvals.filter(item => item.id !== id);
    if (remaining.length === approvals.length) return false;
    this.write(remaining);
    return true;
  }

  private write(approvals: readonly SavedApproval[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(approvals, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.file);
  }
}

const RESOURCE_KEYS = ['path', 'file', 'directory', 'cwd', 'root', 'target', 'destination', 'url'];

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
}

/** Best-effort resource normalization. Tools may supply an explicit resource to avoid inference. */
export function resourceOf(args: JsonValue, projectRoot: string): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, JsonValue>;
  const value = RESOURCE_KEYS.map(key => record[key]).find(item => typeof item === 'string');
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return path.resolve(projectRoot, value);
}

function glob(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value.replaceAll('\\', '/'));
}

function oneOf<T extends string>(expected: T | readonly T[] | undefined, actual: T): boolean {
  return expected === undefined || (Array.isArray(expected) ? expected : [expected]).includes(actual);
}

function matches(rule: PermissionRule, request: PermissionRequest, resource?: string): boolean {
  const actions = rule.action === undefined ? [] : Array.isArray(rule.action) ? rule.action : [rule.action];
  const resources = rule.resource === undefined ? [] : Array.isArray(rule.resource) ? rule.resource : [rule.resource];
  return (!actions.length || actions.some(pattern => glob(pattern, request.action)))
    && oneOf(rule.effect, request.effect)
    && (!resources.length || Boolean(resource && resources.some(pattern => glob(pattern, resource!))));
}

function isExternal(resource: string | undefined, root: string): boolean {
  if (!resource || /^[a-z][a-z0-9+.-]*:\/\//i.test(resource)) return Boolean(resource);
  const relative = path.relative(path.resolve(root), path.resolve(resource));
  return relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

function secretMatch(policy: PermissionPolicy, request: PermissionRequest, resource?: string): string | undefined {
  const values = [...strings(request.args), ...(resource ? [resource] : [])].map(v => v.replaceAll('\\', '/'));
  return policy.protectedSecrets?.find(pattern => values.some(value => glob(pattern, value)));
}

/**
 * Evaluate rules without ever widening the already-checked static ceiling.
 * Denies are fail-closed; saved approvals are exact, project-scoped allows.
 */
export function evaluatePermission(policy: PermissionPolicy, request: PermissionRequest): PermissionEvaluation {
  const resource = request.resource ?? resourceOf(request.args, policy.projectRoot);
  const external = isExternal(resource, policy.projectRoot);
  const secret = secretMatch(policy, request, resource);
  if (secret) return {
    decision: 'deny', reason: `protected secret pattern "${secret}" matched this call`,
    resource, external, unoverrideable: true,
  };

  const matching = (policy.rules ?? []).filter(rule => matches(rule, request, resource));
  const hardDeny = matching.find(rule => rule.decision === 'deny' && rule.unoverrideable);
  if (hardDeny) return {
    decision: 'deny', reason: hardDeny.reason ?? `unoverrideable rule "${hardDeny.id}" denied this call`,
    ruleId: hardDeny.id, resource, external, unoverrideable: true,
  };

  const last = matching.at(-1);
  if (last?.decision === 'deny') return {
    decision: 'deny', reason: last.reason ?? `rule "${last.id}" denied this call`,
    ruleId: last.id, resource, external, unoverrideable: false,
  };

  if (external && !(last?.decision === 'allow' && last.externalDirectory)) return {
    decision: 'deny', reason: 'external resources require an explicit external-directory allow rule',
    ...(last ? { ruleId: last.id } : {}), resource, external: true, unoverrideable: false,
  };

  if (last) return {
    decision: last.decision, reason: last.reason ?? `rule "${last.id}" selected ${last.decision}`,
    ruleId: last.id, resource, external, unoverrideable: false,
  };

  const now = Date.now();
  const saved = (policy.savedApprovals ?? []).find(approval =>
    approval.projectId === policy.projectId
    && glob(approval.action, request.action)
    && (!approval.resource || Boolean(resource && glob(approval.resource, resource)))
    && (!approval.effect || approval.effect === request.effect)
    && (!approval.expiresAt || Date.parse(approval.expiresAt) > now));
  if (saved) return {
    decision: 'allow', reason: `project-scoped saved approval "${saved.id}" matched`,
    savedApprovalId: saved.id, resource, external, unoverrideable: false,
  };

  return { decision: 'ask', reason: 'no resource-scoped permission rule matched', resource, external, unoverrideable: false };
}
