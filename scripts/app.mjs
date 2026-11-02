// npm run app: builds the Uncbox app (native/UncboxShell) when it's missing or older than its
// source, then starts it. The app starts the Uncbox server itself if it isn't running. Extra
// arguments go to the app, e.g. npm run app -- --windowed --screen=1.
//
// npm run app:native is the second way to launch: the same app, streaming with Uncbox's own engine
// (engine/) instead of FFmpeg. The engine is built first when it's missing or older than its source.
// Without cargo (Rust) it says how to get it and starts with FFmpeg rather than failing.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEngine, wantsNative } from './engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'native', 'UncboxShell');
const exe = path.join(project, 'bin', 'Release', 'net10.0-windows', 'Uncbox.exe');

if (process.platform !== 'win32') {
  console.error('The Uncbox app is for Windows. Use npm start and a browser here.');
  process.exit(1);
}

/**
 * A dotnet with an SDK: the one on PATH, or the per-user install the dotnet-install script makes.
 * Windows often has a dotnet on PATH with only runtimes, which lists no SDKs but doesn't fail.
 */
function findDotnet() {
  const hasSdk = (dotnet) => {
    try {
      return /^10\./m.test(execFileSync(dotnet, ['--list-sdks'], { stdio: 'pipe', encoding: 'utf8' }));
    } catch {
      return false;
    }
  };
  return ['dotnet', path.join(os.homedir(), '.dotnet', 'dotnet.exe')].find(hasSdk) ?? null;
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

let args = process.argv.slice(2);
if (wantsNative(args)) {
  const engine = ensureEngine();
  if (engine.message) console.warn(engine.message);
  if (!engine.ok) {
    console.warn('Starting with FFmpeg streaming instead.');
    // Later flags win, so this holds even if --engine=native was asked for twice.
    args = [...args, '--engine=ffmpeg'];
  }
}

const app = spawn(exe, args, { detached: true, stdio: 'ignore' });
app.unref();
console.log('Uncbox is starting. It lives in the tray when minimized.');
