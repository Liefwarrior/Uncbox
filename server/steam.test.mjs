import { describe, expect, it } from 'vitest';
import { achievements, parseBinaryVdf, parseVdf } from './steam.mjs';
import { appName, toastTexts } from './widgets.mjs';

/** Builds Valve binary KeyValues from a plain object, the way Steam writes its stats files. */
function binaryVdf(obj) {
  const parts = [];
  const str = (s) => parts.push(Buffer.from(`${s}\0`, 'utf8'));
  const walk = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'object') {
        parts.push(Buffer.from([0]));
        str(k);
        walk(v);
      } else if (typeof v === 'number') {
        parts.push(Buffer.from([2]));
        str(k);
        const b = Buffer.alloc(4);
        b.writeInt32LE(v);
        parts.push(b);
      } else {
        parts.push(Buffer.from([1]));
        str(k);
        str(v);
      }
    }
    parts.push(Buffer.from([8]));
  };
  walk(obj);
  return Buffer.concat(parts);
}

describe('steam', () => {
  it('reads text KeyValues', () => {
    const vdf = `"users"\n{\n\t"7656119"\n\t{\n\t\t"PersonaName"\t\t"Lief \\"W\\""\n\t\t"MostRecent"\t\t"1"\n\t}\n}`;
    expect(parseVdf(vdf)).toEqual({ users: { 7656119: { PersonaName: 'Lief "W"', MostRecent: '1' } } });
  });

  it('counts achievements and finds the latest from the binary stats files', () => {
    const schema = binaryVdf({
      1245620: {
        stats: {
          1: {
            bits: {
              0: { name: 'ACH0', display: { name: { english: 'First' }, desc: { english: 'Do a thing' }, icon: 'a.jpg' } },
              1: { name: 'ACH1', display: { name: { english: 'Second' }, icon: 'b.jpg' } },
              2: { name: 'ACH2', display: { name: { english: 'Third' } } },
            },
          },
          9: { name: 'kills' },
        },
      },
    });
    const mine = binaryVdf({ cache: { 1: { data: 0b011, AchievementTimes: { 0: 1000, 1: 2000 } } } });
    const a = achievements(parseBinaryVdf(schema), parseBinaryVdf(mine));
    expect(a).toMatchObject({ unlocked: 2, total: 3, latest: { name: 'Second', icon: 'b.jpg', at: 2_000_000 } });
    expect(achievements(parseBinaryVdf(schema), parseBinaryVdf(Buffer.from([8])))).toMatchObject({ unlocked: 0, total: 3, latest: null });
  });
});

describe('notifications', () => {
  it('reads a toast and names its app', () => {
    const xml = '<toast><visual><binding template="ToastGeneric"><text>Liefwarrior</text><text>gg &amp; &lt;3</text></binding></visual></toast>';
    expect(toastTexts(xml)).toEqual(['Liefwarrior', 'gg & <3']);
    expect(appName('com.squirrel.Discord.Discord')).toBe('Discord');
    expect(appName('Microsoft.ScreenSketch_8wekyb3d8bbwe!App')).toBe('ScreenSketch');
    expect(appName('Spotify.exe')).toBe('Spotify');
  });
});

describe('game settings', () => {
  it('switches an Unreal game to windowed fullscreen and leaves the rest', async () => {
    const { windowedFullscreen } = await import('./gamesettings.mjs');
    const ini = '[/Script/Engine.GameUserSettings]\nbUseVSync=False\nFullscreenMode=0\nLastConfirmedFullscreenMode=2\nPreferredFullscreenMode=0\nVersion=5\n';
    expect(windowedFullscreen(ini, ['FullscreenMode', 'LastConfirmedFullscreenMode', 'PreferredFullscreenMode'])).toBe(
      '[/Script/Engine.GameUserSettings]\nbUseVSync=False\nFullscreenMode=1\nLastConfirmedFullscreenMode=1\nPreferredFullscreenMode=1\nVersion=5\n',
    );
  });
});

describe('start games windowed', () => {
  const vdf = [
    '"UserLocalConfigStore"',
    '{',
    '\t"Software"',
    '\t{',
    '\t\t"Valve"',
    '\t\t{',
    '\t\t\t"Steam"',
    '\t\t\t{',
    '\t\t\t\t"apps"',
    '\t\t\t\t{',
    '\t\t\t\t\t"220"',
    '\t\t\t\t\t{',
    '\t\t\t\t\t\t"LastPlayed"\t\t"1468965923"',
    '\t\t\t\t\t}',
    '\t\t\t\t\t"440"',
    '\t\t\t\t\t{',
    '\t\t\t\t\t\t"LaunchOptions"\t\t"-dx11"',
    '\t\t\t\t\t}',
    '\t\t\t\t}',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}',
    '',
  ].join('\n');

  it('adds, keeps and removes launch options without touching the rest', async () => {
    const { launchOptions, withLaunchOptions } = await import('./steamwindowed.mjs');
    expect(launchOptions(vdf)).toEqual(new Map([['440', '-dx11']]));
    const on = withLaunchOptions(vdf, new Map([['220', '-screen-fullscreen 0 -popupwindow'], ['999', '--windowed']]));
    expect(launchOptions(on)).toEqual(
      new Map([['220', '-screen-fullscreen 0 -popupwindow'], ['440', '-dx11'], ['999', '--windowed']]),
    );
    expect(on).toContain('\t\t\t\t\t"220"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\t\t"1468965923"\n\t\t\t\t\t\t"LaunchOptions"\t\t"-screen-fullscreen 0 -popupwindow"\n\t\t\t\t\t}');
    const off = withLaunchOptions(on, new Map([['220', null], ['999', null]]));
    expect(launchOptions(off)).toEqual(new Map([['440', '-dx11']]));
    // The empty block for the never-played game stays; Steam doesn't mind it.
    expect(off.replace('\t\t\t\t\t"999"\n\t\t\t\t\t{\n\t\t\t\t\t}\n', '')).toBe(vdf);
  });

  it('knows a Unity game by its files', async () => {
    const { engineOption } = await import('./steamwindowed.mjs');
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-game-'));
    expect(await engineOption(dir)).toBe('');
    await writeFile(path.join(dir, 'UnityPlayer.dll'), '');
    expect(await engineOption(dir)).toBe('-screen-fullscreen 0 -popupwindow');
    await rm(dir, { recursive: true, force: true });
  });
});
