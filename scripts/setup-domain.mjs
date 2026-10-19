// `npm run setup-domain` makes Uncbox open at https://unc.box; `npm run remove-domain` undoes it.
// The work is in setup-domain.ps1, run with admin rights (Windows asks once) because it edits the
// hosts file and the machine's trusted certificates.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const remove = process.argv.includes('--remove');
const dataArg = process.argv.find((a) => a.startsWith('--data='));
const dataDir = dataArg ? path.resolve(dataArg.slice(7)) : path.join(root, 'data');
const pfx = path.join(dataDir, 'tls', 'unc.box.pfx');

if (process.platform !== 'win32') {
  console.log('unc.box setup is for Windows. Uncbox works as is at http://localhost:5170.');
  process.exit(1);
}

const script = path.join(root, 'scripts', 'setup-domain.ps1');
const inner = `-NoProfile -ExecutionPolicy Bypass -File "${script}" -DataDir "${dataDir}"${remove ? ' -Remove' : ''}`;
// Start-Process -Verb RunAs is what brings up Windows' "allow this app to make changes" prompt.
const command = `Start-Process powershell -Verb RunAs -Wait -ArgumentList '${inner.replace(/'/g, "''")}'`;

console.log(remove ? 'Removing unc.box. Windows will ask for permission.' : 'Setting up unc.box. Windows will ask for permission.');
const result = spawnSync('powershell', ['-NoProfile', '-Command', command], { stdio: 'inherit' });

if (result.status !== 0) {
  console.log('Cancelled. Nothing was changed.');
  process.exit(1);
}
if (remove) {
  console.log(existsSync(pfx) ? 'unc.box could not be fully removed.' : 'unc.box removed. Uncbox is back to http://localhost:5170 only.');
} else if (existsSync(pfx)) {
  console.log('Done. Restart Uncbox (npm start), then open https://unc.box');
} else {
  console.log('unc.box was not set up. The window that opened says why.');
  process.exit(1);
}
