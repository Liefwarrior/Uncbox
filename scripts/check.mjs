// Everything to run before a commit: types, a syntax check of every server file (Vite never sees
// those, and a broken one has shipped before), the tests, and a production build. Server files
// are the .mjs files in server/, scripts/ and anywhere under integrations/.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows needs a shell to find npx.cmd, but node itself runs without one (its path has spaces).
const run = (cmd, args, shell = false) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell });
const npx = (...args) => run('npx', ['--no-install', ...args], process.platform === 'win32');

npx('tsc', '--noEmit');
const serverFiles = [
  ...['server', 'scripts'].flatMap((dir) => readdirSync(path.join(root, dir)).map((f) => path.join(dir, f))),
  ...readdirSync(path.join(root, 'integrations'), { recursive: true }).map((f) => path.join('integrations', f)),
];
for (const f of serverFiles.filter((f) => f.endsWith('.mjs'))) run(process.execPath, ['--check', f]);
console.log('Server files: syntax OK');
// The preset gallery's files: quick, and it catches a bad index or preset before it is merged.
run(process.execPath, ['scripts/gallery.mjs']);
npx('vitest', 'run');
npx('vite', 'build');
