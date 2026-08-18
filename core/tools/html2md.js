// HTML → readable text, hand-rolled and dependency-free (D24).
//
// This is not a parser and does not pretend to be one. It is a REDUCER: strip
// the parts that are never prose, turn the handful of tags that carry structure
// into the markdown equivalent, unwrap everything else, and collapse the
// whitespace. A model reading a fetched page wants the sentences and the links;
// it does not want a DOM, and paying a dependency for one would buy accuracy on
// pathological markup that nothing here depends on.
//
// Where it is wrong it is wrong in the safe direction: unknown markup becomes
// its own text content rather than disappearing.

// Never prose, and actively harmful in a model's context: script bodies are
// code the model may follow, style bodies are noise measured in kilobytes.
const DROP = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'head'];

// Tags whose boundaries are paragraph breaks.
const BLOCK = [
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'ul', 'ol', 'table', 'tr', 'blockquote', 'pre', 'form', 'figure', 'hr'
];

export function htmlToText(html, { maxChars = 100_000 } = {}) {
  let s = String(html ?? '');

  // Comments and doctype first: a comment can contain anything, including a
  // fake closing tag, so it has to go before any tag matching.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!doctype[^>]*>/gi, '');

  // The title, before <head> is dropped — it is often the only statement of
  // what the page IS.
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? '').trim();

  for (const tag of DROP) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    // An unclosed <script> would otherwise leave its whole body behind.
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }

  // Structure worth keeping, innermost meaning first.
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, body) => `\n\n${'#'.repeat(Number(n))} ${inline(body)}\n\n`);
  s = s.replace(/<li[^>]*>([\s\S]*?)(?=<\/li>|<li\b|<\/[uo]l>)/gi, (_m, body) => `\n- ${inline(body)}`);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Links: the href is half the value of a fetched page — it is how the next
  // call knows where to go.
  s = s.replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, body) => {
    const text = inline(body).trim();
    if (!text) return '';
    return /^https?:/i.test(href) ? `[${text}](${href})` : text;
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => `**${inline(body)}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => `*${inline(body)}*`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, body) => `\`${inline(body)}\``);
  s = s.replace(/<t[dh]\b[^>]*>/gi, ' | ');

  for (const tag of BLOCK) {
    s = s.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '\n\n');
  }

  // Everything else: unwrap. An unknown tag's CONTENT is kept — dropping it
  // would silently lose prose inside markup this reducer has not heard of.
  s = s.replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s);

  // Collapse: spaces and tabs within a line, then runs of blank lines.
  s = s.split('\n').map(line => line.replace(/[ \t ]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  const text = title && !s.startsWith(`# ${title}`) ? `# ${title}\n\n${s}` : s;
  return text.length <= maxChars
    ? { title: title || null, text, truncated: false }
    : { title: title || null, text: text.slice(0, maxChars), truncated: true, chars: text.length };
}

// Inline content of a tag we are rewriting: drop nested markup, keep the words.
function inline(body) {
  return decodeEntities(String(body).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// The entities that actually appear in prose, plus numeric ones. A full table
// would be four hundred lines to correctly render the ones nobody writes.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", copy: '©', reg: '®',
  trade: '™', deg: '°', middot: '·', bull: '•', laquo: '«', raquo: '»', times: '×'
};

export function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}
