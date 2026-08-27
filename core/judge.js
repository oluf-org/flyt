// DECISIONS.md D27 — the comparison judge.
// One direct model call, made outside any run: the flow's `compare` role
// applied to two finished runs' final outputs, framed as A vs B. This module
// is the pure half — the prompt contract, the user-message builder, and the
// verdict parser — so it tests without a store, a runner, or a model. The
// StackRunner owns the actual call (judgeComparison), the way investigateNode
// owns its direct call.
//
// The judge is deliberately BLIND: the prompt names the alternatives A and B
// but never says which model or config produced which — a judge that knows
// the contestants grades the contestants, not the work. Provenance is still
// recorded where the design wants it: the comparison record knows the runs,
// the runs know their configs (meta.modeId / launchOverrides), and the
// verdict carries the judge model + timestamp.
//
// The verdict contract ("a summary, not a gate"): a human-readable Markdown
// report, then ONE fenced ```json block with the structured half —
//   { "winner": "A" | "B" | "tie",
//     "axes": { "<axis>": "A" | "B" | "tie", ... },
//     "notes": "<the decisive reason, one or two sentences>" }
export const JUDGE_SYSTEM = [
  'ROLE: compare-judge',
  'You are the Compare judge. You are given the ORIGINAL PROMPT and TWO',
  'ALTERNATIVES (A and B): the same task completed independently. Do NOT redo',
  'the work and do NOT merge — compare and judge.',
  'Produce a structured Markdown report:',
  '# Comparison\n\n## Agreements\n<where they align — likely safe to trust>',
  '\n\n## Differences\n<each substantive difference: what diverges, and which alternative handles it better, with reasoning>',
  '\n\n## Strengths & weaknesses\n<per alternative>',
  '\n\n## Verdict\n<which alternative serves the brief better overall, and why — or an honest tie>',
  'Ground every judgment in the actual outputs (quote or reference). Judge',
  'correctness and fitness for the brief, not style or length. If the',
  'alternatives are equivalent on a point, say so instead of inventing a winner.',
  'After the report, end with exactly ONE ```json block and nothing after it:',
  '{',
  '  "winner": "A" | "B" | "tie",',
  '  "axes": { "correctness": "A" | "B" | "tie", "completeness": "A" | "B" | "tie" },',
  '  "notes": "<one or two sentences: the decisive reason>"',
  '}',
  'axes: 2-4 short axis names this task actually turns on (correctness,',
  'completeness, fitness for the brief, clarity — your call). Every axis value',
  'and the winner must be exactly "A", "B", or "tie".'
].join('\n');

// Long outputs still need to fit one prompt alongside each other. 20k chars
// each is far past a typical final answer; past that the tail is cut with a
// marker rather than silently dropped.
const MAX_ALT_CHARS = 20000;
const cap = text => {
  const t = String(text ?? '');
  return t.length > MAX_ALT_CHARS ? t.slice(0, MAX_ALT_CHARS) + '\n… (truncated)' : t;
};

// The user message: the original prompt plus each alternative under its A/B
// label. `alternatives` is [{ label: 'A'|'B', text }] — exactly what
// judgeAlternatives (src/compareRun.js) prepares renderer-side and
// judgeComparison prepares store-side.
export function buildJudgePrompt({ prompt = '', alternatives = [] } = {}) {
  return [
    `ORIGINAL PROMPT:\n${String(prompt ?? '').trim() || '(unknown)'}`,
    ...alternatives.map(a => `ALTERNATIVE ${a.label}:\n${cap(a.text)}`)
  ].join('\n\n');
}

// Winner/axis values normalize to 'A' | 'B' | 'tie'; anything else is not a
// verdict value and gets dropped (a malformed axis must not poison the rest).
function normalizeSide(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'a') return 'A';
  if (v === 'b') return 'B';
  if (v === 'tie' || v === 'draw' || v === 'equal') return 'tie';
  return null;
}

// Parse the judge's output into its two halves. Total, never throws — the
// report is valuable even when the model botched the JSON, so a missing or
// malformed block degrades to { summary: <full text>, null fields } instead
// of an error. Returns:
//   { summary, winner, axes, notes }
// summary — the report with the accepted verdict fence stripped (the whole
//           text when no block parsed)
// winner  — 'A' | 'B' | 'tie' | null
// axes    — { <axis>: 'A'|'B'|'tie' } | null (invalid entries dropped)
// notes   — string | null
export function parseJudgeVerdict(text) {
  const s = String(text ?? '').trim();
  const fallback = { summary: s, winner: null, axes: null, notes: null };
  if (!s) return fallback;

  // Fenced blocks only: a Markdown report can contain braces galore, so the
  // whole-text/outermost-slice fallbacks of extractJson would misfire here.
  // Scan from the LAST fence backwards — the contract says the verdict ends
  // the output, and a report may legitimately quote earlier fenced code.
  const fences = [];
  const re = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(s)) !== null) fences.push({ body: m[1], index: m.index, length: m[0].length });

  for (let i = fences.length - 1; i >= 0; i--) {
    let parsed;
    try { parsed = JSON.parse(fences[i].body.trim()); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    // A verdict block names at least one of the contract keys; a ```json
    // block the judge quoted for other reasons must not be eaten.
    if (!('winner' in parsed) && !('axes' in parsed) && !('notes' in parsed)) continue;

    const winner = normalizeSide(parsed.winner);
    let axes = null;
    if (parsed.axes && typeof parsed.axes === 'object' && !Array.isArray(parsed.axes)) {
      const clean = {};
      for (const [k, v] of Object.entries(parsed.axes)) {
        const key = String(k).trim();
        const side = normalizeSide(v);
        if (key && side) clean[key] = side;
      }
      if (Object.keys(clean).length) axes = clean;
    }
    const notes = typeof parsed.notes === 'string' && parsed.notes.trim() ? parsed.notes.trim() : null;
    const summary = (s.slice(0, fences[i].index) + s.slice(fences[i].index + fences[i].length)).trim();
    return { summary: summary || s, winner, axes, notes };
  }
  return fallback;
}
