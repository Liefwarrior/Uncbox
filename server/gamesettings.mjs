// Puts known games in windowed fullscreen, so Play here can move them into the game panel (it
// can't move exclusive full screen). Each game's own settings file is edited, only while the game
// is closed, since it writes the file back when it exits.
//
//   POST /api/game-settings  { preset } → { changed } (409 while the game is running)

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UE_WINDOWED_FULLSCREEN = '1';
const GAMES = {
  // Unreal Engine: [/Script/Engine.GameUserSettings] FullscreenMode, 0 full screen, 1 windowed fullscreen, 2 windowed.
  mcd2: {
    exe: 'dungeons.exe',
    file: () => path.join(process.env.LOCALAPPDATA ?? '', 'Dungeons2', 'Saved', 'Config', 'WinGDK', 'GameUserSettings.ini'),
    keys: ['FullscreenMode', 'LastConfirmedFullscreenMode', 'PreferredFullscreenMode'],
  },
};

/** Sets the keys to windowed fullscreen in an Unreal GameUserSettings.ini. Exported for tests. */
export function windowedFullscreen(ini, keys) {
  let out = ini;
  for (const key of keys) out = out.replace(new RegExp(`^(${key}=)\\d+`, 'm'), `$1${UE_WINDOWED_FULLSCREEN}`);
  return out;
}

function isRunning(exe) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) =>
      resolve(!err && out.toLowerCase().includes(`"${exe}"`)),
    );
  });
}

export function createGameSettings({ isLocal, sendJson, readJson }) {
  return async function handle(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!isLocal(req)) return sendJson(res, 403, { error: 'This PC only' });
    const { preset } = await readJson(req).catch(() => ({}));
    const game = GAMES[preset];
    if (!game) return sendJson(res, 200, { changed: false });
    if (await isRunning(game.exe)) return sendJson(res, 409, { error: 'Close the game first.' });
    const file = game.file();
    const ini = await readFile(file, 'utf8').catch(() => null);
    // No settings file yet: the game makes one on first start, and it's handled next time.
    if (ini === null) return sendJson(res, 200, { changed: false });
    const next = windowedFullscreen(ini, game.keys);
    if (next !== ini) await writeFile(file, next);
    return sendJson(res, 200, { changed: next !== ini });
  };
}
