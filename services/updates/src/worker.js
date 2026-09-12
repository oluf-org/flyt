import { STATE_KEY, CHANNELS, PLATFORMS, MANIFESTS, emptyState, validateState, validateRelease, releaseKey, assetKey, validVersion, validFilename, stableEligible, updateEligible } from './model.js';

const baseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag, Accept-Ranges, Content-Disposition',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};
/** @param {unknown} data @param {number} [status] @param {HeadersInit} [extra] */
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
/** @param {string} code @param {number} status */
function error(code, status) { return json({ error: { code } }, status); }
/** @param {R2Bucket} bucket @param {string} key */
async function readJson(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  if (obj.size > 1024 * 1024) { await obj.body.cancel(); throw new Error('Metadata exceeds 1 MiB'); }
  return obj.json();
}
/** @param {R2Bucket} bucket @param {string} version @param {import('./model.js').Platform} platform */
async function readRelease(bucket, version, platform) {
  const data = await readJson(bucket, releaseKey(version, platform));
  if (!data) throw new Error('Published release missing');
  const release = validateRelease(/** @type {import('./model.js').Release} */ (data));
  if (release.version !== version || release.platform !== platform) throw new Error('Release identity mismatch');
  return release;
}
/** @param {string} origin @param {string} channel @param {import('./model.js').Release} release @param {string} name */
function downloadUrl(origin, channel, release, name) {
  return `${origin}/${channel}/releases/${release.version}/${release.platform}/${encodeURIComponent(name)}`;
}
/** @param {Request} request @param {Env} env */
async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: baseHeaders });
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: { code: 'method_not_allowed' } }, 405, { Allow: 'GET, HEAD, OPTIONS' });
  if (url.pathname === '/healthz') {
    await env.RELEASES.head(STATE_KEY); // Check the binding; an empty bucket is a healthy initial deployment.
    return json({ ok: true, service: 'flyt-updates', schemaVersion: 1 });
  }
  const api = /^\/v1\/releases\/(stable|beta)$/.exec(url.pathname);
  const feed = /^\/(stable|beta)\/(latest(?:-mac|-linux)?\.yml)$/.exec(url.pathname);
  const asset = /^\/(stable|beta)\/releases\/([^/]+)\/(windows|mac|linux)\/([^/]+)$/.exec(url.pathname);
  if (!api && !feed && !asset) return error('not_found', 404);
  const state = validateState(/** @type {import('./model.js').State} */ (await readJson(env.RELEASES, STATE_KEY)) ?? emptyState());
  const channel = /** @type {import('./model.js').Channel} */ ((api || feed || asset)?.[1]);
  if (!CHANNELS.includes(channel)) return error('not_found', 404);
  const selections = state.channels[channel];
  if (api) {
    const platforms = await Promise.all(PLATFORMS.map(async platform => {
      const version = selections[platform].current;
      if (!version) return { platform, available: false, reason: 'not_published' };
      const release = await readRelease(env.RELEASES, version, platform);
      if (channel === 'stable' && !stableEligible(release)) throw new Error('Ineligible stable release');
      return { platform, available: true, version, releasedAt: release.createdAt, notes: release.notes,
        distribution: 'direct', signing: release.signing, autoUpdateAvailable: updateEligible(release),
        downloads: release.assets.filter(a => /\.(exe|dmg|zip|AppImage)$/.test(a.name)).map(a => ({ ...a, url: downloadUrl(url.origin, channel, release, a.name) })) };
    }));
    return json({ schemaVersion: 1, channel, revision: state.revision, platforms });
  }
  if (feed) {
    const platform = PLATFORMS.find(p => MANIFESTS[p] === feed[2]);
    if (!platform || !selections[platform].current) return error('not_published', 404);
    const release = await readRelease(env.RELEASES, /** @type {string} */ (selections[platform].current), platform);
    if (channel === 'stable' && !stableEligible(release)) throw new Error('Ineligible stable release');
    if (!updateEligible(release)) return error('signing_required', 409);
    const manifest = { ...release.manifest, files: release.manifest.files.map(f => ({ ...f, url: downloadUrl(url.origin, channel, release, f.url) })) };
    manifest.path = manifest.files[0].url;
    manifest.sha512 = manifest.files[0].sha512;
    // JSON is valid YAML; preserve the electron-builder schema without a runtime YAML dependency.
    return new Response(JSON.stringify(manifest), { headers: { ...baseHeaders, 'Content-Type': 'application/yaml; charset=utf-8' } });
  }
  if (!asset) return error('not_found', 404);
  const [, , version, platformValue, name] = asset;
  const platform = /** @type {import('./model.js').Platform} */ (platformValue);
  if (!validVersion(version) || !validFilename(name) || !selections[platform].versions.includes(version)) return error('not_found', 404);
  const release = await readRelease(env.RELEASES, version, platform);
  if (channel === 'stable' && !stableEligible(release)) throw new Error('Ineligible stable release');
  const info = release.assets.find(a => a.name === name);
  if (!info) return error('not_found', 404);
  const key = assetKey(version, platform, name);
  const obj = await env.RELEASES.head(key);
  if (!obj || obj.size !== info.size) throw new Error('Published asset missing or truncated');
  const headers = new Headers({ ...baseHeaders, 'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name}"`, 'Accept-Ranges': 'bytes',
    ETag: obj.httpEtag, 'Content-Length': String(obj.size) });
  // Authorize against channel history on every request. no-store makes withdrawal effective.
  if (request.headers.get('If-None-Match')?.split(',').map(s => s.trim()).some(s => s === '*' || s === obj.httpEtag)) {
    headers.delete('Content-Length'); return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') return new Response(null, { headers });
  let range;
  const rawRange = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  if (rawRange && (!ifRange || ifRange === obj.httpEtag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
    let start = 0, end = obj.size - 1;
    if (!m || (!m[1] && !m[2])) return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${obj.size}` } });
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
    else { const suffix = Number(m[2]); if (suffix === 0) start = obj.size; else start = Math.max(0, obj.size - suffix); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= obj.size || start > end) return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${obj.size}` } });
    range = { offset: start, length: end - start + 1 };
    headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
    headers.set('Content-Length', String(range.length));
  }
  const body = await env.RELEASES.get(key, { range, onlyIf: { etagMatches: obj.etag } });
  if (!body || !('body' in body)) throw new Error('Asset changed during download');
  return new Response(body.body, { status: range ? 206 : 200, headers });
}

export default {
  /** @param {Request} request @param {Env} env */
  async fetch(request, env) {
    try {
      const response = await route(request, env);
      if (request.method === 'HEAD' && response.body) { await response.body.cancel(); return new Response(null, response); }
      return response;
    } catch (err) {
      console.error(JSON.stringify({ event: 'updates.request_failed', message: err instanceof Error ? err.message : 'Unknown error' }));
      const response = error('service_unavailable', 503);
      return request.method === 'HEAD' ? new Response(null, response) : response;
    }
  },
};
