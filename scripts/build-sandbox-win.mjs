import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'kernel', 'native', 'windows', 'Flyt.Sandbox.Runner', 'Flyt.Sandbox.Runner.csproj');
const child = spawn('dotnet', ['publish', project, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '/p:PublishSingleFile=true'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
