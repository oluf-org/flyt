/**
 * A strict, hand-written YAML subset — enough for a composition file.
 *
 * The same argument as the DSL parser (D24): the file a person edits to decide
 * which plugins run is not a place for a parser with surprises in it. What is
 * supported is block mappings, block sequences, plain and quoted scalars,
 * block scalars (`|`, `|-`), comments, and nesting by indentation. Everything
 * else — anchors, flow style, multiple documents, tags — is an error naming
 * the line, rather than a silent reinterpretation.
 *
 * `!!js` is called out by name because dsh's own presets use it and we do not
 * evaluate it: a composition file that can run arbitrary code is a composition
 * file that has to be trusted like code.
 *
 * @module #kernel/loader/yaml
 */

/** Anything this parser can produce. */
export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

/** A parse failure, with the line to look at. */
export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'YamlError';
    this.line = line;
  }
}

interface Line {
  /** 1-based, for error messages. */
  n: number;
  indent: number;
  text: string;
}

function scan(source: string): Line[] {
  const out: Line[] = [];
  const raw = source.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i]!;
    if (text.includes('\t')) {
      if (text.slice(0, text.search(/\S/) === -1 ? text.length : text.search(/\S/)).includes('\t')) {
        throw new YamlError('tabs cannot be used for indentation', i + 1);
      }
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    out.push({ n: i + 1, indent: text.length - text.trimStart().length, text: trimmed });
  }
  return out;
}

/** Strip a trailing `# comment` from a plain scalar, leaving quoted `#` alone. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i).trimEnd();
  }
  return text;
}

function scalar(raw: string, line: number): YamlValue {
  const text = stripComment(raw).trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith('!!')) {
    throw new YamlError(`"${text.split(/\s/)[0]}" tags are not evaluated by this loader`, line);
  }
  if (text.startsWith('&') || text.startsWith('*')) {
    throw new YamlError('anchors and aliases are not supported', line);
  }
  if (text === '{}') return {};
  if (text === '[]') return [];
  if (text.startsWith('{') || text.startsWith('[')) {
    throw new YamlError('flow style is not supported; use block style', line);
  }
  if ((text.startsWith('"') && text.endsWith('"') && text.length > 1)
    || (text.startsWith("'") && text.endsWith("'") && text.length > 1)) {
    const body = text.slice(1, -1);
    return text[0] === '"' ? body.replace(/\\(["\\nt])/g, (_, c) => ({ '"': '"', '\\': '\\', n: '\n', t: '\t' }[c as string]!)) : body;
  }
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  return text;
}

/** Split `key: value`, respecting quotes. Returns null when the line is not a mapping entry. */
function splitKey(text: string): { key: string; rest: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ':' && (i === text.length - 1 || /\s/.test(text[i + 1]!))) {
      const key = text.slice(0, i).trim().replace(/^['"]|['"]$/g, '');
      return { key, rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

class Parser {
  #lines: Line[];
  #at = 0;
  /** The original text, for block scalars, which need the lines a scan drops. */
  #raw: string[];

  constructor(source: string) {
    this.#lines = scan(source);
    this.#raw = source.split(/\r?\n/);
  }

  parse(): YamlValue {
    if (!this.#lines.length) return null;
    const value = this.#block(this.#lines[0]!.indent);
    if (this.#at < this.#lines.length) {
      throw new YamlError('unexpected content after the document', this.#lines[this.#at]!.n);
    }
    return value;
  }

  #peek(): Line | undefined { return this.#lines[this.#at]; }

  #block(indent: number): YamlValue {
    const line = this.#peek();
    if (!line || line.indent < indent) return null;
    return line.text.startsWith('- ') || line.text === '-'
      ? this.#sequence(indent)
      : this.#mapping(indent);
  }

  #sequence(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      const line = this.#peek();
      if (!line || line.indent !== indent || !(line.text.startsWith('- ') || line.text === '-')) break;
      const rest = line.text === '-' ? '' : line.text.slice(2).trim();
      this.#at += 1;

      if (!rest) { out.push(this.#block(indent + 1) ?? null); continue; }

      const pair = splitKey(rest);
      if (pair) {
        // `- key: value` — an inline mapping whose remaining keys are indented
        // to where the key started.
        const inner = this.#mappingFrom(pair, indent + 2, line);
        out.push(inner);
        continue;
      }
      out.push(scalar(rest, line.n));
    }
    return out;
  }

  #mapping(indent: number): Record<string, YamlValue> {
    const out: Record<string, YamlValue> = {};
    for (;;) {
      const line = this.#peek();
      if (!line || line.indent !== indent) break;
      if (line.text.startsWith('- ')) break;
      const pair = splitKey(line.text);
      if (!pair) throw new YamlError(`expected "key: value"`, line.n);
      this.#at += 1;
      out[pair.key] = this.#valueFor(pair, indent, line);
    }
    return out;
  }

  /** A mapping that began on a sequence line: `- id: x` then more keys below. */
  #mappingFrom(first: { key: string; rest: string }, indent: number, line: Line): Record<string, YamlValue> {
    const out: Record<string, YamlValue> = {};
    out[first.key] = this.#valueFor(first, indent, line);
    const next = this.#peek();
    if (next && next.indent === indent && !next.text.startsWith('- ')) {
      Object.assign(out, this.#mapping(indent));
    }
    return out;
  }

  #valueFor(pair: { key: string; rest: string }, indent: number, line: Line): YamlValue {
    if (pair.rest === '|' || pair.rest === '|-' || pair.rest === '>' || pair.rest === '>-') {
      return this.#blockScalar(pair.rest, indent, line);
    }
    if (pair.rest) return scalar(pair.rest, line.n);
    const next = this.#peek();
    if (!next || next.indent <= indent) return null;
    return this.#block(next.indent);
  }

  /**
   * A block scalar reads from the ORIGINAL lines, because blank lines and
   * comment-looking lines inside one are content, and the scan dropped them.
   */
  #blockScalar(marker: string, indent: number, line: Line): string {
    const body: string[] = [];
    let i = line.n; // 0-based index of the line after this one
    let bodyIndent = -1;
    for (; i < this.#raw.length; i++) {
      const text = this.#raw[i]!;
      const trimmed = text.trim();
      const at = text.length - text.trimStart().length;
      if (trimmed && at <= indent) break;
      if (bodyIndent < 0 && trimmed) bodyIndent = at;
      body.push(trimmed ? text.slice(bodyIndent < 0 ? at : bodyIndent) : '');
    }
    // Advance the scanned cursor past everything the block consumed.
    while (this.#at < this.#lines.length && this.#lines[this.#at]!.n <= i) this.#at += 1;
    while (body.length && body[body.length - 1] === '') body.pop();
    const folded = marker.startsWith('>') ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n');
    return marker.endsWith('-') ? folded : folded + '\n';
  }
}

/**
 * Parse one composition document.
 *
 * @param source — the file's text.
 * @returns the value, or null for an empty document.
 * @throws {YamlError} naming the line, for anything outside the subset.
 */
export function parseYaml(source: string): YamlValue {
  return new Parser(source).parse();
}
