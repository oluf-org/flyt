// Tool registry: the single toolbox both agent execution paths (native
// tool-calling and the text protocol) draw from. A tool is
//   { name, description, parameters (JSON Schema), run(args, ctx) }
// where ctx = { store, runId, taskId, defaultWorker } gives sandboxed access
// to the run's files. Adding a tool = one file in core/tools/ + one
// registerTool call below.
import writeFile from './write_file.js';
import createFile from './create_file.js';
import readFile from './read_file.js';
import bash from './bash.js';
import createTask from './create_task.js';
import writeTaskMd from './write_task_md.js';

const registry = new Map();

// Tools that MUTATE the workspace (write files or run shell commands). These
// are the calls a per-node approval gate pauses on (V1 task 4 safety envelope);
// read-only tools like read_file are never gated.
export const DESTRUCTIVE_TOOLS = new Set(['write_file', 'create_file', 'bash']);

export function registerTool(tool) {
  if (!tool?.name || typeof tool.run !== 'function' || !tool.parameters) {
    throw new Error('A tool needs { name, description, parameters, run }');
  }
  registry.set(tool.name, tool);
  return tool;
}

// All registered tools, or the named subset (unknown names are ignored so a
// flow definition can't crash a run by naming a tool that no longer exists).
export function getTools(names) {
  if (!names) return [...registry.values()];
  return names.map(n => registry.get(n)).filter(Boolean);
}

// Minimal JSON Schema validation — enough for the flat schemas tools declare
// (type, required, properties, items, enum, additionalProperties). Returns a
// list of human-readable error strings; empty means valid.
export function validateArgs(schema, value, at = 'args') {
  const errors = [];
  const typeOf = v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  if (schema.type && typeOf(value) !== schema.type &&
      !(schema.type === 'number' && typeOf(value) === 'number')) {
    return [`${at}: expected ${schema.type}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: must be one of ${schema.enum.join(', ')}`);
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: required property missing`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validateArgs(sub, v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unknown property`);
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validateArgs(schema.items, v, `${at}[${i}]`)));
  }
  return errors;
}

// Validate + run + time one tool call. Never throws: failures (unknown tool,
// bad args, runtime error) come back as { ok: false, error } so the agent
// loop can hand them to the model for self-correction. Every call is
// appended to the run's log.jsonl.
export async function executeTool(name, args, ctx) {
  const started = Date.now();
  const record = { tool: name, args, ok: false };
  const tool = registry.get(name);
  try {
    if (!tool) throw new Error(`Unknown tool "${name}". Available: ${[...registry.keys()].join(', ')}`);
    const errors = validateArgs(tool.parameters, args ?? {});
    if (errors.length) throw new Error(`Invalid arguments: ${errors.join('; ')}`);
    record.result = await tool.run(args, ctx) ?? { ok: true };
    record.ok = true;
  } catch (err) {
    record.error = String(err?.message ?? err);
  }
  record.ms = Date.now() - started;
  ctx.store?.appendLog(ctx.runId, { event: 'tool_call', node: ctx.taskId ? `executor:${ctx.taskId}` : undefined, ...record });
  return record;
}

registerTool(writeFile);
registerTool(createFile);
registerTool(readFile);
registerTool(bash);
registerTool(createTask);
registerTool(writeTaskMd);
