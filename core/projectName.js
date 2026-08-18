// Deriving a project name from the first prompt (DECISIONS.md D25, Q-L4).
// When a run starts from the projectless lander, the app auto-creates a project
// named from what the user typed — no folder picker, no naming dialog. The
// heuristic is a cheap synchronous slug so it never delays the run; an
// AI-suggested rename can come later (out of scope, §8).
//
// Rules (Q-L4): lowercase the leading meaningful words of the first line, drop
// common stop words (articles/prepositions/pronouns — never the imperative verb
// that names the task), keep the first few, join with hyphens, cap the length.
// Deterministic and instant: the same prompt always yields the same slug.

// Filler words that carry no identity. The leading verb ("fix", "add", "build")
// is deliberately NOT here — it's the most recognizable part of the name.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with',
  'my', 'our', 'your', 'this', 'that', 'these', 'those', 'it', 'its',
  'is', 'are', 'be', 'into', 'at', 'by', 'from', 'as', 'so', 'please',
  'can', 'could', 'would', 'should', 'will', 'i', 'we', 'you', 'me', 'us'
]);

const MAX_WORDS = 4;
const MAX_LEN = 40;

// A URL/-folder-safe slug from a free-text prompt. Always non-empty.
export function slugFromPrompt(prompt) {
  const firstLine = String(prompt ?? '').split('\n')[0];
  const words = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')   // punctuation → space; keep hyphens
    .split(/[\s-]+/)
    .filter(Boolean);

  // Keep meaningful words in order, but never drop every word: if the prompt is
  // nothing but stop words, fall back to the raw leading words so we still name
  // it after what was said rather than a generic placeholder.
  let kept = words.filter(w => !STOP_WORDS.has(w)).slice(0, MAX_WORDS);
  if (kept.length === 0) kept = words.slice(0, MAX_WORDS);

  let slug = kept.join('-').slice(0, MAX_LEN).replace(/-+$/,'');
  return slug || 'project';
}

// Ensure the slug is unique against a set of taken names, appending -2, -3, …
// (the numeric suffix format decided in Q-L4). `taken` is anything with a
// `.has(name)` method (a Set) or an array.
export function dedupeSlug(slug, taken) {
  const has = Array.isArray(taken) ? name => taken.includes(name) : name => taken.has(name);
  if (!has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!has(candidate)) return candidate;
  }
}
