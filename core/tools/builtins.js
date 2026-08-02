// The built-in tools: the modules whose run() lives in source, and the seed
// definitions the ToolStore writes to tools/<id>.json on first launch.
//
// Built-ins are files too (TOOLS-PLAN §4.1) — seeded exactly as
// PRESET_NODE_TEMPLATES seeds nodes/. They are read-only in the UI (you may
// disable one, or clone it to edit): the run() lives here, so an editable
// definition would lie about what executes. The module is therefore the source
// of truth for a built-in's schema and metadata, and the file is refreshed
// from it when a release changes one.
import writeFile from './write_file.js';
import createFile from './create_file.js';
import readFile from './read_file.js';
import editFile from './edit_file.js';
import glob from './glob.js';
import grep from './grep.js';
import bash from './bash.js';
import createTask from './create_task.js';
import writeTaskMd from './write_task_md.js';
import readToolResult from './read_tool_result.js';
import getTime from './get_time.js';
import httpFetch from './http_fetch.js';
import webSearch from './web_search.js';
import askHuman from './ask_human.js';

export const BUILTIN_MODULES = [
  // Reading and searching the workspace — all read-effect, none ever gated.
  readFile, glob, grep,
  // Changing it. edit_file is the one to reach for on an existing file.
  editFile, createFile, writeFile, bash,
  // The run's own bookkeeping.
  createTask, writeTaskMd, readToolResult,
  // The world outside, and the person outside.
  getTime, httpFetch, webSearch, askHuman
];

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
