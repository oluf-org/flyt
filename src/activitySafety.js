// Shared, deliberately narrow sanitizers for persistent AI activity metadata.
// Core uses these before writing a live edge; the renderer applies them again
// before displaying one. Raw arguments, prompts, output and results never
// belong in the persistent shell projection.
const SECRET = new RegExp([
  'bearer\\s+\\S+',
  '\\b(?:sk|pk)-[a-z0-9_-]{8,}',
  '\\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})',
  '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
  '\\bxox[baprs]-[a-z0-9-]{10,}',
  '\\bAIza[a-z0-9_-]{30,}',
  '\\beyJ[a-z0-9_-]{8,}\\.eyJ[a-z0-9_-]{8,}\\.[a-z0-9_-]{8,}',
  '\\b(?:api[_-]?key|token|password|secret|authorization)\\s*[:=]\\s*[^\\s,;]+'
].join('|'), 'gi');

const SAFE_TOOL_SUBJECT_FIELDS = new Map([
  ['read_file', 'path'], ['write_file', 'path'], ['create_file', 'path'],
  ['edit_file', 'path'], ['glob', 'pattern']
]);
const SAFE_TOOL_NAMES = new Set([
  ...SAFE_TOOL_SUBJECT_FIELDS.keys(),
  'bash', 'run_gate', 'read_task', 'update_task', 'why_blocked', 'read_run',
  'web_fetch', 'web_search', 'search_references', 'enqueue_task', 'create_task',
  'ask_human'
]);

export function safeActivityLabel(value, max = 64) {
  if (value == null) return null;
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(SECRET, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1))}…` : clean;
}

export function safeActivityToolName(value) {
  return SAFE_TOOL_NAMES.has(value) ? value : null;
}

export function safeActivityFileSubject(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) return null;
  if (/\b(prompt|reasoning|output|stdout|stderr|api[_ -]?key|token|password|secret|authorization|bearer)\b/i.test(value)) return null;
  // A structured path is still model-produced input. Whitespace makes prose
  // ending in a filename indistinguishable from a legitimate path, so unusual
  // paths are omitted from persistent chrome and remain available in run detail.
  if (/\s/.test(value)) return null;
  const subject = safeActivityLabel(value, 60);
  if (!subject || subject.includes('[redacted]')) return null;
  const allowed = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./\\-*?[]{}@';
  if ([...subject].some(char => !allowed.includes(char))) return null;
  if (!/[\\/]/.test(subject) && !/[*?\[\]]/.test(subject)
      && !/^\./.test(subject) && !/\.[a-z0-9]{1,12}$/i.test(subject)) return null;
  return subject;
}

export function safeActivityToolSubject(tool, args) {
  const field = SAFE_TOOL_SUBJECT_FIELDS.get(tool);
  return field ? safeActivityFileSubject(args?.[field]) : null;
}
