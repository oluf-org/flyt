// The local HTTP front door (DESIGN-SPEC.md §8).
//
// Same command map as IPC (core/api.js), reachable from a terminal, a script,
// or an AI. `POST /api/<command>` with a JSON body, `GET /api/events` for the
// live stream the Electron viewer and the supervisor both consume.
//
// Security posture, decided in DESIGN-SPEC.md §5 and unchanged here: loopback
// only, and a bearer token required EVEN ON LOOPBACK. Any local process can
// reach 127.0.0.1 — every other program on the machine, every npm postinstall,
// every browser tab via a form post. "It's only localhost" is not an
// authentication story for a service that can run shell commands in a repo.
//
// Zero dependencies (D24): node:http, hand-rolled SSE, hand-rolled routing.
import http from 'node:http';
import crypto from 'node:crypto';
import { ApiError } from './api.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024; // a flow payload, not a file upload

export function createServer({ api, token = null, host = '127.0.0.1', log = () => {} }) {
  // A token is generated when none is supplied, never omitted. A default of
  // "no auth" is the kind of default that ends up in production.
  const authToken = token || crypto.randomBytes(24).toString('base64url');
  const clients = new Set(); // live SSE responses

  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      // This is a local API for programs, not a site. Nothing here is meant to
      // be reachable from a page the user happens to have open.
      'access-control-allow-origin': 'null',
      'cache-control': 'no-store'
    });
    res.end(text);
  };

  // Constant-time compare so a token cannot be recovered a byte at a time.
  const authorized = req => {
    const raw = req.headers.authorization ?? '';
    const given = raw.startsWith('Bearer ') ? raw.slice(7) : '';
    const a = Buffer.from(given);
    const b = Buffer.from(authToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const readBody = req => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError('Request body too large.', { status: 413, code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch { reject(new ApiError('Body was not valid JSON.', { status: 400, code: 'bad_json' })); }
    });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    // Unauthenticated: whether a supervisor is up at all. Deliberately says
    // nothing else — no project list, no run ids, no version fingerprint
    // beyond the name a client needs to know it found the right process.
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true, service: 'flyt' });
    }

    if (!authorized(req)) {
      return send(res, 401, { error: 'Unauthorized. Pass the bearer token.', code: 'unauthorized' });
    }

    // The event stream: every engine emit, forwarded verbatim. The viewer
    // applies run:update patches exactly as the renderer does over IPC — same
    // payloads, same rev/base contract, so one implementation feeds both.
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/commands') {
      return send(res, 200, { commands: api.names() });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/'.length));
      try {
        const args = await readBody(req);
        return send(res, 200, { ok: true, result: await api.invoke(name, args) });
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 500;
        const code = err instanceof ApiError ? err.code : 'error';
        // The message is the useful half for a CLI or an agent; the stack stays
        // in the log where a human can read it.
        if (status === 500) log(`${name} failed: ${err.stack ?? err.message}`);
        return send(res, status, { ok: false, error: String(err.message ?? err), code });
      }
    }

    send(res, 404, { error: `No route ${req.method} ${url.pathname}`, code: 'no_route' });
  });

  // Engine events in, SSE frames out. A dead client is dropped rather than
  // retried: it will reconnect and resync via run:snapshot, which re-baselines
  // its diff channel anyway.
  const emit = (type, payload) => {
    if (!clients.size) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  };

  return {
    emit,
    token: authToken,
    hasClients: () => clients.size > 0,
    listen: (port = 0) => new Promise(resolve => {
      server.listen(port, host, () => {
        const { port: bound } = server.address();
        log(`listening on http://${host}:${bound}`);
        resolve({ port: bound, host, token: authToken });
      });
    }),
    close: () => new Promise(resolve => {
      for (const res of clients) { try { res.end(); } catch { /* already gone */ } }
      clients.clear();
      server.close(resolve);
    })
  };
}
