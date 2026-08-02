// Redaction for tool-call records (TOOLS-PLAN §13, §10.3).
//
// The audit trail must be safe to read, share and attach to a bug report, so
// what lands in log.jsonl and runs/<id>/tools/<seq>-<tool>.json is the call
// with its credentials removed. Two sources:
//
//   1. `${secrets.NAME}` references, resolved at request time by the provider
//      (P5). Given the resolved values, they are put BACK as `${secrets.NAME}`
//      so the record reads like the definition that produced it.
//   2. Anything credential-shaped in the arguments themselves — a model that
//      was handed a token in its context can put one in a tool call, and the
//      record is written before anyone notices.
//
// Deliberately narrow: a value is masked when it IS a credential, not when it
// merely contains something that looks like one. Redacting substrings of a
// file's contents would corrupt the record of what was actually written.

export const REDACTED = '[redacted]';

// Well-known credential shapes, anchored to the whole value.
const CREDENTIAL = new RegExp([
  '^sk-[A-Za-z0-9_-]{16,}$',                 // OpenAI-style
  '^sk-ant-[A-Za-z0-9_-]{16,}$',             // Anthropic
  '^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$',// GitHub
  '^github_pat_[A-Za-z0-9_]{20,}$',
  '^xox[baprs]-[A-Za-z0-9-]{10,}$',          // Slack
  '^AKIA[0-9A-Z]{16}$',                      // AWS access key id
  '^AIza[A-Za-z0-9_-]{30,}$'                 // Google
].join('|'));

// `Authorization: Bearer <token>` and friends, where the scheme is kept and
// only the credential goes.
const AUTH_VALUE = /^(Bearer|Basic|Token)\s+\S+$/i;

// Query parameters whose value is a credential by convention.
const SECRET_PARAM = /^(api[-_]?key|access[-_]?token|token|key|secret|password|auth)$/i;

// Header names whose value is a credential by convention (PIVOT-PLAN §4.3).
// Broader than SECRET_PARAM because a provider's key header is never spelled
// the same way twice (`x-api-key`, `authorization`, `x-goog-api-key`) — and
// broader is safe here in a way it would not be for tool arguments, where
// `sort_key` and `cache_key` are ordinary field names.
const SECRET_HEADER = /^(?:[a-z0-9]+-)*(api-?key|authorization|auth|token|secret|password|cookie|session|credentials?)$/i;

// Unanchored credential shapes, for free text (PIVOT-PLAN §4.3).
//
// The rules above are deliberately narrow: a value is masked when it IS a
// credential. That is right for tool arguments, where masking a substring of a
// file's contents would corrupt the record of what was written. It is wrong for
// a WIRE record, which carries whole prompts — a key pasted into a prompt
// arrives embedded in prose, and "no secret ever reaches disk" (PIVOT-PLAN §9.2)
// is not satisfied by a rule that can only see credentials standing alone.
// `sk-ant-` leads the alternation so an Anthropic key is masked whole.
//
// The token boundaries are load-bearing rather than cosmetic. Without the
// leading one, `e-task-a-aiStep-mribsag70` contains `sk-a-aiStep-mribsag70`,
// which satisfies `sk-[A-Za-z0-9_-]{16,}` — every hyphenated node id in the app
// reads as an OpenAI key, and a scanner that cries wolf on flow.json is a
// scanner nobody keeps running.
const EMBEDDED_CREDENTIAL = new RegExp(
  '(?<![A-Za-z0-9_-])(?:' + [
    'sk-ant-[A-Za-z0-9_-]{16,}',
    'sk-[A-Za-z0-9_-]{16,}',
    '(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'xox[baprs]-[A-Za-z0-9-]{10,}',
    'AKIA[0-9A-Z]{16}',
    'AIza[A-Za-z0-9_-]{30,}'
  ].join('|') + ')(?![A-Za-z0-9_-])',
  'g');

const isCredential = s => CREDENTIAL.test(s);

function redactString(value, secrets) {
  let out = value;
  for (const [name, secret] of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join('${secrets.' + name + '}');
  }
  if (out !== value) return out;                       // a known secret: named, not masked
  if (isCredential(out)) return REDACTED;
  if (AUTH_VALUE.test(out)) return out.replace(/\s+\S+$/, ` ${REDACTED}`);
  return redactUrl(out);
}

// A URL's query string is the one place a credential hides inside a larger
// string often enough to be worth handling.
function redactUrl(value) {
  if (!/^https?:\/\//i.test(value) || !value.includes('?')) return value;
  try {
    const url = new URL(value);
    let touched = false;
    for (const [k] of [...url.searchParams]) {
      if (!SECRET_PARAM.test(k)) continue;
      url.searchParams.set(k, REDACTED);
      touched = true;
    }
    return touched ? url.toString() : value;
  } catch { return value; }
}

// Redact a tool call's arguments. `secrets` is a { NAME: value } map of
// resolved secret values (empty until P5); each is put back as its reference.
export function redactArgs(args, secrets = {}) {
  return walk(args, secretPairs(secrets), 0, false);
}

// Redact a wire record (PIVOT-PLAN §4.3) — the same walk, plus the embedded
// sweep. One module, two strictnesses: `redactArgs` preserves content it cannot
// prove is a credential, `redactWire` prefers a mangled prompt to a leaked key.
export function redactWire(value, secrets = {}) {
  return walk(value, secretPairs(secrets), 0, true);
}

// Mask credential-shaped substrings anywhere in a string. Exported so a scanner
// (and tests) can use exactly the rule the writer used.
export function redactText(value) {
  const s = String(value ?? '');
  return s.replace(EMBEDDED_CREDENTIAL, REDACTED);
}

// A secret shorter than this is more likely to be a common word than a
// credential, and blanket-replacing it would shred the record.
const secretPairs = secrets =>
  Object.entries(secrets ?? {}).filter(([, v]) => typeof v === 'string' && v.length >= 8);

// `depth > 12` stops at pathological nesting rather than recursing forever;
// beyond it the value is dropped rather than passed through, because an
// unredacted deep branch is exactly the leak this module exists to prevent.
function walk(value, secrets, depth, deep) {
  if (depth > 12) return deep ? '[depth-limited]' : value;
  if (typeof value === 'string') {
    const out = redactString(value, secrets);
    return deep ? redactText(out) : out;
  }
  if (Array.isArray(value)) return value.map(v => walk(v, secrets, depth + 1, deep));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      k,
      // A key that names a credential is masked whatever its value looks like.
      typeof v === 'string' && v && (SECRET_PARAM.test(k) || (deep && SECRET_HEADER.test(k)))
        ? REDACTED
        : walk(v, secrets, depth + 1, deep)
    ]));
  }
  return value;
}
