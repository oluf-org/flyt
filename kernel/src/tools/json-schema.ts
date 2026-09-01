/**
 * Compile and report the JSON Schema attached to one model-callable tool.
 *
 * Compilation happens when the tool is registered. That makes an invalid or
 * unresolved schema a registration error instead of a hole discovered only
 * after a model has tried to use the tool. Validation uses `allErrors`: a
 * model gets one result containing every problem it can fix in one retry.
 *
 * @module #kernel/tools/json-schema
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { JsonValue, ToolResult } from '../types.js';

/** A compiled parameters schema owned by the registry. */
export type ToolArgumentValidator = (args: unknown) => readonly string[];

/** JSON's runtime type names, with arrays separated from objects. */
function jsonType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The adapter's durable representation of a function-arguments parse error. */
function hasUnparseableArguments(value: unknown): boolean {
  return isObject(value)
    && Object.keys(value).length === 1
    && typeof value._unparsed === 'string';
}

function pointerParts(pointer: string): string[] {
  if (!pointer) return [];
  return pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function pathFor(pointer: string, final?: string): string {
  const parts = [...pointerParts(pointer), ...(final === undefined ? [] : [final])];
  return parts.reduce((path, part) => (
    /^\d+$/.test(part)
      ? `${path}[${part}]`
      : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)
        ? `${path}.${part}`
        : `${path}[${JSON.stringify(part)}]`
  ), 'args');
}

/** Turn Ajv's JSON Pointers into paths a model can map back to its arguments. */
function describe(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  const child = error.keyword === 'required'
    ? String(params.missingProperty)
    : error.keyword === 'additionalProperties'
      ? String(params.additionalProperty)
      : undefined;
  const path = pathFor(error.instancePath, child);
  return `${path}: ${error.message ?? `failed ${error.keyword}`}`;
}

/**
 * Compile one tool's parameters schema.
 *
 * A fresh Ajv instance gives each tool an isolated `$id` namespace. It also
 * means a plugin cannot make another tool's local references resolve against
 * a schema it registered first. No async loader is configured, so external
 * references fail closed and are never fetched.
 */
export function compileToolArguments(toolName: string, schema: JsonValue): ToolArgumentValidator {
  let validate: ValidateFunction;
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      validateFormats: false,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
    });
    validate = ajv.compile(schema as object);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    throw new Error(`Tool "${toolName}" has an invalid parameters schema: ${message}`);
  }

  return (args: unknown): readonly string[] => {
    if (hasUnparseableArguments(args)) return ['args: arguments were not valid JSON'];
    // Native function arguments are a mapping even when a permissive `{}`
    // schema is supplied. Enforce that protocol invariant independently of a
    // plugin's schema so malformed JSON/scalars can never reach a tool body.
    if (!isObject(args)) return [`args: expected object, got ${jsonType(args)}`];
    if (validate(args)) return [];
    return (validate.errors ?? []).map(describe);
  };
}

/** One failed call result containing every schema diagnostic. */
export function invalidToolArguments(toolName: string, errors: readonly string[]): ToolResult {
  const count = `${errors.length} argument error${errors.length === 1 ? '' : 's'}`;
  const heading = `Invalid arguments for "${toolName}" (${count})`;
  return {
    content: `${heading}:\n${errors.map(error => `- ${error}`).join('\n')}\nFix all listed arguments and call the tool again.`,
    error: `${heading}: ${errors.join('; ')}`,
  };
}
