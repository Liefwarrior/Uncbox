// Opens a page in the user's default browser. Used when a setup step needs them on an external
// site (e.g. the Discord Developer Portal), so Uncbox takes them straight there instead of
// describing where to click. Only fixed, known URLs are ever opened.

import { spawn } from 'node:child_process';

export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? // Avoids cmd.exe's quoting rules entirely.
        ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

const DISCORD_ID = /^\d{15,22}$/;

/** Resolves a named destination to its URL, or null if unknown. */
export function pageFor(target, { discordAppId } = {}) {
  switch (target) {
    case 'discord-portal':
      return 'https://discord.com/developers/applications';
    case 'discord-oauth':
      return DISCORD_ID.test(discordAppId ?? '')
        ? `https://discord.com/developers/applications/${discordAppId}/oauth2`
        : 'https://discord.com/developers/applications';
    default:
      return null;
  }
}
