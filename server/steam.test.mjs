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
