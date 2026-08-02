// The condition language (PIVOT-PLAN §5.3).
//
// A hand-written recursive-descent parser and evaluator over a FIXED grammar.
// Zero dependencies (D24), no `eval`, no `new Function`, no library — the DSL's
// whole point is that a flow file is data, and a condition that could execute
// arbitrary JavaScript would quietly turn every .flow.yaml into a program.
//
// The grammar, in full:
//
//   expr    := or
//   or      := and ( 'or' and )*
//   and     := not ( 'and' not )*
//   not     := 'not' not | cmp
//   cmp     := primary ( ('==' | '!=' | '<' | '<=' | '>' | '>=' |
//                         'contains' | 'matches' | 'startsWith' | 'endsWith') primary )?
//   primary := '(' expr ')' | number | string | boolean | 'null' | path
//   path    := ident ( '.' ident | '[' number ']' )*
//
// What it can read is the point. A path resolves against a scope built from the
// run's state: upstream node results, and — this is where the pivot closes its
// own loop — THE METRICS THOSE NODES PRODUCED.
//
//   implement.status == "done"
//   implement.text contains "TODO"
//   implement.cost.total > 0.50
//   implement.usage.outputTokens > 4000
//   review.attempts > 1 and implement.latencyMs > 30000
//
// The investigator's data becomes an input to control flow, so a flow can
// cheapen or escalate itself based on what it just spent.
//
// Everything here is pure and total: `evalExpr` never throws on a bad path (an
// unknown path is null, and null compares false), because a condition failing
// closed is a branch taking its default arm — not a run dying at a typo.

export class ExprError extends Error {}

// --- lexer --------------------------------------------------------------------

const PUNCT = ['(', ')', '[', ']', '.', ',', '==', '!=', '<=', '>=', '<', '>'];
const WORD_OPS = new Set(['and', 'or', 'not', 'contains', 'matches', 'startsWith', 'endsWith']);
const LITERALS = new Map([['true', true], ['false', false], ['null', null]]);

export function tokenize(src) {
  const s = String(src ?? '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    // Strings: single or double quoted, with backslash escapes.
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\' && j + 1 < s.length) { value += s[j + 1]; j += 2; continue; }
        value += s[j]; j++;
      }
      if (j >= s.length) throw new ExprError(`Unterminated string starting at position ${i}`);
      out.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(s.slice(i));
      out.push({ type: 'number', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(s.slice(i));
      const word = m[0];
      if (WORD_OPS.has(word)) out.push({ type: 'op', value: word });
      else if (LITERALS.has(word)) out.push({ type: 'literal', value: LITERALS.get(word) });
      else out.push({ type: 'ident', value: word });
      i += word.length;
      continue;
    }
    const punct = PUNCT.find(p => s.startsWith(p, i));
    if (!punct) throw new ExprError(`Unexpected character "${c}" at position ${i}`);
    out.push({ type: 'punct', value: punct });
    i += punct.length;
  }
  return out;
}

// --- parser ---------------------------------------------------------------------

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=', 'contains', 'matches', 'startsWith', 'endsWith']);

export function parseExpr(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos] ?? null;
  const at = (type, value) => { const t = peek(); return t && t.type === type && (value === undefined || t.value === value); };
  const take = () => tokens[pos++];
  const expect = (type, value) => {
    if (!at(type, value)) throw new ExprError(`Expected ${value ?? type}, got ${describe(peek())}`);
    return take();
  };

  function or() {
    let left = and();
    while (at('op', 'or')) { take(); left = { kind: 'or', left, right: and() }; }
    return left;
  }
  function and() {
    let left = not();
    while (at('op', 'and')) { take(); left = { kind: 'and', left, right: not() }; }
    return left;
  }
  function not() {
    if (at('op', 'not')) { take(); return { kind: 'not', operand: not() }; }
    return cmp();
  }
  function cmp() {
    const left = primary();
    const t = peek();
    const isCmp = t && ((t.type === 'punct' || t.type === 'op') && COMPARISONS.has(t.value));
    if (!isCmp) return left;
    take();
    return { kind: 'cmp', op: t.value, left, right: primary() };
  }
  function primary() {
    if (at('punct', '(')) {
      take();
      const inner = or();
      expect('punct', ')');
      return inner;
    }
    const t = peek();
    if (!t) throw new ExprError('Unexpected end of expression');
    if (t.type === 'number' || t.type === 'string' || t.type === 'literal') {
      take();
      return { kind: 'const', value: t.value };
    }
    if (t.type === 'ident') return path();
    throw new ExprError(`Unexpected ${describe(t)}`);
  }
  function path() {
    const segments = [expect('ident').value];
    for (;;) {
      if (at('punct', '.')) { take(); segments.push(expect('ident').value); continue; }
      if (at('punct', '[')) {
        take();
        const idx = expect('number').value;
        expect('punct', ']');
        segments.push(idx);
        continue;
      }
      break;
    }
    return { kind: 'path', segments };
  }

  if (!tokens.length) throw new ExprError('Empty condition');
  const ast = or();
  if (pos < tokens.length) throw new ExprError(`Unexpected ${describe(peek())} after the end of the expression`);
  return ast;
}

const describe = t => (t ? `${t.type} "${t.value}"` : 'end of expression');

// --- evaluator ---------------------------------------------------------------------

// Every path referenced by an expression, for the linter: a condition naming a
// node that isn't upstream is a condition that will always be null, and the
// user should hear about it at lint time rather than at 2am.
export function referencedPaths(ast) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'path') { out.push(n.segments); return; }
    for (const k of ['left', 'right', 'operand']) if (n[k]) walk(n[k]);
  })(ast);
  return out;
}

function resolve(scope, segments) {
  let v = scope;
  for (const seg of segments) {
    if (v == null) return null;
    v = v[seg];
  }
  return v === undefined ? null : v;
}

// Comparison semantics, chosen to be boring and to fail closed:
//   • numbers compare numerically, strings lexically
//   • a null on either side of an ordering comparison is false, never NaN-ish
//   • `contains` works on strings and arrays
//   • `matches` is a case-insensitive substring test, NOT a regex — a regex in
//     a flow file is a denial-of-service waiting to happen and a thing nobody
//     can read six months later
function compare(op, a, b) {
  switch (op) {
    case '==': return looseEq(a, b);
    case '!=': return !looseEq(a, b);
    case '<': case '<=': case '>': case '>=': {
      if (a == null || b == null) return false;
      const [x, y] = (typeof a === 'number' && typeof b === 'number') ? [a, b] : [String(a), String(b)];
      if (op === '<') return x < y;
      if (op === '<=') return x <= y;
      if (op === '>') return x > y;
      return x >= y;
    }
    case 'contains':
      if (Array.isArray(a)) return a.some(v => looseEq(v, b));
      if (a == null || b == null) return false;
      return String(a).includes(String(b));
    case 'matches':
      if (a == null || b == null) return false;
      return String(a).toLowerCase().includes(String(b).toLowerCase());
    case 'startsWith':
      return a == null || b == null ? false : String(a).startsWith(String(b));
    case 'endsWith':
      return a == null || b == null ? false : String(a).endsWith(String(b));
    default: return false;
  }
}

// `==` compares numbers to numbers and everything else as strings, so
// `attempts == 1` works whether the scope stored 1 or "1". null equals only
// null — a missing value is never accidentally equal to an empty string.
function looseEq(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  return String(a) === String(b);
}

// JS truthiness, minus the surprises: an empty string and 0 are false, an empty
// array is false (it is "nothing", which is what a flow author means).
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

export function evalAst(ast, scope) {
  switch (ast?.kind) {
    case 'const': return ast.value;
    case 'path': return resolve(scope, ast.segments);
    case 'not': return !truthy(evalAst(ast.operand, scope));
    case 'and': return truthy(evalAst(ast.left, scope)) && truthy(evalAst(ast.right, scope));
    case 'or': return truthy(evalAst(ast.left, scope)) || truthy(evalAst(ast.right, scope));
    case 'cmp': return compare(ast.op, evalAst(ast.left, scope), evalAst(ast.right, scope));
    default: return null;
  }
}

// Evaluate a condition to a boolean. Total: a malformed expression is `false`
// with the reason returned alongside, because a branch whose condition cannot
// be read takes its default arm — it does not kill the run.
//
//   evalExpr('a.cost.total > 0.5', scope) -> { value, error }
export function evalExpr(src, scope) {
  let ast;
  try { ast = parseExpr(src); }
  catch (err) { return { value: false, error: String(err.message) }; }
  try { return { value: truthy(evalAst(ast, scope)), error: null }; }
  catch (err) { return { value: false, error: String(err?.message ?? err) }; }
}

// Compile-time check for the linter: is this a well-formed condition, and what
// does it reference? Returns { ok, error, paths }.
export function checkExpr(src) {
  try {
    const ast = parseExpr(src);
    return { ok: true, error: null, paths: referencedPaths(ast) };
  } catch (err) {
    return { ok: false, error: String(err.message), paths: [] };
  }
}
