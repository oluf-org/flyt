// Minimal YAML subset used by the Flow DSL (STACK_LANG.md).
//
// The npm `yaml` package was the plan's first choice, but the DSL only needs
// a small, well-defined slice of YAML, so this dependency-free implementation
// covers exactly that slice — and rejects everything else loudly, which is a
// feature: an AI author gets a clear error instead of silent misparsing.
//
// Supported:
//   - block maps + nested block maps (indentation, 2 spaces recommended)
//   - block sequences (`- item`), incl. compact map items (`- id: x`)
//   - inline (flow) collections: { k: v, ... } and [a, b, ...]
//   - scalars: null/~, true/false, numbers, plain strings,
//     'single-quoted', "double-quoted with JSON escapes"
//   - literal block scalars: | and |-
//   - comments (# ... at line start or after whitespace, outside quotes)
// Not supported (throws): anchors/aliases, tags, multi-doc (---), folded
// scalars (>), flow maps spanning lines, complex keys.

class YamlError extends Error {
  constructor(message, line) {
    super(line != null ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}
export { YamlError };

// --- comment stripping (outside quotes) -------------------------------------

function stripComment(raw) {
  let inS = false, inD = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inD) {
      if (c === '\\') i++;
      else if (c === '"') inD = false;
    } else if (inS) {
      if (c === "'") { if (raw[i + 1] === "'") i++; else inS = false; }
    } else if (c === '"') inD = true;
    else if (c === "'") inS = true;
    else if (c === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

// --- scalar parsing ----------------------------------------------------------

const NUM_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-][0-9]+)?$/;

function parseScalar(s, line) {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t[0] === '"') {
    try { return JSON.parse(t); }
    catch { throw new YamlError(`bad double-quoted string: ${t}`, line); }
  }
  if (t[0] === "'") {
    if (t.length < 2 || t[t.length - 1] !== "'") throw new YamlError(`unterminated single-quoted string`, line);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (NUM_RE.test(t)) return Number(t);
  if (t === '---' || t[0] === '&' || t[0] === '*' || t[0] === '!' || t[0] === '>') {
    throw new YamlError(`unsupported YAML feature in scalar "${t}"`, line);
  }
  return t;
}

// --- inline (flow) collections ------------------------------------------------

function parseInline(s, line) {
  const t = s.trim();
  if (t[0] !== '{' && t[0] !== '[') return parseScalar(t, line);
  const p = { s: t, i: 0, line };
  const v = inlineValue(p);
  skipWs(p);
  if (p.i !== t.length) throw new YamlError(`trailing characters after inline value: "${t.slice(p.i)}"`, line);
  return v;
}

function skipWs(p) { while (p.i < p.s.length && (p.s[p.i] === ' ' || p.s[p.i] === '\t')) p.i++; }

function inlineValue(p) {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '{') return inlineMap(p);
  if (c === '[') return inlineSeq(p);
  // scalar up to , } ] respecting quotes
  const start = p.i;
  if (c === '"' || c === "'") {
    const q = c;
    p.i++;
    while (p.i < p.s.length) {
      if (q === '"' && p.s[p.i] === '\\') p.i += 2;
      else if (p.s[p.i] === q) { if (q === "'" && p.s[p.i + 1] === "'") p.i += 2; else { p.i++; break; } }
      else p.i++;
    }
    return parseScalar(p.s.slice(start, p.i), p.line);
  }
  while (p.i < p.s.length && !',}]'.includes(p.s[p.i]) && p.s[p.i] !== ':') p.i++;
  // allow ':' inside plain scalars only when not followed by space (e.g. URLs)
  while (p.s[p.i] === ':' && p.s[p.i + 1] !== ' ' && p.s[p.i + 1] !== ',' && p.s[p.i + 1] !== '}' && p.s[p.i + 1] !== ']' && p.s[p.i + 1] !== undefined) {
    p.i++;
    while (p.i < p.s.length && !',}]'.includes(p.s[p.i]) && p.s[p.i] !== ':') p.i++;
  }
  return parseScalar(p.s.slice(start, p.i), p.line);
}

function inlineMap(p) {
  const out = {};
  p.i++; // {
  skipWs(p);
  if (p.s[p.i] === '}') { p.i++; return out; }
  for (;;) {
    skipWs(p);
    const key = inlineValue(p);
    skipWs(p);
    if (p.s[p.i] !== ':') throw new YamlError(`expected ':' in inline map`, p.line);
    p.i++;
    const val = inlineValue(p);
    out[String(key)] = val;
    skipWs(p);
    if (p.s[p.i] === ',') { p.i++; continue; }
    if (p.s[p.i] === '}') { p.i++; return out; }
    throw new YamlError(`expected ',' or '}' in inline map`, p.line);
  }
}

function inlineSeq(p) {
  const out = [];
  p.i++; // [
  skipWs(p);
  if (p.s[p.i] === ']') { p.i++; return out; }
  for (;;) {
    out.push(inlineValue(p));
    skipWs(p);
    if (p.s[p.i] === ',') { p.i++; continue; }
    if (p.s[p.i] === ']') { p.i++; return out; }
    throw new YamlError(`expected ',' or ']' in inline sequence`, p.line);
  }
}

// --- block structure -----------------------------------------------------------

function toLines(text) {
  const out = [];
  const raw = text.split(/\r?\n/);
  for (let n = 0; n < raw.length; n++) {
    const noComment = stripComment(raw[n]);
    if (!noComment.trim()) { out.push(null); continue; } // keep index for literal blocks
    const indent = noComment.match(/^ */)[0].length;
    if (noComment[indent] === '\t') throw new YamlError('tabs are not allowed for indentation', n + 1);
    out.push({ indent, text: noComment.trimEnd(), lineNo: n + 1 });
  }
  return { lines: out, raw };
}

// Find the ':' separating key from value, outside quotes.
function splitKey(content, line) {
  let inS = false, inD = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inD) { if (c === '\\') i++; else if (c === '"') inD = false; }
    else if (inS) { if (c === "'") { if (content[i + 1] === "'") i++; else inS = false; } }
    else if (c === '"') inD = true;
    else if (c === "'") inS = true;
    else if (c === ':' && (i + 1 === content.length || content[i + 1] === ' ')) {
      return [content.slice(0, i), content.slice(i + 1).trim()];
    }
  }
  return null;
}

export function parseYaml(text) {
  if (typeof text !== 'string') throw new YamlError('input must be a string');
  if (/^---\s*$/m.test(text)) throw new YamlError('multi-document YAML is not supported');
  const { lines, raw } = toLines(text);

  let pos = 0;
  const peek = () => { while (pos < lines.length && lines[pos] === null) pos++; return lines[pos] ?? null; };

  function parseBlock(minIndent) {
    const first = peek();
    if (!first || first.indent < minIndent) return null;
    return first.text.slice(first.indent).startsWith('- ') || first.text.slice(first.indent) === '-'
      ? parseSeq(first.indent)
      : parseMap(first.indent);
  }

  function literalBlock(indent, chomp, lineNo) {
    // consume raw lines more indented than `indent`
    const body = [];
    let bodyIndent = null;
    while (pos < lines.length) {
      const rawLine = raw[pos];
      if (lines[pos] === null) {
        // blank source line: belongs to the block
        if (rawLine !== undefined && rawLine.trim() === '') { body.push(''); pos++; continue; }
      }
      const l = lines[pos];
      if (!l) break;
      if (l.indent <= indent) break;
      if (bodyIndent === null) bodyIndent = l.indent;
      body.push(rawLine.slice(Math.min(bodyIndent, rawLine.match(/^ */)[0].length)));
      pos++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    if (!body.length) throw new YamlError('empty literal block', lineNo);
    return body.join('\n') + (chomp ? '' : '\n');
  }

  function parseMap(indent) {
    const out = {};
    for (;;) {
      const l = peek();
      if (!l || l.indent < indent) return out;
      if (l.indent > indent) throw new YamlError(`unexpected indent`, l.lineNo);
      const content = l.text.slice(indent);
      if (content.startsWith('- ')) throw new YamlError('unexpected sequence item in map', l.lineNo);
      const kv = splitKey(content, l.lineNo);
      if (!kv) throw new YamlError(`expected "key: value", got "${content}"`, l.lineNo);
      const key = String(parseScalar(kv[0], l.lineNo));
      if (key in out) throw new YamlError(`duplicate key "${key}"`, l.lineNo);
      const rest = kv[1];
      pos++;
      if (rest === '') {
        const next = peek();
        out[key] = next && next.indent > indent ? parseBlock(indent + 1) : null;
      } else if (rest === '|' || rest === '|-') {
        out[key] = literalBlock(indent, rest === '|-', l.lineNo);
      } else if (rest === '>' || rest === '>-') {
        throw new YamlError('folded block scalars (>) are not supported; use | or a quoted string', l.lineNo);
      } else {
        out[key] = parseInline(rest, l.lineNo);
      }
    }
  }

  function parseSeq(indent) {
    const out = [];
    for (;;) {
      const l = peek();
      if (!l || l.indent < indent) return out;
      if (l.indent > indent) throw new YamlError('unexpected indent in sequence', l.lineNo);
      const content = l.text.slice(indent);
      if (!(content.startsWith('- ') || content === '-')) return out;
      const rest = content === '-' ? '' : content.slice(2).trim();
      if (rest === '') {
        pos++;
        const next = peek();
        out.push(next && next.indent > indent ? parseBlock(indent + 1) : null);
      } else if (rest[0] !== '{' && rest[0] !== '[' && splitKey(rest, l.lineNo)) {
        // compact map item: `- key: value` — rewrite this line as the map's
        // first entry at the item indent, then continue the map block.
        lines[pos] = { ...l, indent: indent + 2, text: ' '.repeat(indent + 2) + rest };
        out.push(parseMap(indent + 2));
      } else {
        pos++;
        out.push(parseInline(rest, l.lineNo));
      }
    }
  }

  const result = parseBlock(0);
  const left = peek();
  if (left) throw new YamlError(`unexpected content: "${left.text.trim()}"`, left.lineNo);
  return result;
}

// --- emitting -------------------------------------------------------------------

// Plain (unquoted) scalar safety: conservative on purpose — anything doubtful
// is emitted as a JSON double-quoted string, which round-trips exactly.
const PLAIN_RE = /^[A-Za-z0-9_][A-Za-z0-9 _.,;()&+/·→'-]*$/;
export function isPlainSafe(s) {
  return PLAIN_RE.test(s)
    && s === s.trim()
    && !/[ ]{2,}/.test(s)
    && !NUM_RE.test(s)
    && !['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off'].includes(s.toLowerCase())
    && !s.includes(': ')
    && !s.includes(" #")
    && !s.endsWith(':');
}

export function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v);
  const s = String(v);
  return isPlainSafe(s) ? s : JSON.stringify(s);
}

// Inside a flow collection (`[a, b]`, `{ k: v }`) the delimiters are syntax, so
// a scalar containing one has to be quoted even though it would be perfectly
// safe on a line of its own. Without this, a description with a comma in it
// serialized to `{ description: Any git URL, or a path }` and no longer parsed.
const FLOW_UNSAFE = /[,{}[\]]/;
const formatFlowScalar = v => {
  if (typeof v === 'string' && FLOW_UNSAFE.test(v)) return JSON.stringify(v);
  return formatScalar(v);
};

// Deterministic single-line rendering of any value (maps/arrays inline).
export function formatInline(v) {
  if (Array.isArray(v)) return v.length ? `[${v.map(formatInline).join(', ')}]` : '[]';
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, val]) => val !== undefined);
    return entries.length
      ? `{ ${entries.map(([k, val]) => `${formatFlowScalar(k)}: ${formatInline(val)}`).join(', ')} }`
      : '{}';
  }
  return formatFlowScalar(v);
}
