/**
 * Typed RPC declarations for plugin-owned UI extension points (D61).
 *
 * This is intentionally not a ninth capability seam: it is a host boundary.
 * Plugins send data through `UiExtensionRpc`; renderer code is never part of a
 * contribution. The desktop process owns this boundary and the renderer only
 * receives values returned by `list`.
 *
 * @module #kernel/seams/ui-extensions
 */
import type { JsonValue } from '../types.js';

export const UI_COMPONENTS = ['text', 'code', 'badge', 'notice', 'key-value', 'stack'] as const;
export type UiComponentName = (typeof UI_COMPONENTS)[number];

export interface UiNode {
  component: UiComponentName;
  text?: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  label?: string;
  value?: string;
  children?: UiNode[];
}

export interface ConfigurationField {
  type: 'string' | 'number' | 'boolean' | 'select';
  title: string;
  description?: string;
  default?: string | number | boolean;
  options?: readonly string[];
}

export interface BlockConfigurationContribution {
  point: 'block-configuration';
  id: string;
  block: string;
  schema: {
    type: 'object';
    properties: Record<string, ConfigurationField>;
    required?: readonly string[];
  };
}

export interface ToolViewContribution {
  point: 'tool-view';
  id: string;
  tool: string;
  view: UiNode;
}

/** Typed seams reserved now; Flyt does not dispatch these to a renderer yet. */
export interface TraceDecorationContribution {
  point: 'trace-decoration'; id: string; event: string; view: UiNode;
}
export interface SettingsSectionContribution {
  point: 'settings-section'; id: string; title: string; view: UiNode;
}
export interface LibraryEntryContribution {
  point: 'library-entry'; id: string; title: string; description: string; view?: UiNode;
}

export type UiContribution = BlockConfigurationContribution | ToolViewContribution |
  TraceDecorationContribution | SettingsSectionContribution | LibraryEntryContribution;

export type UiExtensionRpcRequest =
  | { method: 'ui.contribute'; params: { pluginId: string; contribution: UiContribution } }
  | { method: 'ui.list'; params: { point?: UiContribution['point'] } };
export type UiExtensionRpcResponse =
  | { ok: true; result: JsonValue }
  | { ok: false; error: { code: 'INVALID_UI_CONTRIBUTION' | 'METHOD_NOT_FOUND'; message: string } };

export interface UiExtensionRpc {
  invoke(request: UiExtensionRpcRequest): UiExtensionRpcResponse;
}

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function exact(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${at} contains unsupported field "${key}"`);
  }
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${at} must be a non-empty string`);
}
function assertData(value: unknown, at: string, seen = new Set<object>()): void {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || value === undefined) {
    throw new Error(`${at} carries executable or non-serializable data`);
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (typeof value !== 'object') throw new Error(`${at} is not serializable data`);
  if (seen.has(value)) throw new Error(`${at} is cyclic`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, i) => assertData(item, `${at}[${i}]`, seen));
  else {
    if (!record(value)) throw new Error(`${at} must be a plain data object`);
    for (const [key, item] of Object.entries(value)) {
      if (/^(on[A-Z]|style|className|html|dangerouslySetInnerHTML|renderer|script)$/i.test(key)) {
        throw new Error(`${at}.${key} is renderer code, DOM access, or styling`);
      }
      assertData(item, `${at}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertNode(value: unknown, at: string): asserts value is UiNode {
  if (!record(value)) throw new Error(`${at} must be a UI node`);
  exact(value, ['component', 'text', 'tone', 'label', 'value', 'children'], at);
  if (!UI_COMPONENTS.includes(value.component as UiComponentName)) {
    throw new Error(`${at} names unknown component "${String(value.component)}"`);
  }
  if (own(value, 'text') && typeof value.text !== 'string') throw new Error(`${at}.text must be a string`);
  if (own(value, 'label') && typeof value.label !== 'string') throw new Error(`${at}.label must be a string`);
  if (own(value, 'value') && typeof value.value !== 'string') throw new Error(`${at}.value must be a string`);
  if (own(value, 'tone') && !['neutral', 'info', 'success', 'warning', 'danger'].includes(String(value.tone))) {
    throw new Error(`${at}.tone is unknown`);
  }
  if (own(value, 'children')) {
    if (!Array.isArray(value.children)) throw new Error(`${at}.children must be an array`);
    value.children.forEach((child, index) => assertNode(child, `${at}.children[${index}]`));
  }
}

function assertField(value: unknown, at: string): asserts value is ConfigurationField {
  if (!record(value)) throw new Error(`${at} must be a field declaration`);
  exact(value, ['type', 'title', 'description', 'default', 'options'], at);
  if (!['string', 'number', 'boolean', 'select'].includes(String(value.type))) throw new Error(`${at}.type is unknown`);
  text(value.title, `${at}.title`);
  if (own(value, 'description') && typeof value.description !== 'string') throw new Error(`${at}.description must be a string`);
  if (own(value, 'default') && !['string', 'number', 'boolean'].includes(typeof value.default)) throw new Error(`${at}.default is invalid`);
  if (value.type === 'select' && (!Array.isArray(value.options) || value.options.some(option => typeof option !== 'string'))) {
    throw new Error(`${at}.options must be strings for a select`);
  }
}

export function assertUiContribution(value: unknown): asserts value is UiContribution {
  assertData(value, 'contribution');
  if (!record(value)) throw new Error('contribution must be a plain data object');
  text(value.point, 'contribution.point');
  text(value.id, 'contribution.id');
  switch (value.point) {
    case 'block-configuration': {
      exact(value, ['point', 'id', 'block', 'schema'], 'contribution');
      text(value.block, 'contribution.block');
      if (!record(value.schema)) throw new Error('contribution.schema must be an object schema');
      exact(value.schema, ['type', 'properties', 'required'], 'contribution.schema');
      if (value.schema.type !== 'object' || !record(value.schema.properties)) throw new Error('contribution.schema must have object properties');
      for (const [name, field] of Object.entries(value.schema.properties)) assertField(field, `contribution.schema.properties.${name}`);
      if (own(value.schema, 'required') && (!Array.isArray(value.schema.required) || value.schema.required.some(x => typeof x !== 'string'))) {
        throw new Error('contribution.schema.required must be strings');
      }
      return;
    }
    case 'tool-view': exact(value, ['point', 'id', 'tool', 'view'], 'contribution'); text(value.tool, 'contribution.tool'); assertNode(value.view, 'contribution.view'); return;
    case 'trace-decoration': exact(value, ['point', 'id', 'event', 'view'], 'contribution'); text(value.event, 'contribution.event'); assertNode(value.view, 'contribution.view'); return;
    case 'settings-section': exact(value, ['point', 'id', 'title', 'view'], 'contribution'); text(value.title, 'contribution.title'); assertNode(value.view, 'contribution.view'); return;
    case 'library-entry': exact(value, ['point', 'id', 'title', 'description', 'view'], 'contribution'); text(value.title, 'contribution.title'); text(value.description, 'contribution.description'); if (own(value, 'view')) assertNode(value.view, 'contribution.view'); return;
    default: throw new Error(`contribution names unknown extension point "${value.point}"`);
  }
}

/** In-process implementation of the process/renderer RPC contract. */
export function createUiExtensionRpcBoundary(): UiExtensionRpc {
  const contributions: Array<{ pluginId: string; contribution: UiContribution }> = [];
  return {
    invoke(request: UiExtensionRpcRequest): UiExtensionRpcResponse {
      if (!record(request) || !record(request.params)) return { ok: false, error: { code: 'INVALID_UI_CONTRIBUTION', message: 'RPC request must be plain data' } };
      if (request.method === 'ui.contribute') {
        try {
          exact(request as unknown as Record<string, unknown>, ['method', 'params'], 'request');
          exact(request.params as unknown as Record<string, unknown>, ['pluginId', 'contribution'], 'request.params');
          text(request.params.pluginId, 'request.params.pluginId');
          assertUiContribution(request.params.contribution);
          contributions.push(structuredClone(request.params) as { pluginId: string; contribution: UiContribution });
          return { ok: true, result: { accepted: true } };
        } catch (error) {
          return { ok: false, error: { code: 'INVALID_UI_CONTRIBUTION', message: String((error as Error).message ?? error) } };
        }
      }
      if (request.method === 'ui.list') {
        const point = request.params.point;
        return { ok: true, result: structuredClone(contributions.filter(row => !point || row.contribution.point === point)) as unknown as JsonValue };
      }
      return { ok: false, error: { code: 'METHOD_NOT_FOUND', message: `Unknown UI RPC method "${String((request as { method?: unknown }).method)}"` } };
    },
  };
}
