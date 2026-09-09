import path from 'node:path';
import fs from 'node:fs';
import { statFile, uncache } from '@electron/asar';

// Files whose absence produces a package that starts but cannot provide the
// product described by the source tree. electron-builder already checks the
// entry point; this list checks the renderer, kernel, seeds, catalogs, and the
// runtime window icon as one completed app.asar.
export const REQUIRED_PACKAGE_ENTRIES = Object.freeze([
  'package.json',
  'config.json',
  'THIRD-PARTY-NOTICES.txt',
  'dist/index.html',
  'electron/main.js',
  'electron/preload.cjs',
  'kernel/dist/index.js',
  'core/engine.js',
  'core/readWorker.js',
  'core/readWorkerClient.js',
  'src/flowTypes.js',
  'stacks/loop-task.stack.yaml',
  'stacks/pipeline.stack.yaml',
  'plugins/index.json',
  'tools/bash.json',
  'build/icon.png',
  'node_modules/impeccable-flyt-plugin/package.json',
]);

export function verifyPackagedArchive(archive) {
  const missing = [];
  try {
    for (const entry of REQUIRED_PACKAGE_ENTRIES) {
      try {
        // ASAR records use the separator of the platform that created them.
        statFile(archive, entry.split('/').join(path.sep));
      } catch {
        missing.push(entry);
      }
    }
  } finally {
    // @electron/asar caches archive handles; release ours so a subsequent
    // package build can replace app.asar in the same output directory.
    uncache(archive);
  }
  if (missing.length) {
    throw new Error(`Packaged app is missing required files:\n- ${missing.join('\n- ')}`);
  }
}

export default async function verifyPackagedApp(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const archive = path.join(resources, 'app.asar');
  verifyPackagedArchive(archive);
  if (context.electronPlatformName === 'win32') {
    const runner = path.join(resources, 'flyt-sandbox-win.exe');
    try { fs.accessSync(runner); }
    catch { throw new Error(`Packaged app is missing the Windows sandbox runner: ${runner}`); }
  }
  console.log(`  • verified packaged app  requiredFiles=${REQUIRED_PACKAGE_ENTRIES.length}`);
}
