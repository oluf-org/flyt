// The Tool copilot's contract — authoring by description (TOOLS-PLAN §15).
// This module is the pure half, exactly as core/judge.js is the pure half of
// the comparison judge: the system prompt, the user-message builder, and the
// parser. It tests without a store, a runner or a model; electron/main.js owns
// the actual callModel round trip.
//
// The copilot's whole job is turning a sentence, a pasted cURL, or a spec URL
// into a DRAFT tool record the user can read before it becomes a file. It
// never writes anything: `Add to library` is a separate, human gesture. That
// is not ceremony — a tool is a capability grant, and §12.2 puts
// user-authored tools at `review` trust precisely because a human looked at
// them. A copilot that saved its own drafts would launder model output into
// that tier.
import { normalizeTool } from '../src/toolTypes.js';

export const DRAFT_SYSTEM = [
  'ROLE: tool-author',
  'You help a user add a tool to Flyt\'s Tool Library. A tool is a FILE — a',
  'JSON record describing a capability an AI agent may be granted. You draft',
  'that record; the user reviews and saves it. You never save anything.',
  '',
  'Given a description, a pasted cURL command, an API spec URL, or a schema,',
  'produce ONE tool. Reply in two parts:',
  '',
  '1. Two or three sentences of plain prose: what the tool will do, and the',
  '   one judgement call you made that the user should check (a guessed',
  '   parameter, an assumed auth scheme, an inferred base URL). If something',
  '   is genuinely ambiguous, ask instead of guessing.',
  '2. Exactly ONE ```json block, last in the message, nothing after it:',
  '',
  '{',
  '  "tool": {',
  '    "id": "<lowercase_with_underscores, starts with a letter — also the model-visible name>",',
  '    "title": "<short human label>",',
  '    "description": "<what the MODEL sees: what it does, what it returns, when to reach for it>",',
  '    "provider": "http" | "builtin",',
  '    "effects": ["read" | "write" | "network" | "shell" | "destructive", ...],',
  '    "risk": "safe" | "caution" | "danger",',
  '    "categoryId": "<one of the category ids offered below, or null>",',
  '    "keywords": ["<words someone would search to find this>"],',
  '    "examples": ["<a request this tool answers, in plain words>"],',
  '    "parameters": { "type": "object", "required": [...], "properties": { ... } },',
  '    "http": { "method": "GET", "url": "https://…/{{arg}}", "headers": { … }, "body": null }',
  '  },',
  '  "notes": "<one sentence on what still needs the user\'s attention, or an empty string>",',
  '  "suggestions": ["<a short follow-up the user might ask next>", "…"]',
  '}',
  '',
  'Rules that are not negotiable:',
  '- `parameters` is JSON Schema (2020-12, object at the root). Every property',
  '  gets a `description` — it is the only thing the model reads to decide what',
  '  to put there. Mark truly-required parameters required and nothing else.',
  '- NEVER put a literal credential anywhere. An API key is written',
  '  "${secrets.NAME}" and the user links it locally. A draft containing a real',
  '  key is rejected before it reaches them.',
  '- Interpolate a validated argument as {{argname}}. The two syntaxes are',
  '  different on purpose: {{…}} is an argument, ${secrets.…} is a secret.',
  '- `effects` is what the call COSTS if it misbehaves, not what it is for. Any',
  '  outbound request is "network". Anything that changes remote or local state',
  '  is "write". Anything irreversible is "destructive" — and that one can never',
  '  be un-gated, so do not apply it loosely.',
  '- Prefer `provider: "http"` for anything reachable over HTTP. Only use',
  '  "builtin" when the user is describing something Flyt already ships.',
  '- Omit the "http" block entirely when the provider is not http.',
  '- `suggestions` is 2-3 items, each under about six words.',
  'If the request is not about authoring a tool, answer in prose and emit',
  '{"tool": null, "notes": "…", "suggestions": [...]} instead.'
].join('\n');

// Long pastes (a whole OpenAPI document dropped on the page) still have to fit
// one prompt. Past this the tail is cut with a marker rather than silently
// dropped — a truncated spec the model can see the edge of beats one it thinks
// it read whole.
const MAX_INPUT_CHARS = 24000;
const cap = text => {
  const t = String(text ?? '');
  return t.length > MAX_INPUT_CHARS ? `${t.slice(0, MAX_INPUT_CHARS)}\n… (truncated)` : t;
};

// The user message: the brief, the columns available to file it under, and
// what the library already holds — so the copilot proposes a name that does
// not collide and a category that already exists.
export function buildDraftPrompt({ brief = '', categories = [], existingIds = [], attachment = null, history = [] } = {}) {
  const parts = [];
  if (history.length) {
    parts.push('EARLIER IN THIS THREAD:\n' + history
      .slice(-6)
      .map(m => `${m.role === 'user' ? 'User' : 'You'}: ${cap(m.text).slice(0, 2000)}`)
      .join('\n'));
  }
  parts.push(`REQUEST:\n${cap(brief).trim() || '(empty)'}`);
  if (attachment?.text) {
    parts.push(`ATTACHED FILE (${attachment.name ?? 'unnamed'}):\n${cap(attachment.text)}`);
  }
  parts.push(`CATEGORY IDS AVAILABLE:\n${categories.length ? categories.map(c => `${c.id} — ${c.name}`).join('\n') : '(none)'}`);
  if (existingIds.length) {
    parts.push(`TOOL IDS ALREADY TAKEN (pick a different one):\n${existingIds.join(', ')}`);
  }
  return parts.join('\n\n');
}

// The last fenced json block in the reply, so a model that illustrates a point
// with an earlier snippet doesn't defeat the parse. Same convention as
// core/planEval.js and core/judge.js.
export function extractJsonBlock(text = '') {
  const matches = [...String(text).matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try { return JSON.parse(matches[i][1]); } catch { /* try the one before it */ }
  }
  return null;
}

// The prose half: everything before the block the parser took, so the thread
// shows the explanation without the payload repeated under it.
export function proseOf(text = '') {
  const idx = String(text).lastIndexOf('```');
  if (idx < 0) return String(text).trim();
  const open = String(text).slice(0, idx).lastIndexOf('```');
  return String(text).slice(0, open < 0 ? idx : open).trim();
}

// A literal credential in a draft is refused outright rather than saved
// disabled: unlike an imported definition (§10.3), nothing is lost by asking
// again, and a key that reaches a file has to be assumed leaked. Mirrors the
// load-time lint so the copilot cannot become the way around it.
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i
];

export function credentialProblem(tool) {
  const blob = JSON.stringify(tool ?? {});
  // A ${secrets.NAME} reference is the CORRECT shape and must not trip the
  // scan — strip references before looking for literals.
  const stripped = blob.replace(/\$\{secrets\.[A-Za-z0-9_]+\}/g, '');
  for (const re of SECRET_SHAPES) {
    if (re.test(stripped)) {
      return 'The draft contained something shaped like a real credential. Reference it as ${secrets.NAME} and link the value locally instead.';
    }
  }
  return null;
}

// Turn a model reply into { prose, tool, notes, suggestions, error }. Never
// throws: a copilot that crashes the page because a model mis-shaped one field
// is worse than one that says so and offers the prose it did get.
export function parseDraft(text = '') {
  const prose = proseOf(text);
  const block = extractJsonBlock(text);
  if (!block) {
    return { prose: prose || String(text).trim(), tool: null, notes: '', suggestions: [], error: null };
  }
  const suggestions = Array.isArray(block.suggestions)
    ? block.suggestions.filter(s => typeof s === 'string' && s.trim()).slice(0, 3).map(s => s.trim())
    : [];
  const notes = typeof block.notes === 'string' ? block.notes.trim() : '';
  if (!block.tool || typeof block.tool !== 'object') {
    return { prose, tool: null, notes, suggestions, error: null };
  }
  const bad = credentialProblem(block.tool);
  if (bad) return { prose, tool: null, notes, suggestions, error: bad };
  try {
    // Provenance is written by Flyt, never by the draft: a model does not get
    // to declare its own output first-party (§12.2). `user` → `review` trust.
    const tool = normalizeTool({
      ...block.tool,
      source: { kind: 'user', importedFrom: null, importedAt: null },
      trust: undefined,
      autoExecute: false
    });
    return { prose, tool, notes, suggestions, error: null };
  } catch (err) {
    return { prose, tool: null, notes, suggestions, error: String(err?.message ?? err) };
  }
}
