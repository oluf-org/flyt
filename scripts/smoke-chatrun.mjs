// Browser smoke check for the chat-run surface (CHAT-RUN rework). Boots vite
// with the dev mock, drives the lander composer into a chat run inside a
// HIDDEN Electron window (the same Chromium the app ships with), and captures
// screenshots of (1) the blocking approval dialog and (2) the node feed with
// the summary sidebar open. Kills every process it spawns on exit.
//
// Usage: node scripts/smoke-chatrun.mjs
import { spawn } from 'node:child_process';

const VITE_PORT = 5199;

const wait = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* not up yet */ }
    await wait(250);
  }
  return false;
}

let vite = null;
let electron = null;
function cleanup() {
  try { vite?.kill(); } catch { /* already gone */ }
  try { electron?.kill(); } catch { /* already gone */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

vite = spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', '--port', String(VITE_PORT), '--strictPort'],
  { stdio: 'ignore' });
if (!await waitFor(`http://localhost:${VITE_PORT}/`)) throw new Error('vite never came up');

electron = spawn(process.execPath,
  ['node_modules/electron/cli.js', 'scripts/smoke-electron-main.cjs'],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, SMOKE_URL: `http://localhost:${VITE_PORT}/` }
  });
electron.stdout.on('data', d => process.stdout.write(d));
const code = await new Promise(res => electron.on('exit', res));
console.log(`electron capture exited with ${code}`);
process.exit(code ?? 1);
