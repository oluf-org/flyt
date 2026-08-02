// http_fetch: make one HTTP request (TOOLS-PLAN §14.3).
//
// The generic network tool the declarative `provider: http` tools (P5) will
// generalize — and they share the policy in net.js, so there is one answer to
// "where may a run connect to" rather than one per tool. Private space is
// denied, the resolved address is pinned, redirects are re-checked, and the
// body is capped.
//
// `network` effect, `caution` risk: not gated by the approval prompt (an
// outbound request is bounded by policy, not by asking), but never
// auto-executing inside code mode either.
import { guardedFetch, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES } from './net.js';

const MAX_TIMEOUT_MS = 60_000;

export default {
  name: 'http_fetch',
  title: 'Fetch a URL',
  description: 'Make an HTTP request and return the status, headers and body (text, truncated if large). Public http/https only — requests into private network space are refused. Use this to read a page or call a public API.',
  effects: ['network'],
  risk: 'caution',
  autoExecute: true,
  keywords: ['http', 'fetch', 'url', 'web', 'request', 'api', 'download', 'page'],
  examples: ['fetch the changelog page', 'call the public status API'],
  // Response bodies are long and read from the top; the artifact keeps all of it.
  result: { preview: 'json', maxPreviewChars: 3000, artifact: true },
  parameters: {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', description: 'Absolute http/https URL.' },
      method: { enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET).' },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Request headers. Do not put credentials here — see the tool library for authenticated HTTP tools.'
      },
      body: { type: 'string', description: 'Request body for POST/PUT/PATCH.' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: `Wall-clock timeout (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` }
    }
  },
  async run(args, ctx) {
    const method = args.method ?? 'GET';
    const res = await guardedFetch(args.url, {
      method,
      headers: {
        'user-agent': ctx?.userAgent ?? 'Flyt/1.0 (+https://github.com/olaaxe/flyt)',
        accept: '*/*',
        ...sanitizeHeaders(args.headers)
      },
      body: args.body ?? null,
      timeoutMs: Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      maxBytes: DEFAULT_MAX_BYTES,
      // Per-tool escape hatch (§10.2). http_fetch itself never gets it: a
      // localhost target is a declarative tool's decision, made once by a
      // human, not something a model can talk its way into per call.
      allowPrivate: false
    });
    return {
      url: res.url, status: res.status, ok: res.ok,
      contentType: res.headers['content-type'] ?? null,
      body: res.body,
      bytes: res.bytes,
      ...(res.truncated ? { truncated: true } : {}),
      ...(res.redirects ? { redirects: res.redirects } : {})
    };
  }
};

// Header injection: a CR or LF in a value can forge a second header, and the
// values here come from a model that read untrusted tool output. Rejected
// outright rather than stripped — silently changing a request is worse than
// refusing it.
function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const value = String(v);
    if (/[\r\n]/.test(value) || /[\r\n:]/.test(k)) {
      throw new Error(`Header "${k}" contains a line break — refused.`);
    }
    out[k.toLowerCase()] = value;
  }
  return out;
}
