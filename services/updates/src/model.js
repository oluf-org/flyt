/** @typedef {'windows'|'mac'|'linux'} Platform */
/** @typedef {'stable'|'beta'} Channel */
/** @typedef {{name:string,size:number,sha512:string}} Asset */
/** @typedef {{version:string,files:Array<{url:string,sha512:string,size:number}>,path?:string,sha512?:string,releaseDate?:string}} Manifest */
/** @typedef {{schemaVersion:1,version:string,platform:Platform,commit:string,runId:string,createdAt:string,notes:string,signing:'not-configured'|'not-applicable',assets:Asset[],manifest:Manifest}} Release */
/** @typedef {{current:string|null,versions:string[]}} Selection */
/** @typedef {{schemaVersion:1,revision:string,channels:Record<Channel,Record<Platform,Selection>>}} State */
export const PLATFORMS = /** @type {const} */ (['windows', 'mac', 'linux']);
export const CHANNELS = /** @type {const} */ (['stable', 'beta']);
export const MANIFESTS = { windows: 'latest.yml', mac: 'latest-mac.yml', linux: 'latest-linux.yml' };
export const STATE_KEY = 'flyt/channels.json';
/** @param {string} value */
export function validVersion(value) { return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value); }
/** @param {string} value */
export function validFilename(value) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value); }
/** @param {string} version @param {string} platform */
export function releaseKey(version, platform) { return `flyt/releases/${version}/${platform}/release.json`; }
/** @param {string} version @param {string} platform @param {string} name */
export function assetKey(version, platform, name) { return `flyt/releases/${version}/${platform}/${name}`; }
/** @returns {State} */
export function emptyState() {
  const selections = () => ({ windows: { current: null, versions: [] }, mac: { current: null, versions: [] }, linux: { current: null, versions: [] } });
  return { schemaVersion: 1, revision: 'initial', channels: { stable: selections(), beta: selections() } };
}
/** @param {State} state */
export function validateState(state) {
  if (state.schemaVersion !== 1 || typeof state.revision !== 'string') throw new Error('Invalid channel state');
  for (const channel of CHANNELS) for (const platform of PLATFORMS) {
    const s = state.channels?.[channel]?.[platform];
    if (!s || !Array.isArray(s.versions) || s.versions.some(v => !validVersion(v)) ||
      (s.current !== null && !s.versions.includes(s.current))) throw new Error('Invalid channel selection');
  }
  return state;
}
/** @param {Release} release */
export function validateRelease(release) {
  if (release.schemaVersion !== 1 || !validVersion(release.version) || !PLATFORMS.includes(release.platform) ||
      !/^[a-f0-9]{40}$/.test(release.commit) || typeof release.notes !== 'string' || release.notes.length > 50000 ||
      !['not-configured', 'not-applicable'].includes(release.signing) ||
      !Array.isArray(release.assets) || release.assets.length === 0 || release.assets.length > 100) throw new Error('Invalid release record');
  const names = new Set();
  for (const file of release.assets) {
    if (!validFilename(file.name) || names.has(file.name) || !Number.isSafeInteger(file.size) || file.size <= 0 ||
        !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) throw new Error('Invalid asset');
    names.add(file.name);
  }
  if (release.manifest?.version !== release.version || !Array.isArray(release.manifest.files) || !release.manifest.files.length) throw new Error('Invalid manifest');
  for (const file of release.manifest.files) {
    const asset = release.assets.find(a => a.name === file.url);
    if (!asset || asset.sha512 !== file.sha512 || asset.size !== file.size) throw new Error('Manifest/asset mismatch');
  }
  return release;
}
/** Signing integrations must supply verified evidence before this policy is expanded. @param {Release} release */
export function stableEligible(release) { return release.platform === 'linux' && release.signing === 'not-applicable'; }
/** @param {Release} release */
export function updateEligible(release) { return release.platform !== 'mac'; }
