// Redaction for tool-call records (DESIGN-SPEC.md §5).
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
  const pairs = Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v.length >= 8);
  return walk(args, pairs, 0);
}

function walk(value, secrets, depth) {
  if (depth > 12) return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map(v => walk(v, secrets, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      k,
      // A key that names a credential is masked whatever its value looks like.
      typeof v === 'string' && SECRET_PARAM.test(k) && v ? REDACTED : walk(v, secrets, depth + 1)
    ]));
  }
  return value;
}
