// npm run app: builds the Uncbox app (native/UncboxShell) when it's missing or older than its
// source, then starts it. The app starts the Uncbox server itself if it isn't running. Extra
// arguments go to the app, e.g. npm run app -- --windowed --screen=1.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'native', 'UncboxShell');
const exe = path.join(project, 'bin', 'Release', 'net10.0-windows', 'Uncbox.exe');

if (process.platform !== 'win32') {
  console.error('The Uncbox app is for Windows. Use npm start and a browser here.');
  process.exit(1);
}

/** dotnet on PATH, or the per-user install the dotnet-install script makes. */
function findDotnet() {
  const local = path.join(os.homedir(), '.dotnet', 'dotnet.exe');
  try {
    execFileSync('dotnet', ['--list-sdks'], { stdio: 'pipe' });
    return 'dotnet';
  } catch {
    return existsSync(local) ? local : null;
  }
}

const newestSource = () =>
  Math.max(
    ...readdirSync(project)
      .filter((f) => /\.(cs|csproj|ico)$/.test(f))
      .map((f) => statSync(path.join(project, f)).mtimeMs),
  );

if (!existsSync(exe) || statSync(exe).mtimeMs < newestSource()) {
  const dotnet = findDotnet();
  if (!dotnet) {
    console.error('Building the Uncbox app needs the .NET 10 SDK: https://dotnet.microsoft.com/download');
    process.exit(1);
  }
  console.log('Building the Uncbox app…');
  execFileSync(dotnet, ['build', '-c', 'Release', '-nologo', '-v', 'q', project], { stdio: 'inherit' });
}

const app = spawn(exe, process.argv.slice(2), { detached: true, stdio: 'ignore' });
app.unref();
console.log('Uncbox is starting. It lives in the tray when minimized.');
