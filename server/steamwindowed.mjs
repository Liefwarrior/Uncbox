// "Start games windowed": gives every installed Steam game the launch option that makes it start in
// a window, so Play here can size it into the game panel (and the mouse works there). Steam has no
// setting for all games, and each engine has its own option, so the engine is read off each game's
// files. Games you set launch options for yourself are left alone, and what Uncbox added is
// remembered so turning it off removes exactly that.
//
// Steam reads launch options when it starts and writes its settings back while it runs, so the
// change is made with Steam closed: Uncbox closes it, edits userdata/<you>/config/localconfig.vdf,
// and starts it again (in Big Picture if that's where you were).

import { execFile, spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The option that starts a game in a window, from its engine, or '' if Uncbox doesn't know it. */
export async function engineOption(dir) {
  const has = (p) => stat(path.join(dir, p)).then(() => true, () => false);
  const files = await readdir(dir).catch(() => []);
  // Unity: windowed, without a border (plain -window-mode borderless is still full screen).
  if (await has('UnityPlayer.dll')) return '-screen-fullscreen 0 -popupwindow';
  // Unreal: the Engine folder sits next to the game's own.
  if (await has(path.join('Engine', 'Binaries'))) return '-windowed';
  // Source and Source 2 (Valve's games).
  if ((await has('hl2.exe')) || (await has(path.join('game', 'bin')))) return '-windowed -noborder';
  // Godot keeps its game in a .pck next to the exe.
  if (files.some((f) => f.toLowerCase().endsWith('.pck'))) return '--windowed';
  return '';
}

const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Where each game's settings block is in localconfig.vdf's apps list, and its launch options:
 * { appsClose, indent, games: Map(appid → { close, options: { start, end, value } | null }) }.
 * Positions are offsets in the text, so edits keep everything else exactly as Steam wrote it.
 */
function locate(text) {
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  const stack = [];
  let key = null;
  let apps = null;
  const games = new Map();
  for (let m; (m = re.exec(text)); ) {
    if (m[2] === '{') {
      stack.push({ key: key ?? '', open: m.index });
      key = null;
      continue;
    }
    if (m[2] === '}') {
      const done = stack.pop();
      const names = stack.map((s) => s.key.toLowerCase());
      if (done && names.join('/') === 'userlocalconfigstore/software/valve/steam' && done.key.toLowerCase() === 'apps') {
        apps = { close: m.index };
      }
      if (done && names.join('/') === 'userlocalconfigstore/software/valve/steam/apps') {
        const g = games.get(done.key) ?? { options: null };
        games.set(done.key, { ...g, close: m.index });
      }
      key = null;
      continue;
    }
    if (key === null) {
      key = m[1];
      continue;
    }
    const names = stack.map((s) => s.key.toLowerCase());
    if (names.slice(0, 5).join('/') === 'userlocalconfigstore/software/valve/steam/apps' && names.length === 6 && key === 'LaunchOptions') {
      const appid = stack[5].key;
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const lineEnd = text.indexOf('\n', m.index);
      games.set(appid, { ...(games.get(appid) ?? {}), options: { start: lineStart, end: lineEnd + 1, value: m[1].replace(/\\(.)/g, '$1') } });
    }
    key = null;
  }
  if (!apps) return null;
  const lineStart = text.lastIndexOf('\n', apps.close) + 1;
  return { appsClose: apps.close, indent: text.slice(lineStart, apps.close), games };
}

/** The launch options set for each game: Map(appid → value). Exported for tests. */
export function launchOptions(text) {
  const where = locate(text);
  return new Map([...(where?.games ?? [])].filter(([, g]) => g.options).map(([id, g]) => [id, g.options.value]));
}

/**
 * localconfig.vdf with these games' launch options set (a string) or removed (null). Exported
 * for tests.
 */
export function withLaunchOptions(text, changes) {
  const where = locate(text);
  if (!where) throw new Error('Steam’s settings file isn’t in the shape Uncbox expects.');
  const edits = [];
  const inner = `${where.indent}\t`;
  for (const [appid, value] of changes) {
    const game = where.games.get(appid);
    const line = value === null ? '' : `${inner}\t"LaunchOptions"\t\t${quote(value)}\n`;
    if (game?.options) edits.push({ at: game.options.start, end: game.options.end, text: line });
    else if (value === null) continue;
    else if (game?.close !== undefined) {
      const at = text.lastIndexOf('\n', game.close) + 1;
      edits.push({ at, end: at, text: line });
    } else {
      // Never played, so no block yet: add one at the end of the list.
      const at = text.lastIndexOf('\n', where.appsClose) + 1;
      edits.push({ at, end: at, text: `${inner}${quote(appid)}\n${inner}{\n${line}${inner}}\n` });
    }
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return out;
}

const tasks = (args) =>
  new Promise((resolve) => {
    execFile('tasklist', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out));
  });
const steamRunning = async () => /"steam\.exe"/i.test(await tasks(['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq steam.exe']));
const bigPictureOpen = async () => /Steam Big Picture Mode/.test(await tasks(['/V', '/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq steamwebhelper.exe']));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Turns "start games windowed" on or off. steam is { root, account, installed() → [{ appid, name,
 * dir }], playing() → appid or 0 }; record is where what Uncbox added is kept.
 */
export function createSteamWindowed({ steam, record }) {
  const load = async () => JSON.parse(await readFile(record, 'utf8').catch(() => '{"apps":{}}'));
  const configFile = () => path.join(steam.root(), 'userdata', steam.account(), 'config', 'localconfig.vdf');

  async function status() {
    const added = (await load()).apps ?? {};
    return { on: Object.keys(added).length > 0, games: Object.keys(added).length };
  }

  /** Closes Steam, runs edit on its settings, and starts it again where it was. */
  async function withSteamClosed(edit) {
    if (await steam.playing()) throw Object.assign(new Error('Close your game first: Steam has to restart for this.'), { status: 409 });
    const wasRunning = await steamRunning();
    const wasBigPicture = wasRunning && (await bigPictureOpen());
    const exe = path.join(steam.root(), 'steam.exe');
    if (wasRunning) {
      spawn(exe, ['-shutdown'], { detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 60 && (await steamRunning()); i++) await sleep(500);
      if (await steamRunning()) throw Object.assign(new Error('Steam didn’t close. Close it and try again.'), { status: 409 });
      // Steam finishes writing its settings just before it exits.
      await sleep(1000);
    }
    try {
      await edit();
    } finally {
      if (wasRunning) spawn(exe, wasBigPicture ? ['-gamepadui'] : [], { detached: true, stdio: 'ignore' }).unref();
    }
  }

  async function turnOn() {
    const added = {};
    await withSteamClosed(async () => {
      const text = await readFile(configFile(), 'utf8');
      const mine = launchOptions(text);
      const changes = new Map();
      for (const game of await steam.installed()) {
        // Your own launch options win.
        if (mine.get(String(game.appid))) continue;
        const option = await engineOption(game.dir);
        if (!option) continue;
        changes.set(String(game.appid), option);
        added[game.appid] = option;
      }
      await writeFile(configFile(), withLaunchOptions(text, changes));
      await writeFile(record, JSON.stringify({ apps: added }, null, 2));
    });
    return { on: true, games: Object.keys(added).length };
  }

  async function turnOff() {
    const added = (await load()).apps ?? {};
    await withSteamClosed(async () => {
      const text = await readFile(configFile(), 'utf8');
      const now = launchOptions(text);
      // Only what's still exactly as Uncbox set it; anything you've changed since stays.
      const changes = new Map(Object.entries(added).filter(([id, option]) => now.get(id) === option).map(([id]) => [id, null]));
      await writeFile(configFile(), withLaunchOptions(text, changes));
      await writeFile(record, JSON.stringify({ apps: {} }, null, 2));
    });
    return { on: false, games: 0 };
  }

  return { status, turnOn, turnOff };
}
