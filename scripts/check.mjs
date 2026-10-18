// Everything to run before a commit: types, a syntax check of every server file (Vite never sees
// those, and a broken one has shipped before), the tests, and a production build.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
const npx = (...args) => run('npx', ['--no-install', ...args]);

npx('tsc', '--noEmit');
for (const dir of ['server', 'scripts']) {
  for (const f of readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.mjs'))) {
    run(process.execPath, ['--check', path.join(dir, f)]);
  }
}
console.log('Server files: syntax OK');
npx('vitest', 'run');
npx('vite', 'build');
