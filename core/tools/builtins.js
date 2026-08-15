// The built-in tools: the modules whose run() lives in source, and the seed
// definitions the ToolStore writes to tools/<id>.json on first launch.
//
// Built-ins are files too (TOOLS-PLAN §4.1) — seeded exactly as
// SEED_NODE_TEMPLATES seeds nodes/. They are read-only in the UI (you may
// disable one, or clone it to edit): the run() lives here, so an editable
// definition would lie about what executes. The module is therefore the source
// of truth for a built-in's schema and metadata, and the file is refreshed
// from it when a release changes one.
import writeFile from './write_file.js';
import createFile from './create_file.js';
import readFile from './read_file.js';
import bash from './bash.js';
import createTask from './create_task.js';
import enqueueTask from './enqueue_task.js';
import searchReferences from './search_references.js';
import writeTaskMd from './write_task_md.js';
import readToolResult from './read_tool_result.js';
import glob from './glob.js';

export const BUILTIN_MODULES = [readFile, glob, createFile, writeFile, bash, createTask, enqueueTask, searchReferences, writeTaskMd, readToolResult];

export const builtinModule = id => BUILTIN_MODULES.find(t => t.name === id) ?? null;

// The definition that gets written to tools/<id>.json. Everything the store
// normalizes (trust, enabled, result handling) is left to normalizeTool.
export const builtinDefinition = tool => ({
  id: tool.name,
  title: tool.title ?? tool.name,
  description: tool.description,
  provider: 'builtin',
  effects: tool.effects ?? ['read'],
  scope: tool.scope ?? 'workspace',
  risk: tool.risk,
  autoExecute: tool.autoExecute === true,
  source: { kind: 'builtin', importedFrom: null, importedAt: null },
  trust: 'trusted',
  parameters: tool.parameters,
  keywords: tool.keywords ?? [],
  examples: tool.examples ?? [],
  ...(tool.result ? { result: tool.result } : {})
});

export const builtinDefinitions = () => BUILTIN_MODULES.map(builtinDefinition);
