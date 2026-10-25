import { describe, expect, it } from 'vitest';
import { contrast, over, parseColor, readThemes } from '../../contrast';
import { WOW_CLASSES } from '../../presets';
import { CLASS_NAMES, classColor, classKey, classLabel, readableOnDark } from './classColor';
import { QUALITIES, qualityColor, qualityName } from './quality';

// Read from disk: vitest hands CSS imports back empty. Node's types aren't installed here.
// @ts-expect-error node:fs only exists in the test runner
const { readFileSync } = (await import('node:fs')) as { readFileSync: (path: string, encoding: string) => string };
declare const process: { cwd(): string };
const themes = readThemes(readFileSync(`${process.cwd()}/src/styles.css`, 'utf8'));

describe('class names', () => {
  it('knows a class however the game spells it', () => {
    expect(classKey('DRUID')).toBe('Druid');
    expect(classKey('druid')).toBe('Druid');
    expect(classKey(' Druid ')).toBe('Druid');
    expect(classKey('Death Knight')).toBe('');
    expect(classKey(undefined)).toBe('');
    expect(classLabel('SHAMAN')).toBe('Shaman');
  });

  it('lists the nine classes', () => {
    expect(CLASS_NAMES).toHaveLength(9);
  });
});

describe('class colors', () => {
  it('uses the official color where it reads, and the text color for an unknown class', () => {
    expect(classColor('Druid')).toBe(WOW_CLASSES.Druid.toLowerCase());
    expect(classColor('')).toBe('var(--text)');
    expect(classColor('Gnome')).toBe('var(--text)');
  });

  it('lightens the one that is too dark (the Shaman’s blue) and keeps it blue', () => {
    const shaman = parseColor(classColor('Shaman'))!.rgb;
    expect(shaman[2]).toBeGreaterThan(shaman[0]);
    expect(classColor('Shaman')).not.toBe(WOW_CLASSES.Shaman.toLowerCase());
  });

  it('readableOnDark leaves a color that already reads alone', () => {
    expect(readableOnDark('#ffffff')).toBe('#ffffff');
    expect(readableOnDark('not a color')).toBe('not a color');
  });

  for (const [name, t] of Object.entries(themes)) {
    it(`every class reads at 4.5:1 on the page, panel and inset of the ${name} theme`, () => {
      const bg = parseColor(t['--bg'])!.rgb;
      const panel = over(parseColor(t['--panel'])!, bg);
      const inset = parseColor(t['--panel-2'])!.rgb;
      for (const cls of CLASS_NAMES) {
        const rgb = parseColor(classColor(cls))!.rgb;
        for (const [what, under] of [['page', bg], ['panel', panel], ['inset', inset]] as const) {
          expect(contrast(rgb, under), `${cls} on ${what}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`every item quality reads on the ${name} theme’s panels`, () => {
      const bg = parseColor(t['--bg'])!.rgb;
      const panel = over(parseColor(t['--panel'])!, bg);
      const inset = parseColor(t['--panel-2'])!.rgb;
      for (const q of QUALITIES) {
        const rgb = parseColor(qualityColor(q.id))!.rgb;
        expect(contrast(rgb, panel), `${q.name} on panel`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(rgb, inset), `${q.name} on inset`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe('item quality', () => {
  it('names the qualities, and calls an unknown one common', () => {
    expect(qualityName(4)).toBe('Epic');
    expect(qualityName(99)).toBe('Common');
  });
});
