import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'kernel', 'native', 'windows', 'Flyt.Sandbox.Runner', 'Flyt.Sandbox.Runner.csproj');
const options = { cwd: root, stdio: 'inherit', windowsHide: true };
try {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], {
    windowsHide: true, encoding: 'utf8',
  }).trim();
  if (!installation) throw new Error('Windows sandbox build requires Visual Studio C++ build tools (v143 and Windows SDK)');
  const msbuild = path.join(installation, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
  const pipes = path.join(root, 'kernel', 'native', 'windows', 'Flyt.Sandbox.Pipes');
  for (const platform of ['x64', 'Win32']) {
    execFileSync(msbuild, [path.join(pipes, 'Flyt.Sandbox.Pipes.vcxproj'), '/p:Configuration=Release', `/p:Platform=${platform}`, '/verbosity:minimal', '/nologo'], options);
  }
  execFileSync('dotnet', ['publish', project, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '/p:PublishSingleFile=true'], options);
  const output = path.join(path.dirname(project), 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish');
  for (const [platform, bits] of [['x64', 64], ['Win32', 32]]) {
    const name = `flyt-sandbox-pipes${bits}.dll`;
    fs.copyFileSync(path.join(pipes, 'bin', platform, 'Release', name), path.join(output, name));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
