// Launch the production Electron app under a separate profile and home.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER;
const child = spawn(require('electron'), [fileURLToPath(new URL('./profile-electron.mjs', import.meta.url))], { env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
