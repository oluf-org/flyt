/** One typed contract for HTTP, IPC, CLI validation, and generated clients. */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { JsonValue } from '../types.js';
import type { CommandDefinition } from '../seams/commands.js';

export interface PayloadSchemas {
  request: JsonValue;
  response: JsonValue;
  error: JsonValue;
  events?: Readonly<Record<string, JsonValue>>;
}

export interface ApiOperation extends PayloadSchemas { description: string; }
export type ApiContract = Readonly<Record<string, ApiOperation>>;

export function defineContract<T extends ApiContract>(contract: T): T { return Object.freeze({ ...contract }); }

/** Project the live command map into the canonical transport contract. */
export function contractFromCommands(commands: readonly CommandDefinition[]): ApiContract {
  return defineContract(Object.fromEntries(commands.map(command => [command.name, {
    description: command.description,
    request: command.request ?? command.parameters ?? {},
    response: command.response ?? {},
    error: command.error ?? {},
    ...(command.events ? { events: command.events } : {}),
  }])));
}

function validator(name: string, schema: JsonValue): ((value: unknown) => boolean) & Pick<ValidateFunction, 'errors'> {
  // Build's legacy commands use unconstrained request/response/error schemas.
  // Their meaning is already known: every value is valid. Avoid initializing
  // Ajv and recompiling its meta-schemas for each of these empty contracts.
  // Constrained schemas still get an isolated compiler and eager validation.
  if (schema === true || (schema !== null && typeof schema === 'object' && !Array.isArray(schema) && Object.keys(schema).length === 0)) {
    return () => true;
  }
  try { return new Ajv2020({ allErrors: true, strict: false }).compile(schema as object); }
  catch (error) { throw new Error(`Invalid ${name} schema: ${String((error as Error)?.message ?? error)}`); }
}

export function compileContract(contract: ApiContract) {
  return Object.fromEntries(Object.entries(contract).map(([name, operation]) => {
    const request = validator(`${name} request`, operation.request);
    const response = validator(`${name} response`, operation.response);
    const failure = validator(`${name} error`, operation.error);
    return [name, {
      request(value: unknown): string[] { return request(value) ? [] : (request.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`); },
      response(value: unknown): string[] { return response(value) ? [] : (response.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`); },
      error(value: unknown): string[] { return failure(value) ? [] : (failure.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`); },
    }];
  }));
}

function typeName(name: string): string {
  return name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('') || 'Operation';
}

function schemaType(schema: JsonValue): string {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'JsonValue';
  const value = schema as Record<string, JsonValue>;
  if (Array.isArray(value.enum)) return value.enum.map(item => JSON.stringify(item)).join(' | ') || 'never';
  if (Array.isArray(value.oneOf)) return value.oneOf.map(schemaType).join(' | ');
  if (value.type === 'string') return 'string';
  if (value.type === 'number' || value.type === 'integer') return 'number';
  if (value.type === 'boolean') return 'boolean';
  if (value.type === 'null') return 'null';
  if (value.type === 'array') return `Array<${schemaType(value.items ?? {})}>`;
  if (value.type === 'object' || value.properties) {
    const required = new Set(Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === 'string') : []);
    const properties = value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)
      ? value.properties as Record<string, JsonValue> : {};
    const fields = Object.entries(properties).map(([key, child]) =>
      `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${schemaType(child)};`).join(' ');
    return `{ ${fields}${value.additionalProperties === true ? ' [key: string]: JsonValue;' : ''} }`;
  }
  return 'JsonValue';
}

export type ContractSurface = 'http' | 'ipc' | 'cli';

/** One validator wrapper used by HTTP, IPC and CLI transports. */
export function createValidatedTransport(
  contract: ApiContract,
  surface: ContractSurface,
  transport: (operation: string, request: JsonValue) => Promise<JsonValue>,
): (operation: string, request: JsonValue) => Promise<JsonValue> {
  const compiled = compileContract(contract);
  return async (operation, request) => {
    const validation = compiled[operation];
    if (!validation) throw new Error(`${surface}: unknown operation "${operation}"`);
    const requestProblems = validation.request(request);
    if (requestProblems.length) throw new Error(`${surface}: invalid ${operation} request: ${requestProblems.join('; ')}`);
    const response = await transport(operation, request);
    const responseProblems = validation.response(response);
    if (responseProblems.length) throw new Error(`${surface}: invalid ${operation} response: ${responseProblems.join('; ')}`);
    return response;
  };
}

/** Deterministic operation-specific TypeScript client source from the same schemas. */
export function generateTypescriptClient(contract: ApiContract, interfaceName = 'FlytClient'): string {
  const names = Object.keys(contract).sort();
  const aliases = names.map(name => {
    const base = typeName(name);
    const operation = contract[name];
    return `export type ${base}Request = ${schemaType(operation.request)};\nexport type ${base}Response = ${schemaType(operation.response)};\nexport type ${base}Error = ${schemaType(operation.error)};`;
  }).join('\n');
  const methods = names.map(name => {
    const base = typeName(name);
    return `  async ${JSON.stringify(name)}(request: ${base}Request): Promise<${base}Response> { return await this.transport(${JSON.stringify(name)}, request) as ${base}Response; }`;
  }).join('\n');
  return `// Generated from the Flyt command contract. Do not edit.\nimport type { JsonValue } from '#kernel';\n${aliases}\nexport class ${interfaceName} {\n  constructor(private transport: (operation: string, request: JsonValue) => Promise<JsonValue>) {}\n${methods}\n}\n`;
}
