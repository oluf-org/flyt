import { execSync } from 'node:child_process';

// electron-builder is also invoked directly by CI and by developers. Keep the
// build at the packager boundary so no invocation can combine current stack
// seeds with an older compiled kernel (or an older renderer).
export default function buildBeforePack(context) {
  execSync('npm run build', {
    cwd: context.packager.projectDir,
    env: process.env,
    stdio: 'inherit',
  });
}
