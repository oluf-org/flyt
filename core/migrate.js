// One-shot on-disk migrations for the D29 rename.
//
// This lives in core/ rather than inline in electron/main.js for one reason:
// it is the only code in the rename that can destroy user data, and its failure
// mode is silent — a wrong guard doesn't crash, it just starts the app with an
// empty profile and the user's API keys apparently gone. Taking Electron's
// paths as arguments makes it a pure fs function that tests can drive against a
// temp directory (tests/migrate.test.js).
import fs from 'node:fs';
import path from 'node:path';

/**
 * Move a pre-rename userData directory to its new location, once.
 *
 * Electron derives userData from the app name, so renaming the app orphans the
 * old directory: settings.json, the project registry, and the seeded flows all
 * stay behind at a path nothing reads any more.
 *
 * @param {object} opts
 * @param {string} opts.appDataRoot  the platform app-data root (Electron's 'appData')
 * @param {string} opts.userDataDir  the CURRENT userData path
 * @param {string[]} opts.legacyNames  directory names to look for, in priority order
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ migrated: boolean, from?: string, reason?: string }}
 */
export function migrateUserDataDir({ appDataRoot, userDataDir, legacyNames, log = () => {} }) {
  for (const name of legacyNames ?? []) {
    const legacy = path.join(appDataRoot, name);
    // Guard the degenerate case where the "legacy" name resolves to the current
    // directory (nothing actually changed) — renaming a directory onto itself
    // is at best a no-op and at worst a way to lose it.
    if (path.resolve(legacy) === path.resolve(userDataDir)) continue;
    if (!fs.existsSync(legacy)) continue;

    // Only ever move into nothing. A userData directory that already has
    // content means this install has post-rename state, and the legacy
    // directory is a leftover — overwriting the new one would be exactly the
    // data loss this function exists to prevent. Electron may have created the
    // directory empty already, which is why "exists" is not the test.
    if (fs.existsSync(userDataDir)) {
      let entries;
      try { entries = fs.readdirSync(userDataDir); }
      catch (err) { return { migrated: false, reason: err.message }; }
      if (entries.length) {
        // Refusing is right — but silence here is how a user concludes their
        // settings were deleted. They weren't: the old profile is intact at
        // `legacy`, the app is simply reading a different directory. Say so,
        // with both paths, because the fix is a manual move and the user needs
        // to know which way round it goes.
        log(`found a pre-rename profile at ${legacy}, but ${userDataDir} already has data — `
          + 'keeping the current one. Nothing was deleted; move the old directory into place by '
          + 'hand if its settings are the ones you want.');
        return { migrated: false, reason: 'current userData is not empty', legacy };
      }
      try { fs.rmdirSync(userDataDir); }
      catch (err) { return { migrated: false, reason: err.message }; }
    }

    try {
      fs.renameSync(legacy, userDataDir);
      log(`migrated userData: ${legacy} → ${userDataDir}`);
      return { migrated: true, from: legacy };
    } catch (err) {
      // Cross-device, locked by another process, permissions — report and stop
      // rather than trying the next candidate, which would be a second guess at
      // the same broken filesystem state.
      log(`could not migrate ${legacy}: ${err.message}`);
      return { migrated: false, reason: err.message };
    }
  }
  return { migrated: false, reason: 'no legacy directory found' };
}
