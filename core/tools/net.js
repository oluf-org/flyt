// Network policy for outbound tool requests (TOOLS-PLAN §10.2), closing the
// "network policy for HTTP tools" item DESIGN-SPEC §9 left open.
//
// The threat is not an agent browsing the web; it is an agent that was TOLD to
// fetch something by a tool result it does not control. So:
//
//   1. Deny-by-default to private space — loopback, RFC1918, link-local
//      (including cloud metadata at 169.254.169.254), and .local names.
//      Overridable per tool with an explicit allowPrivate, because a local dev
//      server is a real use case and a blanket ban just gets switched off.
//   2. RESOLVE THEN PIN. The hostname is resolved, the resolved address is
//      checked, and the request connects to THAT address with the original
//      Host header. This closes DNS rebinding, where a name passes the check
//      and then resolves somewhere else a moment later.
//   3. Redirects are re-checked at every hop and capped.
//   4. Responses are streamed and truncated at a byte cap, never buffered
//      whole — a tool must not be able to exhaust memory by asking for a
//      large file.
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

// Private / link-local / loopback space, by IP. Names are handled by resolving
// them first — the point of the policy is what you actually CONNECT to.
export function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;   // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                  // multicast / reserved
    return false;
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (ip6 === '::1' || ip6 === '::') return true;
    if (ip6.startsWith('fc') || ip6.startsWith('fd')) return true; // unique-local
    if (ip6.startsWith('fe80')) return true;                        // link-local
    // ::ffff:10.0.0.1 — an IPv4 address wearing an IPv6 hat.
    const mapped = ip6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

// Resolve a URL's host and decide whether the request may proceed. Returns
// { ok, address, family } or { ok: false, reason }.
export async function checkTarget(url, { allowPrivate = false, allowedHosts = null, resolver = dns } = {}) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { ok: false, reason: `"${url}" is not a valid URL` }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `only http and https are allowed (got "${parsed.protocol.replace(':', '')}")` };
  }
  // An allowlist beats a denylist when the author knows the answer.
  if (allowedHosts?.length && !allowedHosts.some(h => hostMatches(parsed.hostname, h))) {
    return { ok: false, reason: `host "${parsed.hostname}" is not in this tool's allowedHosts` };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (!allowPrivate && LOCAL_NAME.test(host)) {
    return { ok: false, reason: `"${host}" resolves inside private network space; set allowPrivate on the tool to permit it` };
  }

  // A literal address needs no lookup — and must not get one, or a hostile
  // "127.0.0.1" would be a DNS query rather than a check.
  if (net.isIP(host)) {
    if (!allowPrivate && isPrivateAddress(host)) {
      return { ok: false, reason: `${host} is in private network space; set allowPrivate on the tool to permit it` };
    }
    return { ok: true, address: host, family: net.isIP(host), hostname: parsed.hostname };
  }

  let records;
  try { records = await resolver.lookup(host, { all: true }); }
  catch (err) { return { ok: false, reason: `could not resolve "${host}": ${err.code ?? err.message}` }; }
  if (!records.length) return { ok: false, reason: `"${host}" did not resolve` };
  // EVERY answer must pass: a name that resolves to one public and one private
  // address is a rebinding attempt, not a coincidence.
  const bad = records.find(r => isPrivateAddress(r.address));
  if (bad && !allowPrivate) {
    return { ok: false, reason: `"${host}" resolves to ${bad.address}, which is in private network space` };
  }
  return { ok: true, address: records[0].address, family: records[0].family, hostname: parsed.hostname };
}

function hostMatches(hostname, pattern) {
  const h = hostname.toLowerCase();
  const p = String(pattern).toLowerCase();
  return p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p;
}

// Fetch with the policy applied at every hop. Returns
// { status, headers, body, bytes, truncated, url } — body as text, capped.
//
// node:http/https rather than fetch(), for one reason: `lookup`. Passing a
// lookup that returns ONLY the address we vetted is what makes this a PIN
// rather than a check — global fetch would resolve the name a second time, and
// the gap between the two resolutions is exactly the DNS-rebinding window.
// TLS SNI and the Host header still carry the hostname, so pinning is
// invisible to the server.
export async function guardedFetch(url, {
  method = 'GET', headers = {}, body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES,
  allowPrivate = false, allowedHosts = null, resolver = dns, request = null
} = {}) {
  let current = url;
  const chain = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await checkTarget(current, { allowPrivate, allowedHosts, resolver });
    if (!check.ok) throw new Error(`Blocked by network policy: ${check.reason}`);
    chain.push(current);

    const res = await sendPinned(current, {
      method, headers, body, timeoutMs, maxBytes,
      address: check.address, family: check.family, request
    });

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      // Re-checked on the next pass of the loop: a redirect into private space
      // is the classic way past a check that only looked at the first URL.
      current = new URL(res.headers.location, current).toString();
      // A redirected request must not replay a body or a method that had one.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'HEAD')) {
        method = 'GET';
        body = null;
      }
      continue;
    }
    return {
      url: current,
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      headers: res.headers,
      body: res.text,
      bytes: res.bytes,
      ...(res.truncated ? { truncated: true } : {}),
      ...(chain.length > 1 ? { redirects: chain.slice(0, -1) } : {})
    };
  }
  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
}

function sendPinned(url, { method, headers, body, timeoutMs, maxBytes, address, family, request }) {
  const target = new URL(url);
  const transport = request ?? (target.protocol === 'https:' ? https.request : http.request);
  return new Promise((resolve, reject) => {
    const req = transport({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers: { host: target.host, ...headers },
      // The pin: whatever the name resolved to a moment ago is where this
      // connection goes, and nothing gets to resolve it again.
      lookup: (_host, _opts, cb) => cb(null, address, family === 6 ? 6 : 4)
    }, res => {
      const chunks = [];
      let total = 0;
      let truncated = false;
      res.on('data', chunk => {
        if (truncated) return;
        total += chunk.length;
        if (total > maxBytes) {
          chunks.push(chunk.slice(0, chunk.length - (total - maxBytes)));
          truncated = true;
          res.destroy();     // stop the transfer; do not buffer what we can't use
          return;
        }
        chunks.push(chunk);
      });
      const finish = () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: buf.toString('utf8'),
          bytes: buf.byteLength,
          truncated
        });
      };
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', err => reject(new Error(`Response failed: ${err.message}`)));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs} ms`));
    });
    req.on('error', err => reject(new Error(`Request failed: ${err.message}`)));
    if (body != null) req.write(body);
    req.end();
  });
}
