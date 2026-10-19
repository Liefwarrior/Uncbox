// The certificate behind https://unc.box. `npm run setup-domain` creates it (see
// scripts/setup-domain.ps1) and has Windows trust it; this only reads it back.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DOMAIN = 'unc.box';

/** { pfx, passphrase } once setup-domain has run, otherwise null. */
export async function loadTls(dataDir) {
  const dir = path.join(dataDir, 'tls');
  try {
    const [pfx, info] = await Promise.all([
      readFile(path.join(dir, `${DOMAIN}.pfx`)),
      readFile(path.join(dir, `${DOMAIN}.json`), 'utf8'),
    ]);
    // PowerShell may write a byte order mark before the JSON.
    const { passphrase } = JSON.parse(info.replace(/^﻿/, ''));
    return { pfx, passphrase: String(passphrase ?? '') };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
