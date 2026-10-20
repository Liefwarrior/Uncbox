// npm run package: builds a folder (release/Uncbox) and a zip (release/Uncbox-<version>-win-x64.zip)
// that anyone on Windows can run by double-clicking Uncbox.exe, with no Node.js, npm or terminal.
//
//   Uncbox.exe          the app, published self-contained as one file (no .NET install needed)
//   node/node.exe       a portable Node for the server, so nothing has to be installed
//   app/                what the server needs: server/, integrations/wow/, dist/ and a package.json
//
// The app finds node/ and app/ beside itself (native/UncboxShell/ServerHost.cs). Only Node's
// official Windows zip is downloaded, and only after its SHA-256 matches nodejs.org's SHASUMS256.txt.

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The current LTS line (24). Exact on purpose, so every package ships the same Node; bump it by
// hand when a new patch is out. The zip is checked against nodejs.org's own checksum file.
const NODE_VERSION = '24.22.0';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const cache = path.join(release, '.cache');
const out = path.join(release, 'Uncbox');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const zip = path.join(release, `Uncbox-${version}-win-x64.zip`);

if (process.platform !== 'win32') {
  console.error('The Uncbox app is for Windows, so it can only be packaged on Windows.');
  process.exit(1);
}

/** A dotnet with a .NET 10 SDK, found the same way as in scripts/app.mjs. */
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

/** Runs a PowerShell snippet. Paths travel in environment variables, so quoting never matters. */
function powershell(script, env) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function folderSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return total;
}

/** Node's official Windows zip, cached in release/.cache and checked against SHASUMS256.txt. */
async function nodeZip() {
  const name = `node-v${NODE_VERSION}-win-x64.zip`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const get = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  const sums = (await get(`${base}/SHASUMS256.txt`)).toString('utf8');
  const expected = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error(`${name} isn't listed in ${base}/SHASUMS256.txt`);

  mkdirSync(cache, { recursive: true });
  const file = path.join(cache, name);
  if (!existsSync(file) || sha256(file) !== expected) {
    console.log(`Downloading ${name}…`);
    writeFileSync(file, await get(`${base}/${name}`));
  }
  const actual = sha256(file);
  if (actual !== expected) {
    rmSync(file, { force: true });
    throw new Error(`${name} doesn't match nodejs.org's checksum (got ${actual}, expected ${expected}). Not using it.`);
  }
  console.log(`Node ${NODE_VERSION} verified (SHA-256 ${actual.slice(0, 16)}…)`);
  return file;
}

// ---- 1. the page ----
console.log('Building the page…');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

// ---- 2. the app ----
const dotnet = findDotnet();
if (!dotnet) {
  console.error('Packaging the app needs the .NET 10 SDK: https://dotnet.microsoft.com/download');
  process.exit(1);
}
const published = path.join(release, '.publish');
rmSync(published, { recursive: true, force: true });
console.log('Publishing the app…');
execFileSync(
  dotnet,
  [
    'publish', path.join(root, 'native', 'UncboxShell'),
    '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true',
    '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true',
    // No debug symbols: they're only useful to the developer and add several MB.
    '-p:DebugType=none', '-p:DebugSymbols=false',
    '-nologo', '-v', 'q', '-o', published,
  ],
  { stdio: 'inherit' },
);

// ---- 3. the folder ----
const node = await nodeZip();
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'app', 'integrations', 'wow'), { recursive: true });
mkdirSync(path.join(out, 'node'), { recursive: true });

// Publish also leaves symbols and WebView2's documentation files, which nobody needs to run it.
cpSync(published, out, { recursive: true, filter: (src) => !/\.(pdb|xml)$/.test(src) });
cpSync(path.join(root, 'server'), path.join(out, 'app', 'server'), {
  recursive: true,
  filter: (src) => !/\.test\.mjs$/.test(src),
});
cpSync(path.join(root, 'integrations', 'wow', 'install.mjs'), path.join(out, 'app', 'integrations', 'wow', 'install.mjs'));
cpSync(path.join(root, 'integrations', 'wow', 'addon'), path.join(out, 'app', 'integrations', 'wow', 'addon'), { recursive: true });
cpSync(path.join(root, 'dist'), path.join(out, 'app', 'dist'), { recursive: true });
// Only what makes the folder recognisable as Uncbox's: no scripts or dependencies to install.
writeFileSync(
  path.join(out, 'app', 'package.json'),
  JSON.stringify({ name: 'uncbox', private: true, version, type: 'module' }, null, 2) + '\n',
);

// Node's zip holds node-vX-win-x64/ with node.exe, npm and more; the server needs only node.exe.
const unpacked = path.join(cache, `node-v${NODE_VERSION}-win-x64`);
rmSync(unpacked, { recursive: true, force: true });
powershell('Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:DEST -Force', { ZIP: node, DEST: cache });
cpSync(path.join(unpacked, 'node.exe'), path.join(out, 'node', 'node.exe'));
cpSync(path.join(unpacked, 'LICENSE'), path.join(out, 'node', 'LICENSE'));
rmSync(unpacked, { recursive: true, force: true });

// ---- 4. the zip ----
rmSync(zip, { force: true });
powershell('Compress-Archive -LiteralPath $env:SRC -DestinationPath $env:ZIP -CompressionLevel Optimal', { SRC: out, ZIP: zip });
rmSync(published, { recursive: true, force: true });

console.log('');
console.log(`Folder: ${out} (${megabytes(folderSize(out))})`);
console.log(`Zip:    ${zip} (${megabytes(statSync(zip).size)})`);
