// Writes THIRD_PARTY_NOTICES.md: the license of every package that ships with Uncbox
// (production dependencies and everything they pull in, plus the native shell's NuGet packages,
// listed by hand in SHELL_PACKAGES below). Run with `npm run notices` after adding or updating
// a dependency, and keep SHELL_PACKAGES in step with native/UncboxShell/UncboxShell.csproj.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = ['ls', '--omit=dev', '--all', '--parseable'];
// Under `npm run`, npm_execpath points at npm's own script, so no shell is needed.
const out = process.env.npm_execpath
  ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, encoding: 'utf8' })
  : execFileSync('npm', args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
const dirs = [...new Set(out.split(/\r?\n/).filter((d) => d && path.resolve(d) !== root))];

const LICENSE_FILE = /^(licen[cs]e|copying|ofl)(\.(md|txt))?$/i;

const NAUDIO_LICENSE = `MIT License

Copyright 2020 Mark Heath

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

// The native shell's NuGet packages (native/UncboxShell/UncboxShell.csproj). They aren't in
// node_modules, so their licenses are kept here.
const SHELL_PACKAGES = [
  {
    name: 'Microsoft.Web.WebView2',
    version: '1.0.4191.47',
    license: 'BSD-3-Clause',
    repo: 'https://aka.ms/webview',
    text: `Copyright (C) Microsoft Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * The name of Microsoft Corporation, or the names of its contributors 
may not be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  },
  {
    name: 'NAudio.Core',
    version: '2.2.1',
    license: 'MIT',
    repo: 'https://github.com/naudio/NAudio',
    text: NAUDIO_LICENSE,
  },
  {
    name: 'NAudio.Wasapi',
    version: '2.2.1',
    license: 'MIT',
    repo: 'https://github.com/naudio/NAudio',
    text: NAUDIO_LICENSE,
  },
];

const packages = [
  ...dirs
  .map((dir) => {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
    const text = file ? readFileSync(path.join(dir, file), 'utf8').trim() : '';
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || 'UNKNOWN';
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    return { name: pkg.name, version: pkg.version, license, repo, text };
  }),
  ...SHELL_PACKAGES,
]
  .sort((a, b) => a.name.localeCompare(b.name));

const missing = packages.filter((p) => !p.text);
const lines = [
  '# Third-party notices',
  '',
  'Uncbox includes the following open-source software. Each is used under the license shown,',
  'and its full license text is reproduced below as those licenses require.',
  '',
  'Generated by `npm run notices`. Do not edit by hand.',
  '',
  '| Package | Version | License |',
  '| --- | --- | --- |',
  ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  '',
];
for (const p of packages) {
  lines.push(`## ${p.name} ${p.version}`, '');
  lines.push(`License: ${p.license}${p.repo ? `  \nSource: ${p.repo.replace(/^git\+/, '')}` : ''}`, '');
  lines.push(p.text ? '```text\n' + p.text + '\n```' : '_No license file was included in the package._', '');
}
writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), lines.join('\n'));

console.log(`Wrote THIRD_PARTY_NOTICES.md (${packages.length} packages).`);
if (missing.length) console.warn(`No license file in: ${missing.map((p) => p.name).join(', ')}`);
if (!existsSync(path.join(root, 'dist'))) console.warn('Note: run a build before release so dist/ matches.');
